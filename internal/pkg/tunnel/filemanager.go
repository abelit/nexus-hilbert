package tunnel

// Managed device file manager protocol.
//
// The Manager opens a stream and writes one control line:
//
//	ONGRID-FM {"op":"list","path":"C:\\data"}\n
//
// The edge answers with one control line:
//
//	ONGRID-FM-RESP {"ok":true,"entries":[...]}\n
//
// followed by raw bytes for download/upload. Unlike the transfer sandbox in
// tunnel/filetransfer.go, this protocol can browse any absolute path; write
// operations are restricted to the writable roots carried in the request.
const (
	FileManagerPreface        = "ONGRID-FM "
	FileManagerResponsePrefix = "ONGRID-FM-RESP "
)

// FileManagerRequest is the control line sent by the Manager.
type FileManagerRequest struct {
	Op         string   `json:"op"` // roots|list|download|upload|mkdir|rename
	Path       string   `json:"path,omitempty"`
	Target     string   `json:"target,omitempty"`
	Overwrite  bool     `json:"overwrite,omitempty"`
	UploadSize int64    `json:"size,omitempty"`
	Roots      []string `json:"roots,omitempty"` // extra writable roots (the edge sandbox is implicit)
}

// FileManagerRoot describes a volume or a writable root.
type FileManagerRoot struct {
	Path     string `json:"path"`
	Label    string `json:"label"`
	Kind     string `json:"kind"` // volume|root
	Writable bool   `json:"writable"`
}

// FileManagerEntry is one directory entry.
type FileManagerEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	Mode     string `json:"mode,omitempty"`
	Modified string `json:"modified,omitempty"`
	Symlink  bool   `json:"symlink,omitempty"`
}

// FileManagerResponse is the control line returned by the edge.
type FileManagerResponse struct {
	OK      bool               `json:"ok"`
	Error   string             `json:"error,omitempty"`
	Path    string             `json:"path,omitempty"`
	Entries []FileManagerEntry `json:"entries,omitempty"`
	Roots   []FileManagerRoot  `json:"roots,omitempty"`
	Size    int64              `json:"size,omitempty"`
	Archive bool               `json:"archive,omitempty"`
}
