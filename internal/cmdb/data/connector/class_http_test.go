package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
)

func classBody(class classmap.Class) string {
	return `{"code":200,"message":"success","data":` + mustJSON(class) + `}`
}

func mustJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func TestEnsureClassCreates(t *testing.T) {
	var posted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet:
			http.NotFound(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/ontology/classes":
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Fatalf("decode POST: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(classBody(classmap.Class{ClassName: "Rack"})))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	created, err := client.EnsureClass(context.Background(), classmap.Class{
		ClassName: "Rack", ParentClass: "Room",
		Attributes:   map[string]string{"rack_name": "string"},
		IdentityKeys: []string{"rack_name"},
	})
	if err != nil {
		t.Fatalf("EnsureClass() error = %v", err)
	}
	if !created {
		t.Fatal("created = false, want true")
	}
	if posted["class_name"] != "Rack" || posted["parent_class"] != "Room" {
		t.Fatalf("POST body = %+v", posted)
	}
	attrs, ok := posted["attributes"].(map[string]any)
	if !ok || attrs["rack_name"] != "string" {
		t.Fatalf("attributes = %#v", posted["attributes"])
	}
}

func TestEnsureClassUpdatesAddsAttributeThenPatches(t *testing.T) {
	var attributePosted map[string]any
	var patched map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(classBody(classmap.Class{
				ClassName: "Rack", ParentClass: "Room",
				Attributes: map[string]string{"rack_name": "string"},
			})))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/ontology/classes/Rack/attributes":
			if err := json.NewDecoder(r.Body).Decode(&attributePosted); err != nil {
				t.Fatalf("decode attribute POST: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"code":201,"message":"success","data":{}}`))
		case r.Method == http.MethodPatch && r.URL.Path == "/api/v1/ontology/classes/Rack":
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
	created, err := client.EnsureClass(context.Background(), classmap.Class{
		ClassName: "Rack", ParentClass: "Room",
		Attributes: map[string]string{
			"rack_name": "string",
			"u_count":   "int",
		},
		IdentityKeys: []string{"rack_name"},
		Roles:        []string{"infrastructure"},
	})
	if err != nil {
		t.Fatalf("EnsureClass() error = %v", err)
	}
	if created {
		t.Fatal("created = true, want false")
	}
	if attributePosted["attribute"] != "u_count" || attributePosted["type"] != "int" {
		t.Fatalf("attribute POST = %+v", attributePosted)
	}
	if _, ok := patched["parent_class"]; ok {
		t.Fatalf("PATCH must not send parent_class: %+v", patched)
	}
	if _, ok := patched["abstract"]; ok {
		t.Fatalf("PATCH must not send abstract: %+v", patched)
	}
	if keys, ok := patched["identity_keys"].([]any); !ok || len(keys) != 1 || keys[0] != "rack_name" {
		t.Fatalf("identity_keys = %#v", patched["identity_keys"])
	}
	if roles, ok := patched["roles"].([]any); !ok || len(roles) != 1 || roles[0] != "infrastructure" {
		t.Fatalf("roles = %#v", patched["roles"])
	}
}

func TestEnsureClassRejectsParentConflict(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(classBody(classmap.Class{
			ClassName: "Rack", ParentClass: "OtherRoom",
		})))
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	_, err := client.EnsureClass(context.Background(), classmap.Class{
		ClassName: "Rack", ParentClass: "Room",
	})
	if err == nil || !strings.Contains(err.Error(), "parent") {
		t.Fatalf("error = %v, want a parent conflict", err)
	}
}

func TestEnsureClassRejectsAttributeTypeConflict(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(classBody(classmap.Class{
			ClassName: "Rack", Attributes: map[string]string{"u_count": "string"},
		})))
	}))
	defer server.Close()

	client := New(server.URL, server.Client())
	_, err := client.EnsureClass(context.Background(), classmap.Class{
		ClassName: "Rack", Attributes: map[string]string{"u_count": "int"},
	})
	if err == nil || !strings.Contains(err.Error(), "type") {
		t.Fatalf("error = %v, want an attribute type conflict", err)
	}
}
