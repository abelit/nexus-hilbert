package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	bizconnector "github.com/ongridio/ongrid/internal/cmdb/biz/connector"
)

func TestEnsureRelationDeclarationCreates(t *testing.T) {
	var posted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet:
			http.NotFound(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/ontology/relations":
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Fatalf("decode POST: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"code":201,"message":"success","data":{}}`))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	created, err := client.EnsureRelationDeclaration(context.Background(), bizconnector.Declaration{
		RelationType: "RUNS_ON", SourceClass: "Pod", TargetClass: "Node",
		Cardinality: "N:1", Propagates: true, Weight: 1.0,
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if !created {
		t.Fatal("created = false, want true")
	}
	if posted["relation_type"] != "RUNS_ON" || posted["source_class"] != "Pod" ||
		posted["target_class"] != "Node" || posted["cardinality"] != "N:1" ||
		posted["propagates"] != true || posted["weight"] != 1.0 ||
		posted["allow_new_type"] != true {
		t.Fatalf("POST body = %+v", posted)
	}
}

func TestEnsureRelationDeclarationUpdatesWithoutWeightForAssociation(t *testing.T) {
	var patched map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{}}`))
		case http.MethodPatch:
			if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
				t.Fatalf("decode PATCH: %v", err)
			}
			_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{}}`))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	created, err := client.EnsureRelationDeclaration(context.Background(), bizconnector.Declaration{
		RelationType: "MONITORING_OF", SourceClass: "Metric", TargetClass: "Host",
		Cardinality: "N:1", Propagates: false, Weight: 0,
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if created {
		t.Fatal("created = true, want false")
	}
	if patched["propagates"] != false || patched["cardinality"] != "N:1" {
		t.Fatalf("PATCH body = %+v", patched)
	}
	if _, ok := patched["weight"]; ok {
		t.Fatalf("PATCH must omit weight for a non-propagating edge: %+v", patched)
	}
}

func TestEnsureRelationTypePatches(t *testing.T) {
	var patched map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/v1/ontology/relation-types/PART_OF" {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
			t.Fatalf("decode PATCH: %v", err)
		}
		_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{}}`))
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	err := client.EnsureRelationType(context.Background(), bizconnector.RelationType{
		Name: "PART_OF", Category: "association",
		Traits: []string{"structural_rollup"}, Transitive: true,
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if patched["category"] != "association" || patched["transitive"] != true {
		t.Fatalf("PATCH body = %+v", patched)
	}
	traits, ok := patched["traits"].([]any)
	if !ok || len(traits) != 1 || traits[0] != "structural_rollup" {
		t.Fatalf("traits = %#v", patched["traits"])
	}
}

func TestEnsureRelationTypeMissingIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	if err := client.EnsureRelationType(context.Background(), bizconnector.RelationType{Name: "PART_OF"}); err == nil {
		t.Fatal("a missing relation type must fail: the declaration was not created")
	}
}

func TestErrorIncludesStatusAndBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":409,"message":"CARDINALITY_VIOLATION"}`))
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	_, err := client.EnsureRelationDeclaration(context.Background(), bizconnector.Declaration{
		RelationType: "RUNS_ON", SourceClass: "Pod", TargetClass: "Node",
	})
	if err == nil || !strings.Contains(err.Error(), "409") ||
		!strings.Contains(err.Error(), "CARDINALITY_VIOLATION") {
		t.Fatalf("error = %v", err)
	}
}
