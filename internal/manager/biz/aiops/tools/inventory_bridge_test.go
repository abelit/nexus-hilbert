package tools

import "testing"

func TestClassifyToolCategoryGroupsKubernetesToolsIntoExistingCategories(t *testing.T) {
	tests := map[string]string{
		"query_k8s_snapshot":    "telemetry",
		"describe_k8s_resource": "telemetry",
		"query_k8s_logs":        "telemetry",
		"execute_k8s_action":    "other",
	}

	for name, want := range tests {
		if got := classifyToolCategory(name); got != want {
			t.Fatalf("classifyToolCategory(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestClassifyToolCategoryGroupsNetworkInventoryToolsIntoNetwork(t *testing.T) {
	for _, name := range []string{"query_network_devices", "query_network_interfaces", "get_network_neighbors"} {
		if got := classifyToolCategory(name); got != "network" {
			t.Fatalf("classifyToolCategory(%q) = %q, want network", name, got)
		}
	}
}

func TestClassifyToolCategoryGroupsCMDBTools(t *testing.T) {
	for _, name := range []string{"cmdb_search_ci", "cmdb_get_ci", "cmdb_relation_graph"} {
		if got := classifyToolCategory(name); got != "cmdb" {
			t.Fatalf("classifyToolCategory(%q) = %q, want cmdb", name, got)
		}
	}
}
