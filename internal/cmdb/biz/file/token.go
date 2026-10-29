package file

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ongridio/ongrid/internal/pkg/errs"
)

type capability struct {
	FileID   string `json:"f"`
	Download bool   `json:"d,omitempty"`
	Expires  int64  `json:"e"`
}

// mintCapability produces a stateless, path-scoped capability. The token is
// signed with the CMDB JWT secret plus a domain-separation prefix, so it can
// never be replayed as an access token and an access token cannot be used as a
// capability.
func mintCapability(secret, fileID string, download bool, expires time.Time) (string, error) {
	if strings.TrimSpace(secret) == "" {
		return "", fmt.Errorf("%w: file capability signer is not configured", errs.ErrNotWiredYet)
	}
	payload, err := json.Marshal(capability{FileID: fileID, Download: download, Expires: expires.Unix()})
	if err != nil {
		return "", fmt.Errorf("cmdb file: encode capability: %w", err)
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte("cmdb-file-capability-v1:"+secret))
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func verifyCapability(secret, token string, now time.Time) (string, bool, time.Time, error) {
	parts := strings.SplitN(strings.TrimSpace(token), ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", false, time.Time{}, fmt.Errorf("%w: malformed file capability", errs.ErrUnauthorized)
	}
	mac := hmac.New(sha256.New, []byte("cmdb-file-capability-v1:"+secret))
	mac.Write([]byte(parts[0]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[1])) {
		return "", false, time.Time{}, fmt.Errorf("%w: invalid file capability", errs.ErrUnauthorized)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false, time.Time{}, fmt.Errorf("%w: malformed file capability", errs.ErrUnauthorized)
	}
	var c capability
	if err := json.Unmarshal(raw, &c); err != nil || strings.TrimSpace(c.FileID) == "" {
		return "", false, time.Time{}, fmt.Errorf("%w: malformed file capability", errs.ErrUnauthorized)
	}
	expires := time.Unix(c.Expires, 0)
	if !now.Before(expires) {
		return "", false, time.Time{}, fmt.Errorf("%w: file capability expired", errs.ErrUnauthorized)
	}
	return c.FileID, c.Download, expires, nil
}
