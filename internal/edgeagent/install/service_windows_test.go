//go:build windows

package install

import (
	"errors"
	"strings"
	"testing"
)

// fakeExitError implements the exitCoder interface used by
// isServiceAlreadyExists without spawning a real process.
type fakeExitError struct {
	code int
}

func (e *fakeExitError) Error() string { return "fake exit error" }
func (e *fakeExitError) ExitCode() int { return e.code }

// TestIsServiceAlreadyExists_ExitCode1073 verifies reinstall over an existing
// service is treated as success (plan Review Focus: idempotent install must
// not roll back the existing credential).
func TestIsServiceAlreadyExists_ExitCode1073(t *testing.T) {
	if !isServiceAlreadyExists(&fakeExitError{code: 1073}, nil) {
		t.Error("exit code 1073 should be treated as already exists")
	}
	for _, code := range []int{1, 5, 1060, 1062} {
		if isServiceAlreadyExists(&fakeExitError{code: code}, nil) {
			t.Errorf("exit code %d must not be treated as already exists", code)
		}
	}
}

// TestIsServiceAlreadyExists_OutputText covers adapters that expose text only.
func TestIsServiceAlreadyExists_OutputText(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		output string
		want   bool
	}{
		{
			name:   "sc 1073 text",
			err:    errors.New("exit status 1"),
			output: "[SC] CreateService FAILED 1073: The specified service already exists.",
			want:   true,
		},
		{
			name:   "already exists text",
			err:    errors.New("exit status 1"),
			output: "The service already exists.",
			want:   true,
		},
		{
			name:   "access denied",
			err:    errors.New("exit status 5"),
			output: "[SC] CreateService FAILED 5: Access is denied.",
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isServiceAlreadyExists(tc.err, []byte(tc.output)); got != tc.want {
				t.Fatalf("isServiceAlreadyExists() = %v, want %v (output %q)", got, tc.want, tc.output)
			}
		})
	}
}

// TestBuildDefenderExclusionCmd_SingleParamName 验证 -ExclusionPath 参数名只出现一次。
// 回归防护：旧代码用 `-ExclusionPath A -ExclusionPath B` 会导致 PowerShell
// ParameterAlreadyBound 错误。
func TestBuildDefenderExclusionCmd_SingleParamName(t *testing.T) {
	cmd := buildDefenderExclusionCmd(`C:\bin`, `C:\data`)
	if count := strings.Count(cmd, "-ExclusionPath"); count != 1 {
		t.Errorf("-ExclusionPath should appear exactly once, got %d (cmd: %s)", count, cmd)
	}
}

// TestBuildDefenderExclusionCmd_CommaSeparated 验证两个路径用逗号分隔。
// PowerShell 数组参数语法：`-ParamName "val1","val2"`。
func TestBuildDefenderExclusionCmd_CommaSeparated(t *testing.T) {
	binDir := `C:\Program Files\ongrid-edge\bin`
	dataDir := `C:\ProgramData\ongrid-edge`
	cmd := buildDefenderExclusionCmd(binDir, dataDir)

	if !strings.Contains(cmd, `"`+binDir+`","`+dataDir+`"`) {
		t.Errorf("expected comma-separated paths in command, got: %s", cmd)
	}
}

// TestBuildDefenderExclusionCmd_BothPathsPresent 验证两个目录都出现在命令中。
func TestBuildDefenderExclusionCmd_BothPathsPresent(t *testing.T) {
	binDir := `C:\test\bin`
	dataDir := `C:\test\data`
	cmd := buildDefenderExclusionCmd(binDir, dataDir)

	if !strings.Contains(cmd, binDir) {
		t.Errorf("binDir missing from command: %s", cmd)
	}
	if !strings.Contains(cmd, dataDir) {
		t.Errorf("dataDir missing from command: %s", cmd)
	}
}

// TestBuildDefenderExclusionCmd_AddMpPreferencePresent 验证命令前缀正确。
func TestBuildDefenderExclusionCmd_AddMpPreferencePresent(t *testing.T) {
	cmd := buildDefenderExclusionCmd(`C:\a`, `C:\b`)
	if !strings.HasPrefix(cmd, "Add-MpPreference ") {
		t.Errorf("command should start with Add-MpPreference, got: %s", cmd)
	}
	if !strings.Contains(cmd, "-ErrorAction SilentlyContinue") {
		t.Errorf("command should contain -ErrorAction SilentlyContinue, got: %s", cmd)
	}
}
