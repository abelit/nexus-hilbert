package powershell

import "testing"

func TestValidateReadOnlyAllowsReadCockpits(t *testing.T) {
	cases := []string{
		"Get-Service ongrid-edge",
		"Get-Process | Sort-Object CPU -Descending | Select-Object -First 5",
		"Test-Path C:\\ProgramData\\ongrid-edge\\secrets.enc",
		"Get-EventLog -LogName System -Newest 20",
		"Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq 'C:'",
		"Write-Output hello",
		"Start-Sleep -Seconds 1",
	}
	for _, cmd := range cases {
		if err := ValidateReadOnly(cmd); err != nil {
			t.Errorf("ValidateReadOnly(%q) = %v, want nil", cmd, err)
		}
	}
}

func TestValidateReadOnlyRejectsMutationsAndEscapes(t *testing.T) {
	cases := []string{
		"",
		"Stop-Service ongrid-edge",
		"Restart-Service ongrid-edge",
		"Set-Service ongrid-edge -StartupType Disabled",
		"Remove-Item C:\\temp\\x",
		"Invoke-Expression 'Get-Process'",
		"Get-Process; Stop-Service ongrid-edge",
		"Get-Process & calc.exe",
		"Get-Process | ForEach-Object { $_ }",
		"Get-ChildItem $(Get-Date)",
		"Get-Process > out.txt",
		"powershell -EncodedCommand ZQBjAGgAbwA=",
		"New-Object Net.WebClient",
		"Get-Process\nStop-Service ongrid-edge",
	}
	for _, cmd := range cases {
		if err := ValidateReadOnly(cmd); err == nil {
			t.Errorf("ValidateReadOnly(%q) = nil, want rejection", cmd)
		}
	}
}
