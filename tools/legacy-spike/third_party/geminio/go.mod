module github.com/singchia/geminio

go 1.20

require (
	github.com/jumboframes/armorigo v0.4.1
	github.com/singchia/go-timer/v2 v2.2.2
	github.com/singchia/yafsm v1.0.1
)

require (
	github.com/go-logr/logr v1.4.1 // indirect
	k8s.io/klog/v2 v2.120.1 // indirect
)

// Pinned to the newest tagged releases whose go directive is still <= 1.20.
// The client-only spike does not import these packages today, but keeping the
// pins prevents MVS from selecting a Go 1.21+ release if the spike grows.
require (
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sys v0.28.0 // indirect
)
