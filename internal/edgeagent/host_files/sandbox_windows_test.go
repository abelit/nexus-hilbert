//go:build windows

package host_files

import "testing"

// TestValidatePath_WindowsDefaultDenylist exercises the deny policy on a
// real Windows host, where runtimePathSemantics selects the Windows rules
// natively. The same cases are covered platform-independently in
// sandbox_test.go through validatePathWith.
func TestValidatePath_WindowsDefaultDenylist(t *testing.T) {
	sb := DefaultSandboxConfig()
	mustReject := []string{
		`C:\Users\alice\.ssh\id_rsa`,
		`c:\users\ALICE\.ssh\id_rsa`,
		`C:\Windows\System32\config\SAM`,
		`C:\ProgramData\ssh\sshd_config`,
		`C:\ProgramData\Microsoft\Crypto\RSA\machinekeys`,
	}
	for _, bad := range mustReject {
		if err := sb.ValidatePath(bad); err == nil {
			t.Errorf("ValidatePath(%q) = nil, want rejection", bad)
		}
	}
}

func TestValidatePath_WindowsAllowsDocuments(t *testing.T) {
	sb := DefaultSandboxConfig()
	if err := sb.ValidatePath(`C:\Users\alice\Documents\notes.txt`); err != nil {
		t.Errorf("ValidatePath(documents) = %v, want nil", err)
	}
}

func TestRuntimePathSemantics_Windows(t *testing.T) {
	ps := runtimePathSemantics()
	if !ps.windows || !ps.caseInsensitive || ps.separator != `\` {
		t.Errorf("runtimePathSemantics() = %+v, want windows semantics", ps)
	}
}
