package topology

import (
	"context"
	"errors"
	"testing"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
)

// The graph walk: roots, the declared levels, deduplication and the bounds.
//
// A GRAPH IS A SET OF NODES AND A SET OF EDGES, not a tree. The same instance
// reachable two ways appears once; the same edge seen from both ends appears
// once; a self-loop appears never. cantor's walk kept a `visited` set and a
// `seen_links` set for exactly this, and the port keeps both.

type stubGraph struct {
	roots    []Node
	children map[model.ID][]GraphEdge
	parents  map[model.ID][]GraphEdge
	names    map[model.ID]string
	icons    map[model.ID]string

	rootLimit int
}

func (s *stubGraph) Roots(_ context.Context, _ model.ID, _ string, limit int) ([]Node, error) {
	s.rootLimit = limit
	return s.roots, nil
}

func (s *stubGraph) Children(_ context.Context, ids []model.ID) ([]GraphEdge, error) {
	out := []GraphEdge{}
	for _, id := range ids {
		out = append(out, s.children[id]...)
	}
	return out, nil
}

func (s *stubGraph) Parents(_ context.Context, ids []model.ID) ([]GraphEdge, error) {
	out := []GraphEdge{}
	for _, id := range ids {
		out = append(out, s.parents[id]...)
	}
	return out, nil
}

func (s *stubGraph) Names(_ context.Context, ids []model.ID) (map[model.ID]string, error) {
	out := map[model.ID]string{}
	for _, id := range ids {
		if name, ok := s.names[id]; ok {
			out[id] = name
		}
	}
	return out, nil
}

func (s *stubGraph) Icons(_ context.Context, typeIDs []model.ID) (map[model.ID]string, error) {
	out := map[model.ID]string{}
	for _, id := range typeIDs {
		if icon, ok := s.icons[id]; ok {
			out[id] = icon
		}
	}
	return out, nil
}

func graphFixture() *stubGraph {
	return &stubGraph{
		roots: []Node{
			{ID: 100, TypeID: 1, Name: "web-01"},
			{ID: 101, TypeID: 1, Name: "web-02"},
		},
		children: map[model.ID][]GraphEdge{
			100: {
				{From: 100, To: 200, FromTypeID: 1, ToTypeID: 2},
				{From: 100, To: 100, FromTypeID: 1, ToTypeID: 1}, // self-loop
				{From: 100, To: 300, FromTypeID: 1, ToTypeID: 3}, // undeclared level type
			},
			101: {
				{From: 101, To: 200, FromTypeID: 1, ToTypeID: 2},
			},
		},
		parents: map[model.ID][]GraphEdge{
			200: {
				{From: 400, To: 200, FromTypeID: 4, ToTypeID: 2},
			},
		},
		names: map[model.ID]string{200: "sw-01", 400: "dc-01"},
		icons: map[model.ID]string{1: "icon-host", 2: "icon-switch", 4: "icon-dc"},
	}
}

func TestBuildGraphWalksBothDirectionsAndDeduplicates(t *testing.T) {
	q := graphFixture()
	got, err := BuildGraph(context.Background(), q, GraphInput{
		CentralNodeType:      1,
		CentralNodeInstances: "web",
		Path: map[string][]model.ID{
			"1":  {2},
			"-1": {4},
		},
	})
	if err != nil {
		t.Fatalf("BuildGraph: %v", err)
	}
	if q.rootLimit != MaxRoots+1 {
		t.Fatalf("root limit = %d, want %d to detect an overflow", q.rootLimit, MaxRoots+1)
	}
	if len(got.Nodes) != 4 {
		t.Fatalf("nodes = %+v, want 4", got.Nodes)
	}
	byID := map[model.ID]Node{}
	for _, node := range got.Nodes {
		byID[node.ID] = node
	}
	if byID[200].Name != "sw-01" || byID[400].Name != "dc-01" {
		t.Fatalf("names were not filled: %+v", byID)
	}
	if byID[100].Name != "web-01" || byID[101].Name != "web-02" {
		t.Fatalf("root names were lost: %+v", byID)
	}
	if len(got.Links) != 2 {
		t.Fatalf("links = %+v, want the downward and upward edge once each", got.Links)
	}
	if got.Links[0].From != 100 || got.Links[0].To != 200 {
		t.Fatalf("first link = %+v, want 100→200", got.Links[0])
	}
	if got.Links[1].From != 400 || got.Links[1].To != 200 {
		t.Fatalf("second link = %+v, want 400→200", got.Links[1])
	}
	if got.Type2Meta[1] != "icon-host" || got.Type2Meta[2] != "icon-switch" || got.Type2Meta[4] != "icon-dc" {
		t.Fatalf("type2meta = %+v", got.Type2Meta)
	}
}

func TestBuildGraphRefusesTooManyRoots(t *testing.T) {
	q := graphFixture()
	q.roots = make([]Node, MaxRoots+1)
	_, err := BuildGraph(context.Background(), q, GraphInput{CentralNodeType: 1})
	if !errors.Is(err, ErrGraphTooLarge) {
		t.Fatalf("err = %v, want ErrGraphTooLarge", err)
	}
}

func TestBuildGraphRefusesATooDeepPath(t *testing.T) {
	q := graphFixture()
	_, err := BuildGraph(context.Background(), q, GraphInput{
		CentralNodeType: 1,
		Path:            map[string][]model.ID{"6": {2}},
	})
	if !errors.Is(err, ErrGraphTooLarge) {
		t.Fatalf("err = %v, want ErrGraphTooLarge", err)
	}
}

func TestBuildGraphRefusesTooManyNodes(t *testing.T) {
	q := graphFixture()
	edges := make([]GraphEdge, 0, MaxNodes+1)
	for i := 0; i <= MaxNodes; i++ {
		edges = append(edges, GraphEdge{
			From: 100, To: model.ID(1000 + i), FromTypeID: 1, ToTypeID: 2,
		})
	}
	q.children = map[model.ID][]GraphEdge{100: edges}
	q.roots = []Node{{ID: 100, TypeID: 1, Name: "web-01"}}
	_, err := BuildGraph(context.Background(), q, GraphInput{
		CentralNodeType: 1,
		Path:            map[string][]model.ID{"1": {2}},
	})
	if !errors.Is(err, ErrGraphTooLarge) {
		t.Fatalf("err = %v, want ErrGraphTooLarge", err)
	}
}
