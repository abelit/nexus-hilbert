package tunnel

// File transfer over a tunnel stream.
//
// The Manager writes one control line and the edge answers with one control
// line (plus raw bytes for get/put):
//
//	ONGRID-FILE {"op":"list"}\n
//	ONGRID-FILE-RESP {"ok":true,"files":[...]}\n
//
// The protocol lives in internal/pkg/tunnel so both the Manager and the edge
// can share the wire format without importing each other's packages.
const (
	FileStreamPreface              = "ONGRID-FILE "
	FileStreamResponsePrefix       = "ONGRID-FILE-RESP "
	FileStreamMaxSize        int64 = 2 << 30 // 2 GiB
)

// FileTransferRequest is the control line sent by the Manager.
type FileTransferRequest struct {
	Op   string `json:"op"`
	Name string `json:"name,omitempty"`
	Size int64  `json:"size,omitempty"`
}

// FileTransferFile describes one file in the sandbox.
type FileTransferFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

// FileTransferResponse is the control line returned by the edge.
type FileTransferResponse struct {
	OK    bool               `json:"ok"`
	Error string             `json:"error,omitempty"`
	Size  int64              `json:"size,omitempty"`
	Files []FileTransferFile `json:"files,omitempty"`
}
