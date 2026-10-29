package file

import (
	"fmt"
	"net/url"
	"strings"
)

// DefaultAllowedExtensions is deliberately derived from cantor's allowlist.
// SVG and HTML stay out: both can execute script when served inline, and the
// product has no reason to inline them.
var DefaultAllowedExtensions = []string{
	"txt", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp",
	"xls", "xlsx", "doc", "docx", "ppt", "pptx", "csv", "json",
	"zip", "rar", "7z", "log",
}

const (
	BackendLocal = "local"
	BackendS3    = "s3"

	// MaskedSecret is returned by the API instead of the stored S3 secret.
	// Sending it back means "keep the current value".
	MaskedSecret = "******"

	DefaultMaxFileSizeMB = 50
	MaxFileSizeMB        = 500
)

// StorageConfig is the effective file-storage configuration.
//
// The JSON field names are the public settings API contract; the browser and
// the S3 test endpoint both use them.
type StorageConfig struct {
	StorageBackend    string   `json:"storage_backend"`
	LocalPath         string   `json:"local_path"`
	S3EndpointURL     string   `json:"s3_endpoint_url"`
	S3AccessKey       string   `json:"s3_access_key"`
	S3SecretKey       string   `json:"s3_secret_key"`
	S3BucketName      string   `json:"s3_bucket_name"`
	S3Region          string   `json:"s3_region"`
	S3UseSSL          bool     `json:"s3_use_ssl"`
	AllowedExtensions []string `json:"allowed_extensions"`
	MaxFileSizeMB     int      `json:"max_file_size_mb"`
}

// StoragePatch is a partial update. Pointers let false and 0 be meaningful
// values, which a plain struct cannot express.
type StoragePatch struct {
	StorageBackend    *string   `json:"storage_backend"`
	LocalPath         *string   `json:"local_path"`
	S3EndpointURL     *string   `json:"s3_endpoint_url"`
	S3AccessKey       *string   `json:"s3_access_key"`
	S3SecretKey       *string   `json:"s3_secret_key"`
	S3BucketName      *string   `json:"s3_bucket_name"`
	S3Region          *string   `json:"s3_region"`
	S3UseSSL          *bool     `json:"s3_use_ssl"`
	AllowedExtensions *[]string `json:"allowed_extensions"`
	MaxFileSizeMB     *int      `json:"max_file_size_mb"`
}

// PreviewConfig is the kkFileView configuration. It contains no secrets, so
// the browser may read it to build the iframe URL.
type PreviewConfig struct {
	PreviewServerURL string `json:"preview_server_url"`
	// FileFetchBaseURL is the absolute base kkFileView uses to fetch the
	// signed capability URL. It must be reachable from the kkFileView
	// process, which is often not the browser's public origin (compose
	// network names, private TLS, split DNS). Empty falls back to the
	// frontend's VITE_FILE_API_BASE_URL or the browser origin.
	FileFetchBaseURL       string   `json:"file_fetch_base_url"`
	ForceUpdatedCacheTypes []string `json:"force_updated_cache_types"`
}

// PreviewPatch is the partial preview update.
type PreviewPatch struct {
	PreviewServerURL       *string   `json:"preview_server_url"`
	FileFetchBaseURL       *string   `json:"file_fetch_base_url"`
	ForceUpdatedCacheTypes *[]string `json:"force_updated_cache_types"`
}

// TestResult is the shape both "test connection" actions return.
type TestResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// Options are the process-level defaults. The saved configuration overrides
// them field by field; these values are what a fresh install sees before an
// administrator saves anything.
type Options struct {
	DefaultLocalPath      string
	DefaultStorageBackend string
	DefaultS3EndpointURL  string
	DefaultS3AccessKey    string
	DefaultS3SecretKey    string
	DefaultS3BucketName   string
	DefaultS3Region       string
	DefaultS3UseSSL       *bool
	DefaultPreviewURL     string
	// DefaultFileFetchBaseURL prefills the preview settings' file access
	// address. The bundled compose sets the CMDB service name so kkFileView
	// does not depend on the public host or its TLS certificate.
	DefaultFileFetchBaseURL  string
	PreviewInternalURL       string
	DefaultAllowedExtensions []string
	DefaultMaxFileSizeMB     int
	// SignerSecret signs short-lived preview/download capabilities. The CMDB
	// process passes the JWT secret, so a capability is independent of any one
	// browser session and expires without a database lookup.
	SignerSecret string
}

func defaultStorage(opts Options) StorageConfig {
	allowed := opts.DefaultAllowedExtensions
	if len(allowed) == 0 {
		allowed = DefaultAllowedExtensions
	}
	maxMB := opts.DefaultMaxFileSizeMB
	if maxMB <= 0 {
		maxMB = DefaultMaxFileSizeMB
	}
	backend := strings.ToLower(strings.TrimSpace(opts.DefaultStorageBackend))
	if backend == "" {
		backend = BackendLocal
	}
	ssl := true
	if opts.DefaultS3UseSSL != nil {
		ssl = *opts.DefaultS3UseSSL
	}
	bucket := strings.TrimSpace(opts.DefaultS3BucketName)
	if bucket == "" {
		bucket = "cmdb-files"
	}
	region := strings.TrimSpace(opts.DefaultS3Region)
	if region == "" {
		region = "us-east-1"
	}
	return StorageConfig{
		StorageBackend:    backend,
		LocalPath:         strings.TrimSpace(opts.DefaultLocalPath),
		S3EndpointURL:     strings.TrimSpace(opts.DefaultS3EndpointURL),
		S3AccessKey:       strings.TrimSpace(opts.DefaultS3AccessKey),
		S3SecretKey:       strings.TrimSpace(opts.DefaultS3SecretKey),
		S3BucketName:      bucket,
		S3Region:          region,
		S3UseSSL:          ssl,
		AllowedExtensions: normalizeExtensions(allowed),
		MaxFileSizeMB:     maxMB,
	}
}

func defaultPreview(opts Options) PreviewConfig {
	return PreviewConfig{
		PreviewServerURL: strings.TrimSpace(opts.DefaultPreviewURL),
		FileFetchBaseURL: normalizeBaseURL(opts.DefaultFileFetchBaseURL),
		ForceUpdatedCacheTypes: []string{
			"txt", "html", "htm", "asp", "jsp", "xml", "json", "properties",
			"md", "gitignore", "log", "java", "py", "c", "cpp", "sql", "sh",
			"bat", "m", "bas", "prg", "cmd",
		},
	}
}

func normalizeBaseURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

// validateFileFetchBaseURL accepts an empty value (the frontend falls back to
// its build-time base or the browser origin). A configured value must be an
// absolute HTTP(S) URL: kkFileView receives the signed capability path after
// it, so a scheme-less value would be resolved against kkFileView itself.
func validateFileFetchBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("file access address must be an absolute http(s) URL")
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "http" && scheme != "https" {
		return fmt.Errorf("file access address must use http or https")
	}
	if parsed.User != nil {
		return fmt.Errorf("file access address must not contain credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("file access address must not contain a query or fragment")
	}
	return nil
}

func normalizeExtensions(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, ".")))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func (c StorageConfig) validate() error {
	switch c.StorageBackend {
	case BackendLocal:
		if strings.TrimSpace(c.LocalPath) == "" {
			return fmt.Errorf("local storage path is required")
		}
		// A relative path would put files under the process working directory,
		// which changes between local runs and a container. Require the
		// operator to be explicit.
		if !strings.HasPrefix(strings.TrimSpace(c.LocalPath), "/") {
			return fmt.Errorf("local storage path must be absolute")
		}
	case BackendS3:
		if strings.TrimSpace(c.S3EndpointURL) == "" {
			return fmt.Errorf("S3 endpoint URL is required when the backend is s3")
		}
		if strings.TrimSpace(c.S3AccessKey) == "" || strings.TrimSpace(c.S3SecretKey) == "" {
			return fmt.Errorf("S3 access key and secret key are required when the backend is s3")
		}
	default:
		return fmt.Errorf("unknown storage backend %q", c.StorageBackend)
	}
	if len(c.AllowedExtensions) == 0 {
		return fmt.Errorf("at least one allowed extension is required")
	}
	if c.MaxFileSizeMB < 1 || c.MaxFileSizeMB > MaxFileSizeMB {
		return fmt.Errorf("max file size must be between 1 and %d MB", MaxFileSizeMB)
	}
	return nil
}

func validatePreview(c PreviewConfig) error {
	if err := validatePreviewServerURL(c.PreviewServerURL); err != nil {
		return err
	}
	return validateFileFetchBaseURL(c.FileFetchBaseURL)
}

func validatePreviewServerURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("preview server URL is required")
	}
	// A root-relative path is valid: the bundled service is served behind the
	// same nginx origin under /file-preview/. Reject protocol-relative URLs,
	// which would silently point at another host.
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("preview server URL must be an absolute http(s) URL")
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "http" && scheme != "https" {
		return fmt.Errorf("preview server URL must use http or https")
	}
	return nil
}
