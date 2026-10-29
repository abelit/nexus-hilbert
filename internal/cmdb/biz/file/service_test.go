package file

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	filemodel "github.com/ongridio/ongrid/internal/cmdb/model/file"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type memRepo struct {
	settings map[string]*filemodel.Setting
	files    map[string]*filemodel.File
}

func newMemRepo() *memRepo {
	return &memRepo{settings: map[string]*filemodel.Setting{}, files: map[string]*filemodel.File{}}
}

func (r *memRepo) GetSetting(_ context.Context, kind string) (*filemodel.Setting, error) {
	row, ok := r.settings[kind]
	if !ok {
		return nil, errs.ErrNotFound
	}
	copy := *row
	return &copy, nil
}

func (r *memRepo) SetSetting(_ context.Context, kind, value string) error {
	r.settings[kind] = &filemodel.Setting{Kind: kind, Value: value}
	return nil
}

func (r *memRepo) CreateFile(_ context.Context, row *filemodel.File) error {
	copy := *row
	r.files[row.FileID] = &copy
	return nil
}

func (r *memRepo) GetFile(_ context.Context, fileID string) (*filemodel.File, error) {
	row, ok := r.files[fileID]
	if !ok {
		return nil, errs.ErrNotFound
	}
	copy := *row
	return &copy, nil
}

func (r *memRepo) DeleteFile(_ context.Context, fileID string) error {
	delete(r.files, fileID)
	return nil
}

func newTestUsecase(t *testing.T) (*Usecase, *memRepo, string) {
	t.Helper()
	root := t.TempDir()
	repo := newMemRepo()
	uc := NewUsecase(repo, Options{
		DefaultLocalPath:     root,
		DefaultPreviewURL:    "http://127.0.0.1:8012/onlinePreview",
		DefaultMaxFileSizeMB: 50,
		SignerSecret:         "test-signer",
	})
	uc.now = func() time.Time { return time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC) }
	return uc, repo, root
}

func TestStorageDefaultsAndMaskedSecret(t *testing.T) {
	uc, _, root := newTestUsecase(t)
	cfg, err := uc.Storage(context.Background())
	if err != nil {
		t.Fatalf("Storage: %v", err)
	}
	if cfg.StorageBackend != BackendLocal || cfg.LocalPath != root {
		t.Fatalf("default storage = %+v", cfg)
	}
	if cfg.MaxFileSizeMB != 50 || len(cfg.AllowedExtensions) == 0 {
		t.Fatalf("defaults missing: %+v", cfg)
	}

	backend := BackendS3
	endpoint := "http://minio:9000"
	access := "ak"
	secret := "super-secret"
	bucket := "cmdb-files"
	region := "us-east-1"
	ssl := false
	if _, err := uc.UpdateStorage(context.Background(), StoragePatch{
		StorageBackend: &backend,
		S3EndpointURL:  &endpoint,
		S3AccessKey:    &access,
		S3SecretKey:    &secret,
		S3BucketName:   &bucket,
		S3Region:       &region,
		S3UseSSL:       &ssl,
	}); err != nil {
		t.Fatalf("UpdateStorage: %v", err)
	}
	public, _ := uc.Storage(context.Background())
	if public.S3SecretKey != MaskedSecret || public.S3UseSSL {
		t.Fatalf("public storage = %+v", public)
	}
	internal, err := uc.resolveStorage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if internal.S3SecretKey != secret {
		t.Fatalf("secret was not stored: %+v", internal)
	}

	// Sending the mask back must preserve the real secret.
	masked := MaskedSecret
	nextBucket := "another-bucket"
	if _, err := uc.UpdateStorage(context.Background(), StoragePatch{
		S3SecretKey:  &masked,
		S3BucketName: &nextBucket,
	}); err != nil {
		t.Fatalf("UpdateStorage with mask: %v", err)
	}
	internal, _ = uc.resolveStorage(context.Background())
	if internal.S3SecretKey != secret || internal.S3BucketName != nextBucket {
		t.Fatalf("mask handling = %+v", internal)
	}
}

func TestStorageValidation(t *testing.T) {
	uc, _, _ := newTestUsecase(t)
	backend := BackendS3
	endpoint := "http://minio:9000"
	// S3 requires both credentials.
	_, err := uc.UpdateStorage(context.Background(), StoragePatch{
		StorageBackend: &backend,
		S3EndpointURL:  &endpoint,
	})
	if !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("expected invalid, got %v", err)
	}
	local := BackendLocal
	relative := "relative/path"
	if _, err := uc.UpdateStorage(context.Background(), StoragePatch{
		StorageBackend: &local,
		LocalPath:      &relative,
	}); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("relative local path accepted: %v", err)
	}
}

func TestUploadOpenDelete(t *testing.T) {
	uc, repo, root := newTestUsecase(t)
	files, err := uc.Upload(context.Background(), 7, "", []FileInput{{
		Name:        "report.txt",
		Size:        5,
		ContentType: "text/plain",
		Reader:      bytes.NewReader([]byte("hello")),
	}})
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if len(files) != 1 || files[0].FileID == "" || files[0].OriginalName != "report.txt" {
		t.Fatalf("files = %+v", files)
	}
	if files[0].StorageBackend != BackendLocal {
		t.Fatalf("backend = %q", files[0].StorageBackend)
	}
	diskPath := filepath.Join(root, filepath.FromSlash(files[0].StoredPath))
	if _, err := os.Stat(diskPath); err != nil {
		t.Fatalf("stored object missing: %v", err)
	}
	reader, row, object, err := uc.Open(context.Background(), files[0].FileID)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()
	data := make([]byte, 5)
	if _, err := reader.Read(data); err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" || row.OriginalName != "report.txt" || object.Size != 5 {
		t.Fatalf("read %q row=%+v object=%+v", data, row, object)
	}
	deleted, err := uc.DeleteFiles(context.Background(), []string{files[0].FileID})
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteFiles = %d, %v", deleted, err)
	}
	if _, err := os.Stat(diskPath); !os.IsNotExist(err) {
		t.Fatalf("object still exists: %v", err)
	}
	if _, err := repo.GetFile(context.Background(), files[0].FileID); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("metadata still exists: %v", err)
	}
}

func TestUploadRejectsTypeAndSize(t *testing.T) {
	uc, _, _ := newTestUsecase(t)
	if _, err := uc.Upload(context.Background(), 1, "", []FileInput{{
		Name: "evil.exe", Size: 1, Reader: bytes.NewReader([]byte("x")),
	}}); !errors.Is(err, errs.ErrInvalid) {
		t.Fatalf("bad extension accepted: %v", err)
	}
	uc.defaults.MaxFileSizeMB = 1
	tooLarge := make([]byte, 2<<20)
	if _, err := uc.Upload(context.Background(), 1, "", []FileInput{{
		Name: "large.txt", Size: int64(len(tooLarge)), Reader: bytes.NewReader(tooLarge),
	}}); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatalf("size limit not enforced: %v", err)
	}
}

func TestPreviewCapability(t *testing.T) {
	uc, _, _ := newTestUsecase(t)
	files, err := uc.Upload(context.Background(), 1, "", []FileInput{{
		Name: "report.txt", Size: 1, Reader: bytes.NewReader([]byte("x")),
	}})
	if err != nil {
		t.Fatal(err)
	}
	path, expires, err := uc.PreviewLink(context.Background(), files[0].FileID, false)
	if err != nil {
		t.Fatalf("PreviewLink: %v", err)
	}
	if !strings.HasPrefix(path, "/api/v1/cmdb/ci/files/public/") || expires.IsZero() {
		t.Fatalf("link = %q %v", path, expires)
	}
	token := strings.TrimPrefix(path, "/api/v1/cmdb/ci/files/public/")
	fileID, download, _, err := uc.ResolveCapability(token)
	if err != nil || fileID != files[0].FileID || download {
		t.Fatalf("ResolveCapability = %q %v %v", fileID, download, err)
	}
	if _, _, _, err := uc.ResolveCapability(token + "x"); err == nil {
		t.Fatal("tampered capability accepted")
	}

	uc.now = func() time.Time { return expires.Add(time.Second) }
	if _, _, _, err := uc.ResolveCapability(token); err == nil {
		t.Fatal("expired capability accepted")
	}
}

func TestCleanupFileValueChange(t *testing.T) {
	uc, repo, _ := newTestUsecase(t)
	uploads, err := uc.Upload(context.Background(), 1, "", []FileInput{
		{Name: "a.txt", Size: 1, Reader: bytes.NewReader([]byte("a"))},
		{Name: "b.txt", Size: 1, Reader: bytes.NewReader([]byte("b"))},
	})
	if err != nil {
		t.Fatal(err)
	}
	oldValue, _ := jsonMarshal(uploads)
	newValue, _ := jsonMarshal(uploads[:1])
	if err := uc.CleanupFileValueChange(context.Background(), oldValue, newValue); err != nil {
		t.Fatalf("CleanupFileValueChange: %v", err)
	}
	if _, err := repo.GetFile(context.Background(), uploads[0].FileID); err != nil {
		t.Fatalf("kept file was deleted: %v", err)
	}
	if _, err := repo.GetFile(context.Background(), uploads[1].FileID); !errors.Is(err, errs.ErrNotFound) {
		t.Fatalf("removed file survived: %v", err)
	}
}

func jsonMarshal(files []FileDTO) (string, error) {
	data, err := json.Marshal(files)
	return string(data), err
}

func TestRelativePreviewUsesInternalURL(t *testing.T) {
	uc, _, _ := newTestUsecase(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/file-preview" && r.URL.Path != "/file-preview/" {
			t.Errorf("probe path = %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	uc.opts.PreviewInternalURL = server.URL

	url := "/file-preview/onlinePreview"
	if _, err := uc.UpdatePreview(context.Background(), PreviewPatch{PreviewServerURL: &url}); err != nil {
		t.Fatalf("UpdatePreview relative: %v", err)
	}
	if result := uc.TestPreview(context.Background(), url); !result.OK {
		t.Fatalf("TestPreview relative = %+v", result)
	}
}
