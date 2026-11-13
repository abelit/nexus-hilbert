package setting

import (
	"errors"
	"strings"
	"testing"

	model "github.com/ongridio/ongrid/internal/manager/model/setting"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// TestValidateEdgeInstallURL covers the two admin-editable Edge install base
// URLs. They are concatenated with /install.sh and /edge/windows/... by the
// UI, so paths, queries, and credentials must be rejected here.
func TestValidateEdgeInstallURL(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		key     string
		value   string
		wantErr bool
	}{
		{"empty clears row", model.KeyEdgeInstallInternalURL, "", false},
		{"https host", model.KeyEdgeInstallInternalURL, "https://ongrid.example.com", false},
		{"http host with port", model.KeyEdgeInstallExternalURL, "http://10.0.0.10:8443", false},
		{"trailing slash", model.KeyEdgeInstallInternalURL, "https://ongrid.example.com/", false},
		{"missing scheme", model.KeyEdgeInstallInternalURL, "ongrid.example.com", true},
		{"unsupported scheme", model.KeyEdgeInstallInternalURL, "ftp://ongrid.example.com", true},
		{"credentials", model.KeyEdgeInstallExternalURL, "https://user:pass@ongrid.example.com", true},
		{"path", model.KeyEdgeInstallExternalURL, "https://ongrid.example.com/ongrid", true},
		{"query", model.KeyEdgeInstallExternalURL, "https://ongrid.example.com?x=1", true},
		{"fragment", model.KeyEdgeInstallExternalURL, "https://ongrid.example.com#x", true},
		{"too long", model.KeyEdgeInstallInternalURL, "https://" + strings.Repeat("a", 600) + ".example.com", true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := validateSetting(model.CategoryEdge, tc.key, tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("validateSetting(%q=%q) = nil, want error", tc.key, tc.value)
				}
				if !errors.Is(err, errs.ErrInvalid) {
					t.Fatalf("error = %v, want errs.ErrInvalid", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("validateSetting(%q=%q) = %v, want nil", tc.key, tc.value, err)
			}
		})
	}
}

func TestValidateEdgeInstallURL_RejectsUnknownKey(t *testing.T) {
	t.Parallel()
	if err := validateSetting(model.CategoryEdge, "unknown_key", "https://ongrid.example.com"); err == nil {
		t.Fatal("unknown edge setting should be rejected")
	}
}
