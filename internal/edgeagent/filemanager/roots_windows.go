//go:build windows

package filemanager

import "golang.org/x/sys/windows"

func volumes() []string {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	out := make([]string, 0, 4)
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) != 0 {
			out = append(out, string(rune('A'+i))+`:\`)
		}
	}
	return out
}
