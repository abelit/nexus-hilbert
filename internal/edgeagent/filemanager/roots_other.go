//go:build !windows

package filemanager

func volumes() []string { return []string{"/"} }
