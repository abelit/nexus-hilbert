package flow

import (
	"testing"

	aiopstools "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools"
	cmdb "github.com/ongridio/ongrid/internal/manager/biz/aiops/tools/cmdb"
)

func TestExecuteK8sActionIsExcludedFromWorkflowToolPalette(t *testing.T) {
	if !isFlowRuntimeUnsupportedTool(aiopstools.ToolNameExecuteK8sAction) {
		t.Fatalf("%q should be excluded from flow paths without ReviewGate", aiopstools.ToolNameExecuteK8sAction)
	}
}

func TestCMDBToolsShareOnePaletteCategory(t *testing.T) {
	for _, name := range []string{
		cmdb.ToolNameSearchCI,
		cmdb.ToolNameListCITypes,
		cmdb.ToolNameGetCIHistory,
		cmdb.ToolNameRelationGraph,
	} {
		if got := categorizeFlowTool(name); got != "cmdb" {
			t.Fatalf("categorizeFlowTool(%q) = %q, want cmdb", name, got)
		}
	}
}

func TestMessagingToolsAreSharedWithWorkflowToolPalette(t *testing.T) {
	for _, name := range []string{aiopstools.ToolNameSendNotification, aiopstools.ToolNameSendIMMessage} {
		if isWorkflowPaletteExcludedTool(name) {
			t.Fatalf("%q must be available to workflow tool nodes", name)
		}
		if isFlowRuntimeUnsupportedTool(name) {
			t.Fatalf("%q must remain runnable for saved workflows", name)
		}
	}
}
