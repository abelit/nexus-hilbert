package file

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	filemodel "github.com/ongridio/ongrid/internal/cmdb/model/file"
	"github.com/ongridio/ongrid/internal/pkg/errs"
	"github.com/ongridio/ongrid/internal/pkg/objectstore"
	"github.com/ongridio/ongrid/internal/pkg/secretbox"
)

// Repo is the persistence port consumed by this package. It is declared here
// (the consumer) so the data layer and tests can provide it without importing
// implementation details.
type Repo interface {
	GetSetting(ctx context.Context, kind string) (*filemodel.Setting, error)
	SetSetting(ctx context.Context, kind, value string) error
	CreateFile(ctx context.Context, row *filemodel.File) error
	GetFile(ctx context.Context, fileID string) (*filemodel.File, error)
	DeleteFile(ctx context.Context, fileID string) error
}

// FileInput is one browser upload. Size is the multipart header size; the
// handler has already bounded the request, and the usecase enforces the
// configured per-file limit before reading the body.
type FileInput struct {
	Name        string
	Size        int64
	ContentType string
	// Reader must be rewindable: the usecase sniffs the MIME prefix, hashes
	// the object, and then hands the same stream to the storage backend. S3
	// SigV4 also hashes and rewinds the body on HTTP endpoints.
	Reader io.ReadSeeker
}

// FileDTO is the value stored in a CMDB file attribute and returned by upload.
type FileDTO struct {
	FileID         string `json:"file_id"`
	OriginalName   string `json:"original_name"`
	StoredPath     string `json:"stored_path"`
	Size           int64  `json:"size"`
	MimeType       string `json:"mime_type"`
	StorageBackend string `json:"storage_backend"`
}

// Usecase owns storage configuration, uploads and the short-lived preview
// capability. It does not know about CI attributes; callers decide when to
// write a returned FileDTO into a value row.
type Usecase struct {
	repo       Repo
	opts       Options
	defaults   StorageConfig
	previewDef PreviewConfig
	now        func() time.Time
	httpClient *http.Client
}

// NewUsecase builds the usecase. A nil repo is reported lazily by the methods
// that need it, matching the rest of CMDB's NotWiredYet convention.
func NewUsecase(repo Repo, opts Options) *Usecase {
	return &Usecase{
		repo:       repo,
		opts:       opts,
		defaults:   defaultStorage(opts),
		previewDef: defaultPreview(opts),
		now:        time.Now,
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
}

// Storage returns the effective storage configuration with the secret masked.
func (u *Usecase) Storage(ctx context.Context) (StorageConfig, error) {
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return StorageConfig{}, err
	}
	return publicStorage(cfg), nil
}

// Preview returns the preview configuration. It has no secrets.
func (u *Usecase) Preview(ctx context.Context) (PreviewConfig, error) {
	cfg, err := u.resolvePreview(ctx)
	if err != nil {
		return PreviewConfig{}, err
	}
	return cfg, nil
}

// UpdateStorage merges a partial update over the effective configuration and
// persists the encrypted document. The merge starts from the effective config,
// so an environment-provided value is not silently reset to a code default.
func (u *Usecase) UpdateStorage(ctx context.Context, patch StoragePatch) (StorageConfig, error) {
	if u.repo == nil {
		return StorageConfig{}, errs.ErrNotWiredYet
	}
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return StorageConfig{}, err
	}
	applyStoragePatch(&cfg, patch)
	cfg.StorageBackend = strings.ToLower(strings.TrimSpace(cfg.StorageBackend))
	cfg.LocalPath = strings.TrimSpace(cfg.LocalPath)
	cfg.S3EndpointURL = strings.TrimSpace(cfg.S3EndpointURL)
	cfg.S3AccessKey = strings.TrimSpace(cfg.S3AccessKey)
	cfg.S3SecretKey = strings.TrimSpace(cfg.S3SecretKey)
	cfg.S3BucketName = strings.TrimSpace(cfg.S3BucketName)
	cfg.S3Region = strings.TrimSpace(cfg.S3Region)
	cfg.AllowedExtensions = normalizeExtensions(cfg.AllowedExtensions)
	if err := cfg.validate(); err != nil {
		return StorageConfig{}, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	if err := u.saveSetting(ctx, filemodel.KindStorage, cfg); err != nil {
		return StorageConfig{}, err
	}
	return publicStorage(cfg), nil
}

// TestStorage validates the posted draft against the same backend builder an
// upload uses. A failed connection is a test result, not an HTTP error, so the
// UI can show the endpoint's own message.
func (u *Usecase) TestStorage(ctx context.Context, patch StoragePatch) TestResult {
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	applyStoragePatch(&cfg, patch)
	normalizeStorage(&cfg)
	if err := cfg.validate(); err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	backend, err := u.backend(cfg)
	if err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := backend.Health(checkCtx); err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	return TestResult{OK: true}
}

// UpdatePreview merges and persists the preview configuration.
func (u *Usecase) UpdatePreview(ctx context.Context, patch PreviewPatch) (PreviewConfig, error) {
	if u.repo == nil {
		return PreviewConfig{}, errs.ErrNotWiredYet
	}
	cfg, err := u.resolvePreview(ctx)
	if err != nil {
		return PreviewConfig{}, err
	}
	if patch.PreviewServerURL != nil {
		cfg.PreviewServerURL = strings.TrimSpace(*patch.PreviewServerURL)
	}
	if patch.FileFetchBaseURL != nil {
		cfg.FileFetchBaseURL = normalizeBaseURL(*patch.FileFetchBaseURL)
	}
	if patch.ForceUpdatedCacheTypes != nil {
		cfg.ForceUpdatedCacheTypes = normalizeExtensions(*patch.ForceUpdatedCacheTypes)
	}
	if err := validatePreview(cfg); err != nil {
		return PreviewConfig{}, fmt.Errorf("%w: %v", errs.ErrInvalid, err)
	}
	if err := u.saveSetting(ctx, filemodel.KindPreview, cfg); err != nil {
		return PreviewConfig{}, err
	}
	return cfg, nil
}

// TestPreview probes the kkFileView root rather than /onlinePreview, which
// returns 4xx without a file parameter even when the server is healthy.
func (u *Usecase) TestPreview(ctx context.Context, rawURL string) TestResult {
	target := strings.TrimSpace(rawURL)
	if target == "" {
		cfg, err := u.resolvePreview(ctx)
		if err != nil {
			return TestResult{OK: false, Error: err.Error()}
		}
		target = cfg.PreviewServerURL
	}
	internal := strings.TrimRight(strings.TrimSpace(u.opts.PreviewInternalURL), "/")
	if strings.HasPrefix(target, "/") {
		if internal == "" {
			return TestResult{OK: false, Error: "the preview service is proxied; set ONGRID_CMDB_FILE_PREVIEW_INTERNAL_URL to test it"}
		}
		target = internal + target
	} else if internal != "" {
		// A browser-facing URL behind the same nginx proxy has an internal
		// equivalent; probe that instead of depending on public DNS/TLS from
		// inside the CMDB container.
		if idx := strings.Index(target, "/file-preview/"); idx >= 0 {
			target = internal + target[idx:]
		}
	}
	base := strings.TrimSpace(strings.SplitN(target, "?", 2)[0])
	base = strings.TrimRight(base, "/")
	for _, suffix := range []string{"/onlinePreview", "/online"} {
		if strings.HasSuffix(base, suffix) {
			base = strings.TrimSuffix(base, suffix)
			break
		}
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "http://" + base
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(checkCtx, http.MethodGet, base, nil)
	if err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	resp, err := u.httpClient.Do(req)
	if err != nil {
		return TestResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 500 {
		return TestResult{OK: false, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	return TestResult{OK: true}
}

// Upload validates and stores files sequentially. If one file fails, objects
// already written by this request are removed, so a partial multipart upload
// does not leave invisible attachments behind.
func (u *Usecase) Upload(ctx context.Context, callerID uint64, _ string, inputs []FileInput) ([]FileDTO, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	if len(inputs) == 0 {
		return nil, fmt.Errorf("%w: at least one file is required", errs.ErrInvalid)
	}
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return nil, err
	}
	backend, err := u.backend(cfg)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(cfg.AllowedExtensions))
	for _, ext := range cfg.AllowedExtensions {
		allowed[ext] = true
	}
	maxBytes := int64(cfg.MaxFileSizeMB) << 20

	out := make([]FileDTO, 0, len(inputs))
	cleanup := func() {
		for _, item := range out {
			_ = backend.Delete(context.Background(), item.StoredPath)
			_ = u.repo.DeleteFile(context.Background(), item.FileID)
		}
	}
	for _, input := range inputs {
		if input.Size < 0 {
			cleanup()
			return nil, fmt.Errorf("%w: invalid file size", errs.ErrInvalid)
		}
		if input.Size > maxBytes {
			cleanup()
			return nil, fmt.Errorf("%w: %s exceeds the %d MB limit", errs.ErrInvalid, input.Name, cfg.MaxFileSizeMB)
		}
		original := sanitizeFilename(input.Name)
		ext := strings.ToLower(strings.TrimPrefix(path.Ext(original), "."))
		if ext == "" || !allowed[ext] {
			cleanup()
			return nil, fmt.Errorf("%w: file type .%s is not allowed", errs.ErrInvalid, ext)
		}
		head := make([]byte, 512)
		n, readErr := io.ReadFull(input.Reader, head)
		if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
			cleanup()
			return nil, fmt.Errorf("read upload %s: %w", original, readErr)
		}
		head = head[:n]
		mimeType := detectMime(original, input.ContentType, head)
		if _, err := input.Reader.Seek(0, io.SeekStart); err != nil {
			cleanup()
			return nil, fmt.Errorf("rewind upload %s: %w", original, err)
		}
		fileID, err := newFileID()
		if err != nil {
			cleanup()
			return nil, err
		}
		key := u.now().UTC().Format("2006/01/02") + "/" + fileID + "_" + original
		// Hash in its own pass instead of wrapping the body in io.TeeReader:
		// the S3 signer needs the original seekable reader to rewind after its
		// own payload hash, and a TeeReader would hide Seek.
		hasher := sha256.New()
		if _, err := io.Copy(hasher, input.Reader); err != nil {
			cleanup()
			return nil, fmt.Errorf("hash upload %s: %w", original, err)
		}
		if _, err := input.Reader.Seek(0, io.SeekStart); err != nil {
			cleanup()
			return nil, fmt.Errorf("rewind upload %s: %w", original, err)
		}
		if _, err := backend.Put(ctx, key, input.Reader, input.Size, mimeType); err != nil {
			cleanup()
			return nil, err
		}
		row := &filemodel.File{
			FileID:         fileID,
			StoredPath:     key,
			StorageBackend: cfg.StorageBackend,
			OriginalName:   original,
			MimeType:       mimeType,
			Size:           input.Size,
			SHA256:         hex.EncodeToString(hasher.Sum(nil)),
			UploadedBy:     callerID,
		}
		if err := u.repo.CreateFile(ctx, row); err != nil {
			_ = backend.Delete(context.Background(), key)
			cleanup()
			return nil, err
		}
		out = append(out, toDTO(row))
	}
	return out, nil
}

// Open resolves a file id to an object stream. The stored path and backend
// come from the metadata row, never from the request.
func (u *Usecase) Open(ctx context.Context, fileID string) (io.ReadCloser, *filemodel.File, objectstore.Object, error) {
	row, err := u.fileRow(ctx, fileID)
	if err != nil {
		return nil, nil, objectstore.Object{}, err
	}
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return nil, nil, objectstore.Object{}, err
	}
	backend, err := u.backendFor(row.StorageBackend, cfg)
	if err != nil {
		return nil, nil, objectstore.Object{}, err
	}
	reader, object, err := backend.Get(ctx, row.StoredPath)
	if err != nil {
		return nil, nil, objectstore.Object{}, err
	}
	return reader, row, object, nil
}

// DeleteFiles removes objects then their metadata. A missing object still
// removes the metadata row; a metadata row that cannot be removed is kept so a
// retry can finish the job.
func (u *Usecase) DeleteFiles(ctx context.Context, fileIDs []string) (int, error) {
	if u.repo == nil {
		return 0, errs.ErrNotWiredYet
	}
	cfg, err := u.resolveStorage(ctx)
	if err != nil {
		return 0, err
	}
	deleted := 0
	var firstErr error
	for _, fileID := range fileIDs {
		row, err := u.repo.GetFile(ctx, strings.TrimSpace(fileID))
		if err != nil {
			if errors.Is(err, errs.ErrNotFound) {
				continue
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		backend, err := u.backendFor(row.StorageBackend, cfg)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if err := backend.Delete(ctx, row.StoredPath); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if err := u.repo.DeleteFile(ctx, row.FileID); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		deleted++
	}
	return deleted, firstErr
}

// CleanupFileValues is the CI lifecycle hook: it parses stored file-attribute
// JSON and deletes every referenced file. It is deliberately best-effort; the
// caller logs failures and still completes the CI write.
func (u *Usecase) CleanupFileValues(ctx context.Context, values []string) error {
	ids := make([]string, 0)
	for _, raw := range values {
		ids = append(ids, fileIDsFromJSON(raw)...)
	}
	if len(ids) == 0 {
		return nil
	}
	_, err := u.DeleteFiles(ctx, ids)
	return err
}

// CleanupFileValueChange deletes only the files that disappeared from one
// attribute value, so re-saving the same attachment list is not destructive.
func (u *Usecase) CleanupFileValueChange(ctx context.Context, oldValue, newValue string) error {
	oldIDs := fileIDsFromJSON(oldValue)
	if len(oldIDs) == 0 {
		return nil
	}
	newIDs := make(map[string]bool)
	for _, id := range fileIDsFromJSON(newValue) {
		newIDs[id] = true
	}
	removed := make([]string, 0, len(oldIDs))
	for _, id := range oldIDs {
		if !newIDs[id] {
			removed = append(removed, id)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	_, err := u.DeleteFiles(ctx, removed)
	return err
}

func fileIDsFromJSON(raw string) []string {
	var files []FileDTO
	if err := json.Unmarshal([]byte(raw), &files); err != nil {
		return nil
	}
	out := make([]string, 0, len(files))
	seen := make(map[string]bool, len(files))
	for _, item := range files {
		id := strings.TrimSpace(item.FileID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// PreviewLink mints a short-lived capability URL. The URL is relative; the
// browser prefixes it with the admin-configured file access address (or the
// frontend build-time base / browser origin) before handing it to kkFileView.
func (u *Usecase) PreviewLink(ctx context.Context, fileID string, download bool) (string, time.Time, error) {
	if _, err := u.fileRow(ctx, fileID); err != nil {
		return "", time.Time{}, err
	}
	expires := u.now().Add(15 * time.Minute)
	token, err := mintCapability(u.opts.SignerSecret, fileID, download, expires)
	if err != nil {
		return "", time.Time{}, err
	}
	return "/api/v1/cmdb/ci/files/public/" + token, expires, nil
}

// ResolveCapability validates a public capability and returns its binding.
func (u *Usecase) ResolveCapability(token string) (fileID string, download bool, expires time.Time, err error) {
	return verifyCapability(u.opts.SignerSecret, token, u.now())
}

func (u *Usecase) fileRow(ctx context.Context, fileID string) (*filemodel.File, error) {
	if u.repo == nil {
		return nil, errs.ErrNotWiredYet
	}
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return nil, fmt.Errorf("%w: file_id is required", errs.ErrInvalid)
	}
	return u.repo.GetFile(ctx, fileID)
}

func (u *Usecase) resolveStorage(ctx context.Context) (StorageConfig, error) {
	cfg := u.defaults
	if u.repo == nil {
		return cfg, nil
	}
	row, err := u.repo.GetSetting(ctx, filemodel.KindStorage)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			return cfg, nil
		}
		return StorageConfig{}, err
	}
	plain, err := secretbox.Decrypt(row.Value)
	if err != nil {
		return StorageConfig{}, fmt.Errorf("cmdb file: decrypt storage settings: %w", err)
	}
	if err := json.Unmarshal([]byte(plain), &cfg); err != nil {
		return StorageConfig{}, fmt.Errorf("cmdb file: parse storage settings: %w", err)
	}
	normalizeStorage(&cfg)
	if cfg.StorageBackend == "" {
		cfg.StorageBackend = BackendLocal
	}
	if cfg.S3BucketName == "" {
		cfg.S3BucketName = "cmdb-files"
	}
	if cfg.S3Region == "" {
		cfg.S3Region = "us-east-1"
	}
	if len(cfg.AllowedExtensions) == 0 {
		cfg.AllowedExtensions = normalizeExtensions(DefaultAllowedExtensions)
	}
	if cfg.MaxFileSizeMB <= 0 {
		cfg.MaxFileSizeMB = DefaultMaxFileSizeMB
	}
	return cfg, nil
}

func (u *Usecase) resolvePreview(ctx context.Context) (PreviewConfig, error) {
	cfg := u.previewDef
	if u.repo == nil {
		return cfg, nil
	}
	row, err := u.repo.GetSetting(ctx, filemodel.KindPreview)
	if err != nil {
		if errors.Is(err, errs.ErrNotFound) {
			return cfg, nil
		}
		return PreviewConfig{}, err
	}
	plain, err := secretbox.Decrypt(row.Value)
	if err != nil {
		return PreviewConfig{}, fmt.Errorf("cmdb file: decrypt preview settings: %w", err)
	}
	if err := json.Unmarshal([]byte(plain), &cfg); err != nil {
		return PreviewConfig{}, fmt.Errorf("cmdb file: parse preview settings: %w", err)
	}
	cfg.FileFetchBaseURL = normalizeBaseURL(cfg.FileFetchBaseURL)
	cfg.ForceUpdatedCacheTypes = normalizeExtensions(cfg.ForceUpdatedCacheTypes)
	if len(cfg.ForceUpdatedCacheTypes) == 0 {
		cfg.ForceUpdatedCacheTypes = u.previewDef.ForceUpdatedCacheTypes
	}
	return cfg, nil
}

func (u *Usecase) saveSetting(ctx context.Context, kind string, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("cmdb file: marshal %s settings: %w", kind, err)
	}
	encrypted, err := secretbox.Encrypt(string(payload))
	if err != nil {
		return fmt.Errorf("cmdb file: encrypt %s settings: %w", kind, err)
	}
	return u.repo.SetSetting(ctx, kind, encrypted)
}

func (u *Usecase) backend(cfg StorageConfig) (objectstore.Backend, error) {
	return u.backendFor(cfg.StorageBackend, cfg)
}

func (u *Usecase) backendFor(name string, cfg StorageConfig) (objectstore.Backend, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case BackendS3:
		return objectstore.NewS3(objectstore.S3Config{
			Endpoint:  cfg.S3EndpointURL,
			AccessKey: cfg.S3AccessKey,
			SecretKey: cfg.S3SecretKey,
			Bucket:    cfg.S3BucketName,
			Region:    cfg.S3Region,
			UseSSL:    cfg.S3UseSSL,
		})
	case BackendLocal, "":
		return objectstore.NewLocal(cfg.LocalPath)
	default:
		return nil, fmt.Errorf("%w: unknown storage backend %q", errs.ErrInvalid, name)
	}
}

func publicStorage(cfg StorageConfig) StorageConfig {
	out := cfg
	if out.S3SecretKey != "" {
		out.S3SecretKey = MaskedSecret
	}
	return out
}

func applyStoragePatch(cfg *StorageConfig, patch StoragePatch) {
	if patch.StorageBackend != nil {
		cfg.StorageBackend = *patch.StorageBackend
	}
	if patch.LocalPath != nil {
		cfg.LocalPath = *patch.LocalPath
	}
	if patch.S3EndpointURL != nil {
		cfg.S3EndpointURL = *patch.S3EndpointURL
	}
	if patch.S3AccessKey != nil {
		cfg.S3AccessKey = *patch.S3AccessKey
	}
	if patch.S3SecretKey != nil && *patch.S3SecretKey != MaskedSecret {
		cfg.S3SecretKey = *patch.S3SecretKey
	}
	if patch.S3BucketName != nil {
		cfg.S3BucketName = *patch.S3BucketName
	}
	if patch.S3Region != nil {
		cfg.S3Region = *patch.S3Region
	}
	if patch.S3UseSSL != nil {
		cfg.S3UseSSL = *patch.S3UseSSL
	}
	if patch.AllowedExtensions != nil {
		cfg.AllowedExtensions = *patch.AllowedExtensions
	}
	if patch.MaxFileSizeMB != nil {
		cfg.MaxFileSizeMB = *patch.MaxFileSizeMB
	}
}

func normalizeStorage(cfg *StorageConfig) {
	cfg.StorageBackend = strings.ToLower(strings.TrimSpace(cfg.StorageBackend))
	cfg.LocalPath = strings.TrimSpace(cfg.LocalPath)
	cfg.S3EndpointURL = strings.TrimSpace(cfg.S3EndpointURL)
	cfg.S3AccessKey = strings.TrimSpace(cfg.S3AccessKey)
	cfg.S3SecretKey = strings.TrimSpace(cfg.S3SecretKey)
	cfg.S3BucketName = strings.TrimSpace(cfg.S3BucketName)
	cfg.S3Region = strings.TrimSpace(cfg.S3Region)
	cfg.AllowedExtensions = normalizeExtensions(cfg.AllowedExtensions)
}

func toDTO(row *filemodel.File) FileDTO {
	return FileDTO{
		FileID:         row.FileID,
		OriginalName:   row.OriginalName,
		StoredPath:     row.StoredPath,
		Size:           row.Size,
		MimeType:       row.MimeType,
		StorageBackend: row.StorageBackend,
	}
}

func newFileID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("cmdb file: generate id: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == 0x7f:
			return -1
		case strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		default:
			return r
		}
	}, name)
	name = strings.TrimSpace(strings.TrimLeft(name, "."))
	if name == "" {
		name = "file"
	}
	if len(name) > 120 {
		ext := path.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		base := strings.TrimSuffix(name, ext)
		if len(base) > 120-len(ext) {
			base = base[:120-len(ext)]
		}
		name = base + ext
	}
	return name
}

func detectMime(filename, headerType string, head []byte) string {
	detected := strings.ToLower(strings.TrimSpace(http.DetectContentType(head)))
	if i := strings.IndexByte(detected, ';'); i >= 0 {
		detected = strings.TrimSpace(detected[:i])
	}
	byExt := strings.ToLower(strings.TrimSpace(mime.TypeByExtension(path.Ext(filename))))
	if i := strings.IndexByte(byExt, ';'); i >= 0 {
		byExt = strings.TrimSpace(byExt[:i])
	}
	// Office files and PDFs are often sniffed as zip/octet-stream. Trust the
	// extension for those container formats; trust the bytes for images/text.
	switch {
	case strings.HasPrefix(byExt, "application/vnd."),
		byExt == "application/pdf",
		byExt == "application/zip",
		byExt == "application/x-7z-compressed",
		byExt == "application/vnd.rar":
		return byExt
	case detected != "" && detected != "application/octet-stream":
		return detected
	case byExt != "":
		return byExt
	case strings.HasPrefix(strings.ToLower(headerType), "image/"),
		strings.HasPrefix(strings.ToLower(headerType), "text/"):
		return strings.ToLower(strings.TrimSpace(headerType))
	default:
		return "application/octet-stream"
	}
}
