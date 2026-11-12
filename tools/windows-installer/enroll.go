package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// enrollmentTimeout bounds one enrollment exchange. The timeout is applied to
// the request context so it also covers a client that has no timeout of its
// own.
const enrollmentTimeout = 20 * time.Second

// enrollmentBodyLimit bounds how much of a response body is read. The success
// payload is small and a failed response is only used for diagnostics.
const enrollmentBodyLimit = 64 << 10

// Credentials is the per-device identity returned by the Manager enrollment
// endpoint. SecretKey must never be written to a log.
type Credentials struct {
	EdgeID           uint64
	AccessKey        string
	SecretKey        string
	CloudAddr        string
	ManagerPublicURL string
}

type enrollRequest struct {
	HostInfo     HostInfo `json:"host_info"`
	AgentVersion string   `json:"agent_version"`
}

type enrollResponse struct {
	EdgeID           uint64 `json:"edge_id"`
	AccessKey        string `json:"access_key"`
	SecretKey        string `json:"secret_key"`
	CloudAddr        string `json:"cloud_addr"`
	ManagerPublicURL string `json:"manager_public_url"`
}

// Enroll exchanges a batch enrollment token for per-device credentials.
//
// It posts host and agent version to {managerURL}/internal/edge/enroll with a
// bearer token and accepts only HTTP 201. Other statuses are reported with a
// bounded copy of the response body. Missing or non URL-safe credentials are
// rejected. Neither the token nor the returned secret is included in an error.
func Enroll(ctx context.Context, client *http.Client, managerURL, token string, host HostInfo, agentVersion string) (*Credentials, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("enroll: enrollment token is required")
	}
	baseURL, err := normalizeEnrollmentManagerURL(managerURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(host.Hostname) == "" {
		return nil, errors.New("enroll: host_info.hostname is required")
	}
	if strings.TrimSpace(host.Fingerprint) == "" && strings.TrimSpace(host.HardwareFingerprint) == "" {
		return nil, errors.New("enroll: a stable host fingerprint is required")
	}

	body, err := json.Marshal(enrollRequest{HostInfo: host, AgentVersion: agentVersion})
	if err != nil {
		return nil, fmt.Errorf("enroll: encode request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, enrollmentTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/internal/edge/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("enroll: build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")

	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("enroll: request failed: %w", err)
	}
	defer response.Body.Close()

	limited := io.LimitReader(response.Body, enrollmentBodyLimit)
	if response.StatusCode != http.StatusCreated {
		message, _ := io.ReadAll(limited)
		detail := strings.TrimSpace(string(message))
		if detail != "" {
			return nil, fmt.Errorf("enroll: manager returned HTTP %d: %s", response.StatusCode, detail)
		}
		return nil, fmt.Errorf("enroll: manager returned HTTP %d", response.StatusCode)
	}

	var result enrollResponse
	if err := json.NewDecoder(limited).Decode(&result); err != nil {
		return nil, fmt.Errorf("enroll: decode response: %w", err)
	}
	if !isURLSafeCredential(result.AccessKey) {
		return nil, errors.New("enroll: response contains a missing or malformed access_key")
	}
	if !isURLSafeCredential(result.SecretKey) {
		return nil, errors.New("enroll: response contains a missing or malformed secret_key")
	}

	return &Credentials{
		EdgeID:           result.EdgeID,
		AccessKey:        result.AccessKey,
		SecretKey:        result.SecretKey,
		CloudAddr:        result.CloudAddr,
		ManagerPublicURL: result.ManagerPublicURL,
	}, nil
}

// isURLSafeCredential applies the same rule as the edge agent enrollment: only
// unreserved URL characters are accepted, so a credential can be embedded in a
// query or environment value without escaping.
func isURLSafeCredential(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char >= '0' && char <= '9':
		case char == '-', char == '_':
		default:
			return false
		}
	}
	return true
}

// normalizeEnrollmentManagerURL trims the trailing slash and rejects URLs that
// cannot be used as an HTTP base. A path prefix is allowed because the
// installer accepts a Manager mounted below a sub-path.
func normalizeEnrollmentManagerURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", errors.New("enroll: manager URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("enroll: invalid manager URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("enroll: manager URL scheme must be http or https")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("enroll: manager URL must not contain credentials, query, or fragment")
	}
	return raw, nil
}
