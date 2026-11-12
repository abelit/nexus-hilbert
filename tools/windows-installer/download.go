package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// downloadErrorBodyLimit bounds how much of a failed response body is included
// in diagnostics so a hostile server cannot flood the installer log.
const downloadErrorBodyLimit = 4 << 10

// maxDownloadSize bounds one artifact download (512 MiB). It keeps a hostile
// or misconfigured Manager from filling the installer host's disk.
const maxDownloadSize int64 = 512 << 20

// downloadClientTimeout bounds a whole artifact transfer when the installer
// uses newDownloadClient. A caller-supplied client controls its own timeout.
const downloadClientTimeout = 5 * time.Minute

// newDownloadClient returns the client used for artifact and manifest
// downloads. The timeout covers the entire request, including body reads.
func newDownloadClient() *http.Client {
	return &http.Client{Timeout: downloadClientTimeout}
}

// DownloadFile fetches rawURL into dest with a 512 MiB size bound.
//
// The body is written to a temporary file in the destination directory and
// renamed into place only after the write succeeds, so a failed download never
// leaves a partial artifact at dest. Callers must still verify the SHA-256 of
// the renamed file before using it.
//
// Redirect handling is delegated to the supplied client. The standard client
// follows up to ten redirects, including redirects to another host or scheme;
// callers that require same-origin downloads should supply a client with a
// CheckRedirect policy. A nil client uses http.DefaultClient, which has no
// timeout: callers using the default client must supply a deadline on ctx.
func DownloadFile(ctx context.Context, client *http.Client, rawURL, dest string) error {
	return downloadFile(ctx, client, rawURL, dest, maxDownloadSize)
}

// downloadFile is DownloadFile with an explicit size bound, so the bound can be
// exercised without transferring half a gigabyte in tests.
func downloadFile(ctx context.Context, client *http.Client, rawURL, dest string, limit int64) error {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return fmt.Errorf("download: url is empty")
	}
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return fmt.Errorf("download %s: destination is empty", rawURL)
	}
	if client == nil {
		client = http.DefaultClient
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("download %s: build request: %w", rawURL, err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message, readErr := io.ReadAll(io.LimitReader(response.Body, downloadErrorBodyLimit))
		body := strings.TrimSpace(string(message))
		if readErr != nil && body == "" {
			return fmt.Errorf("download %s: HTTP %d", rawURL, response.StatusCode)
		}
		if body != "" {
			return fmt.Errorf("download %s: HTTP %d: %s", rawURL, response.StatusCode, body)
		}
		return fmt.Errorf("download %s: HTTP %d", rawURL, response.StatusCode)
	}

	directory := filepath.Dir(dest)
	temporary, err := os.CreateTemp(directory, ".ongrid-download-*")
	if err != nil {
		return fmt.Errorf("download %s: create temporary file: %w", rawURL, err)
	}
	temporaryName := temporary.Name()
	// Remove the temporary file on every failure path. After a successful
	// rename the name no longer refers to our file, so clear the flag.
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporaryName) // Best-effort cleanup after a failed download.
		}
	}()

	written, err := io.Copy(temporary, io.LimitReader(response.Body, limit+1))
	if err != nil {
		closeErr := temporary.Close()
		return fmt.Errorf("download %s: write temporary file: %w", rawURL, errors.Join(err, closeErr))
	}
	if written > limit {
		closeErr := temporary.Close()
		if closeErr != nil {
			return fmt.Errorf("download %s: artifact exceeds the %d-byte size limit: %w", rawURL, limit, closeErr)
		}
		return fmt.Errorf("download %s: artifact exceeds the %d-byte size limit", rawURL, limit)
	}
	if err := temporary.Sync(); err != nil {
		closeErr := temporary.Close()
		return fmt.Errorf("download %s: sync temporary file: %w", rawURL, errors.Join(err, closeErr))
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("download %s: close temporary file: %w", rawURL, err)
	}
	if err := os.Rename(temporaryName, dest); err != nil {
		return fmt.Errorf("download %s: rename temporary file to %s: %w", rawURL, dest, err)
	}
	cleanup = false
	return nil
}

// VerifySHA256 checks that path is exactly the file identified by expected, a
// 64-character hexadecimal SHA-256 digest. The comparison is case-insensitive.
//
// A mismatch error names the file and the digest that was computed, but never
// echoes the expected digest so callers can log the error without exposing a
// credential-like value from the manifest.
func VerifySHA256(path, expected string) error {
	expected = strings.TrimSpace(expected)
	if len(expected) != sha256.Size*2 {
		return fmt.Errorf("verify %s: sha256 must be exactly %d hex characters", path, sha256.Size*2)
	}
	for i := 0; i < len(expected); i++ {
		if !isHexDigit(expected[i]) {
			return fmt.Errorf("verify %s: sha256 must be hexadecimal", path)
		}
	}

	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("verify %s: %w", path, err)
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return fmt.Errorf("verify %s: hash file: %w", path, err)
	}
	actual := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("verify %s: sha256 mismatch (got %s)", path, actual)
	}
	return nil
}
