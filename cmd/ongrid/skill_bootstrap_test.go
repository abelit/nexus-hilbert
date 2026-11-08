package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestBuiltinDiagnosticAgentsCanUseCMDBTools(t *testing.T) {
	agents, err := filepath.Abs("../../agents")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ONGRID_BUILTIN_AGENTS_ROOT", agents)
	t.Setenv("ONGRID_BUILTIN_SKILLS_ROOT", "")
	t.Setenv("ONGRID_SKILLS_ROOT", filepath.Join(t.TempDir(), "missing"))

	_, personas := loadBootstrapRegistries(slog.Default())
	want := "cmdb_search_ci"
	for _, name := range []string{
		"incident-investigator", "specialist-compute", "specialist-disk",
		"specialist-network", "specialist-ops", "specialist-sre",
	} {
		def, ok := personas.ByName(name)
		if !ok {
			t.Fatalf("%s not loaded", name)
		}
		if !slices.Contains(def.Tools, want) {
			t.Fatalf("%s missing %s", name, want)
		}
		if !slices.Contains(def.Tools, "ToolSearch") {
			t.Fatalf("%s missing ToolSearch", name)
		}
	}
	if reviewer, ok := personas.ByName("reviewer"); ok && slices.Contains(reviewer.Tools, want) {
		t.Fatal("reviewer must not get CMDB tools")
	}
}

func TestBuiltinCMDBAssistantsAreDispatchable(t *testing.T) {
	agents, err := filepath.Abs("../../agents")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ONGRID_BUILTIN_AGENTS_ROOT", agents)
	t.Setenv("ONGRID_BUILTIN_SKILLS_ROOT", "")
	t.Setenv("ONGRID_SKILLS_ROOT", filepath.Join(t.TempDir(), "missing"))
	_, personas := loadBootstrapRegistries(slog.Default())

	cases := map[string]struct {
		capability string
		tools      []string
	}{
		"model-steward":   {"cmdb_model_explanation", []string{"cmdb_list_ci_types", "cmdb_get_ci_type", "cmdb_search_ci", "cmdb_get_ci", "cmdb_find_ci_type_path"}},
		"change-auditor":  {"cmdb_change_audit", []string{"cmdb_get_ci_history", "cmdb_get_ci", "cmdb_search_ci", "query_change_events"}},
		"ci-investigator": {"cmdb_dependency_triage", []string{"cmdb_search_ci", "cmdb_get_ci_relations", "cmdb_relation_graph", "expand_topology"}},
	}
	for name, want := range cases {
		def, ok := personas.ByName(name)
		if !ok {
			t.Fatalf("%s not loaded", name)
		}
		if def.PermissionMode != "read-only" {
			t.Fatalf("%s permission_mode = %q, want read-only", name, def.PermissionMode)
		}
		if len(def.Capabilities) == 0 || def.Capabilities[0].ID != want.capability {
			t.Fatalf("%s capabilities = %+v, want %s", name, def.Capabilities, want.capability)
		}
		for _, tool := range want.tools {
			if !slices.Contains(def.Tools, tool) {
				t.Fatalf("%s missing %s", name, tool)
			}
		}
	}
}

func TestLoadBootstrapRegistriesSkillRoots(t *testing.T) {
	fixtures, err := filepath.Abs("../../internal/manager/biz/aiops/runtime/v3/chatruntime/testdata")
	if err != nil {
		t.Fatal(err)
	}
	agents, err := filepath.Abs("../../agents")
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	if err := os.CopyFS("skills", os.DirFS(filepath.Join(fixtures, "skill_parser", "minimal"))); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ONGRID_BUILTIN_AGENTS_ROOT", agents)

	for _, tc := range []struct {
		name        string
		extraRoot   string
		marketplace string
		want        []string
	}{
		{"no packs", "", "missing", nil},
		{"marketplace only", "", filepath.Join(fixtures, "skill_registry", "multi", "always_skill"), []string{"always_skill"}},
		{"explicit extra root", "skills", filepath.Join(fixtures, "skill_registry", "multi", "always_skill"), []string{"always_skill", "hello_world"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ONGRID_BUILTIN_SKILLS_ROOT", tc.extraRoot)
			t.Setenv("ONGRID_SKILLS_ROOT", tc.marketplace)
			skills, personas := loadBootstrapRegistries(slog.Default())
			var names []string
			for _, skill := range skills.All() {
				names = append(names, skill.Name)
			}
			slices.Sort(names)
			if !slices.Equal(names, tc.want) {
				t.Fatalf("loaded skills = %v, want %v", names, tc.want)
			}
			if len(personas.All()) == 0 {
				t.Fatal("agent personas were not loaded")
			}
		})
	}
}
