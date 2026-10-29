package objectstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Config is the connection subset the object store needs. It intentionally
// mirrors the fields the admin settings page exposes.
type S3Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	Region    string
	UseSSL    bool
}

// S3 stores objects in an S3-compatible bucket. Path-style addressing is used
// because it is what MinIO and most private deployments expect; S3 itself also
// accepts it. The product does not expose a virtual-hosted-style option.
type S3 struct {
	client *s3.Client
	bucket string

	bucketMu    sync.Mutex
	bucketReady bool
}

// NewS3 builds the client from explicit settings. It does not fall back to the
// ambient AWS environment: the settings page is the source of truth, and a
// silent fallback is how a test button and an upload end up using different
// credentials.
func NewS3(cfg S3Config) (*S3, error) {
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		return nil, errors.New("objectstore: S3 endpoint is required")
	}
	if !strings.Contains(endpoint, "://") {
		scheme := "https://"
		if !cfg.UseSSL {
			scheme = "http://"
		}
		endpoint = scheme + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("objectstore: invalid S3 endpoint %q", cfg.Endpoint)
	}
	if strings.TrimSpace(cfg.AccessKey) == "" || strings.TrimSpace(cfg.SecretKey) == "" {
		return nil, errors.New("objectstore: S3 access key and secret key are required")
	}
	bucket := strings.TrimSpace(cfg.Bucket)
	if bucket == "" {
		return nil, errors.New("objectstore: S3 bucket is required")
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "us-east-1"
	}
	client := s3.New(s3.Options{
		Region:       region,
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		BaseEndpoint: aws.String(endpoint),
		UsePathStyle: true,
	})
	return &S3{client: client, bucket: bucket}, nil
}

// ensureBucket makes the configured bucket usable on first write/test. RustFS
// and MinIO do not create a bucket just because a client asks for one; doing it
// here keeps installation to "start the service" instead of a separate mc
// init container. The result is cached so normal uploads pay no extra call.
func (s *S3) ensureBucket(ctx context.Context) error {
	s.bucketMu.Lock()
	defer s.bucketMu.Unlock()
	if s.bucketReady {
		return nil
	}
	if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); err == nil {
		s.bucketReady = true
		return nil
	}
	if _, err := s.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}); err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		var exists *s3types.BucketAlreadyExists
		if errors.As(err, &owned) || errors.As(err, &exists) {
			s.bucketReady = true
			return nil
		}
		return fmt.Errorf("objectstore: S3 create bucket %q: %w", s.bucket, err)
	}
	s.bucketReady = true
	return nil
}

// maxMemorySpool bounds how much of a non-seekable body is held in memory
// before falling back to a temporary file. CMDB attachments are usually small;
// the file path covers large uploads without multiplying peak memory.
const maxMemorySpool = 8 << 20

// ensureSeekable makes a body rewindable. SigV4 hashes the payload and rewinds
// it for HTTP endpoints (RustFS/MinIO), which fails for a streaming reader.
// Callers should pass an io.Seeker; this is a safety net for adapters.
func ensureSeekable(r io.Reader, size int64) (io.Reader, func(), error) {
	if _, ok := r.(io.Seeker); ok {
		return r, func() {}, nil
	}
	if size >= 0 && size <= maxMemorySpool {
		body, err := io.ReadAll(io.LimitReader(r, maxMemorySpool+1))
		if err != nil {
			return nil, nil, fmt.Errorf("objectstore: read S3 body: %w", err)
		}
		if int64(len(body)) <= maxMemorySpool {
			return bytes.NewReader(body), func() {}, nil
		}
		return spoolS3Body(body, r)
	}
	return spoolS3Body(nil, r)
}

func spoolS3Body(prefix []byte, r io.Reader) (io.Reader, func(), error) {
	file, err := os.CreateTemp("", "ongrid-s3-body-*")
	if err != nil {
		return nil, nil, fmt.Errorf("objectstore: create S3 spool file: %w", err)
	}
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}
	if len(prefix) > 0 {
		if _, err := file.Write(prefix); err != nil {
			cleanup()
			return nil, nil, fmt.Errorf("objectstore: write S3 spool file: %w", err)
		}
	}
	if _, err := io.Copy(file, r); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("objectstore: write S3 spool file: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("objectstore: rewind S3 spool file: %w", err)
	}
	return file, cleanup, nil
}

func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (Object, error) {
	if size < 0 {
		return Object{}, errors.New("objectstore: size must be non-negative")
	}
	if err := s.ensureBucket(ctx); err != nil {
		return Object{}, err
	}
	body, cleanup, err := ensureSeekable(r, size)
	if err != nil {
		return Object{}, err
	}
	defer cleanup()
	input := &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
	}
	if contentType != "" {
		input.ContentType = aws.String(contentType)
	}
	if _, err := s.client.PutObject(ctx, input); err != nil {
		return Object{}, fmt.Errorf("objectstore: S3 put: %w", err)
	}
	return Object{Key: key, Size: size, ContentType: contentType}, nil
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, Object, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, Object{}, fmt.Errorf("objectstore: S3 get: %w", err)
	}
	object := Object{
		Key:         key,
		Size:        aws.ToInt64(out.ContentLength),
		ContentType: aws.ToString(out.ContentType),
	}
	return out.Body, object, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}); err != nil {
		return fmt.Errorf("objectstore: S3 delete: %w", err)
	}
	return nil
}

func (s *S3) Stat(ctx context.Context, key string) (Object, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return Object{}, fmt.Errorf("objectstore: S3 head: %w", err)
	}
	return Object{
		Key:         key,
		Size:        aws.ToInt64(out.ContentLength),
		ContentType: aws.ToString(out.ContentType),
	}, nil
}

func (s *S3) Health(ctx context.Context) error {
	if err := s.ensureBucket(ctx); err != nil {
		return err
	}
	return nil
}
