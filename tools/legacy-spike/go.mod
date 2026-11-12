module example.com/legacy-spike

go 1.20

require github.com/singchia/geminio v0.0.0

require (
	github.com/go-logr/logr v1.4.1 // indirect
	github.com/jumboframes/armorigo v0.4.1 // indirect
	github.com/singchia/go-timer/v2 v2.2.2 // indirect
	github.com/singchia/yafsm v1.0.1 // indirect
	k8s.io/klog/v2 v2.120.1 // indirect
)

replace github.com/singchia/geminio => ./third_party/geminio
