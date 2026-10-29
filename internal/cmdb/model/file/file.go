// Package file holds the CMDB file-attachment metadata and the two
// administrative configuration records (storage and preview).
package file

import (
	cmdbmodel "github.com/ongridio/ongrid/internal/cmdb/model"
)

// Configuration kinds. One row per kind keeps the encrypted payload small and
// makes a partial update independent between storage and preview.
const (
	KindStorage = "storage"
	KindPreview = "preview"
)

// Setting is one encrypted configuration document. Value holds
// secretbox.Encrypt(JSON); the plaintext never reaches the database.
type Setting struct {
	cmdbmodel.Base
	Kind  string `gorm:"column:kind;size:32;not null;uniqueIndex:idx_c_file_settings_kind"`
	Value string `gorm:"column:value;type:text;not null"`
}

func (Setting) TableName() string { return "c_file_settings" }

// File is the metadata row for one uploaded object.
//
// The object key is never accepted from a client. Upload creates this row,
// download/preview/delete address the file by FileID, and the handler resolves
// the key from here. That is what prevents an authenticated caller from
// reading an arbitrary S3 key or a path outside the local storage root.
type File struct {
	cmdbmodel.Base
	FileID         string `gorm:"column:file_id;size:64;not null;uniqueIndex:idx_c_files_file_id"`
	StoredPath     string `gorm:"column:stored_path;size:512;not null"`
	StorageBackend string `gorm:"column:storage_backend;size:16;not null"`
	OriginalName   string `gorm:"column:original_name;size:255;not null"`
	MimeType       string `gorm:"column:mime_type;size:128;not null"`
	Size           int64  `gorm:"column:size;not null"`
	SHA256         string `gorm:"column:sha256;size:64;not null"`
	UploadedBy     uint64 `gorm:"column:uploaded_by;not null;index:idx_c_files_uploaded_by"`
}

func (File) TableName() string { return "c_files" }
