package ci

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
)

type fakeTriggerSource struct {
	configs []TriggerConfig
	byID    map[model.ID]TriggerConfig
}

func (f *fakeTriggerSource) TriggersForType(context.Context, model.ID) ([]TriggerConfig, error) {
	return f.configs, nil
}

func (f *fakeTriggerSource) TriggerByID(_ context.Context, id model.ID) (*TriggerConfig, error) {
	cfg, ok := f.byID[id]
	if !ok {
		return nil, nil
	}
	return &cfg, nil
}

type fakeTriggerMatcher struct {
	matched bool
	err     error
	calls   []string
}

func (f *fakeTriggerMatcher) InstanceMatches(_ context.Context, expr string, _ model.ID) (bool, error) {
	f.calls = append(f.calls, expr)
	return f.matched, f.err
}

type fakeTriggerHistory struct {
	mu   sync.Mutex
	rows []*cimodel.TriggerHistory
	ch   chan *cimodel.TriggerHistory
}

func (f *fakeTriggerHistory) InsertTriggerRecord(_ context.Context, row *cimodel.TriggerHistory) error {
	f.mu.Lock()
	f.rows = append(f.rows, row)
	f.mu.Unlock()
	if f.ch != nil {
		f.ch <- row
	}
	return nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func webhookTrigger(enable bool, url string) map[string]any {
	return map[string]any{
		"name":   "send hook",
		"enable": enable,
		"action": "2",
		"webhooks": map[string]any{
			"method": "POST",
			"url":    url,
			"body":   `{"host":"{{ hostname }}"}`,
		},
	}
}

func TestTriggerEnginePrepareMatchesEnabledWebhookRules(t *testing.T) {
	dateAttr := model.ID(21)
	matcher := &fakeTriggerMatcher{matched: true}
	source := &fakeTriggerSource{configs: []TriggerConfig{
		{ID: 1, TypeID: 7, Option: webhookTrigger(true, "https://example.test/one")},
		{ID: 2, TypeID: 7, Option: webhookTrigger(false, "https://example.test/disabled")},
		{ID: 3, TypeID: 7, AttrID: &dateAttr, Option: map[string]any{"name": "date"}},
		{ID: 4, TypeID: 7, Option: map[string]any{
			"name": "notify only", "enable": true, "action": "2",
			"notifies": map[string]any{"tos": []any{"ops@example.test"}},
		}},
		{ID: 5, TypeID: 7, Option: map[string]any{
			"name": "filtered", "enable": true, "action": "2",
			"filter":   "status:down",
			"webhooks": map[string]any{"method": "GET", "url": "https://example.test/filtered"},
		}},
	}}
	engine := NewTriggerEngine(matcher, source, &fakeTriggerHistory{}, discardLogger())
	defer func() { _ = engine.Close(context.Background()) }()

	firings, err := engine.Prepare(context.Background(), TriggerEvent{
		TypeID: 7, CIID: 42, Kind: model.OperateUpdate,
		ChangedAttrIDs: []model.ID{5},
		Values:         map[string]string{"hostname": "web-01"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(firings) != 2 {
		t.Fatalf("firings = %+v, want ids 1 and 5", firings)
	}
	if firings[0].TriggerID != 1 || firings[1].TriggerID != 5 {
		t.Fatalf("firings = %+v", firings)
	}
	if len(matcher.calls) != 1 || matcher.calls[0] != "status:down" {
		t.Fatalf("filter calls = %v", matcher.calls)
	}
}

func TestTriggerEngineSkipsAFilterThatDoesNotMatch(t *testing.T) {
	matcher := &fakeTriggerMatcher{matched: false}
	source := &fakeTriggerSource{configs: []TriggerConfig{{
		ID: 5, TypeID: 7,
		Option: map[string]any{
			"name": "filtered", "enable": true, "action": "0",
			"filter":   "status:down",
			"webhooks": map[string]any{"url": "https://example.test/filtered"},
		},
	}}}
	engine := NewTriggerEngine(matcher, source, &fakeTriggerHistory{}, discardLogger())
	defer func() { _ = engine.Close(context.Background()) }()

	firings, err := engine.Prepare(context.Background(), TriggerEvent{TypeID: 7, CIID: 42, Kind: model.OperateAdd})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(firings) != 0 {
		t.Fatalf("firings = %+v, want none", firings)
	}
}

func TestTriggerEngineSendWritesFiringHistory(t *testing.T) {
	var mu sync.Mutex
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	history := &fakeTriggerHistory{ch: make(chan *cimodel.TriggerHistory, 4)}
	source := &fakeTriggerSource{configs: []TriggerConfig{
		{ID: 1, TypeID: 7, Option: webhookTrigger(true, server.URL)},
		{ID: 2, TypeID: 7, Option: webhookTrigger(true, server.URL)},
	}}
	engine := NewTriggerEngine(&fakeTriggerMatcher{}, source, history, discardLogger())
	engine.WithHTTPClient(server.Client())
	defer func() { _ = engine.Close(context.Background()) }()

	firings, err := engine.Prepare(context.Background(), TriggerEvent{
		TypeID: 7, CIID: 42, RecordID: 99, Kind: model.OperateUpdate,
		Values: map[string]string{"hostname": "web-01"},
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	engine.Send(firings)

	got := map[model.ID]*cimodel.TriggerHistory{}
	for len(got) < 2 {
		select {
		case row := <-history.ch:
			got[*row.TriggerID] = row
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for firing history; got %d rows", len(got))
		}
	}
	for id, row := range got {
		if !row.IsOK {
			t.Fatalf("trigger %d row = %+v, want success", id, row)
		}
		if row.CIID != 42 || row.RecordID == nil || *row.RecordID != 99 {
			t.Fatalf("trigger %d row = %+v", id, row)
		}
		if row.TriggerName == nil || *row.TriggerName != "send hook" {
			t.Fatalf("trigger %d name = %v", id, row.TriggerName)
		}
		if row.Webhook == nil || !strings.Contains(*row.Webhook, server.URL) {
			t.Fatalf("trigger %d webhook history = %v", id, row.Webhook)
		}
		if strings.Contains(*row.Webhook, "hostname") {
			t.Fatalf("history leaked the request body: %q", *row.Webhook)
		}
		if strings.Contains(*row.Webhook, "accepted") {
			t.Fatalf("history stored the receiver response body: %q", *row.Webhook)
		}
	}

	mu.Lock()
	status = http.StatusInternalServerError
	mu.Unlock()
	firings, _ = engine.Prepare(context.Background(), TriggerEvent{
		TypeID: 7, CIID: 43, Kind: model.OperateUpdate,
		Values: map[string]string{"hostname": "web-02"},
	})
	engine.Send(firings)
	var failed *cimodel.TriggerHistory
	for failed == nil {
		select {
		case row := <-history.ch:
			if !row.IsOK {
				failed = row
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for a failed firing")
		}
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(*failed.Webhook), &payload); err != nil {
		t.Fatalf("decode webhook history: %v", err)
	}
	if payload["ok"] != false || !strings.Contains(*failed.Webhook, "500") {
		t.Fatalf("failed history = %s", *failed.Webhook)
	}
}

func TestTriggerEngineTestTriggerSendsSynchronously(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	history := &fakeTriggerHistory{}
	cfg := TriggerConfig{ID: 8, TypeID: 7, Option: webhookTrigger(false, server.URL)}
	engine := NewTriggerEngine(&fakeTriggerMatcher{}, &fakeTriggerSource{byID: map[model.ID]TriggerConfig{8: cfg}}, history, discardLogger())
	engine.WithHTTPClient(server.Client())
	defer func() { _ = engine.Close(context.Background()) }()

	if err := engine.TestTrigger(context.Background(), 8); err != nil {
		t.Fatalf("TestTrigger: %v", err)
	}
	if len(history.rows) != 1 || !history.rows[0].IsOK {
		t.Fatalf("history = %+v", history.rows)
	}
	if history.rows[0].CIID != 0 {
		t.Fatalf("test firing CIID = %d, want 0", history.rows[0].CIID)
	}
}

func TestTriggerEngineTestTriggerRefusesANonWebhookRule(t *testing.T) {
	cfg := TriggerConfig{ID: 8, TypeID: 7, Option: map[string]any{
		"name": "notify", "enable": true, "action": "0",
		"notifies": map[string]any{"tos": []any{"ops@example.test"}},
	}}
	engine := NewTriggerEngine(&fakeTriggerMatcher{}, &fakeTriggerSource{byID: map[model.ID]TriggerConfig{8: cfg}}, &fakeTriggerHistory{}, discardLogger())
	defer func() { _ = engine.Close(context.Background()) }()
	if err := engine.TestTrigger(context.Background(), 8); err == nil {
		t.Fatal("TestTrigger() = nil error, want the notification-only rule refused")
	}
}

func TestTriggerEngineTestTriggerRefusesADateRule(t *testing.T) {
	dateAttr := model.ID(21)
	cfg := TriggerConfig{ID: 8, TypeID: 7, AttrID: &dateAttr, Option: map[string]any{"name": "date"}}
	engine := NewTriggerEngine(&fakeTriggerMatcher{}, &fakeTriggerSource{byID: map[model.ID]TriggerConfig{8: cfg}}, &fakeTriggerHistory{}, discardLogger())
	defer func() { _ = engine.Close(context.Background()) }()
	if err := engine.TestTrigger(context.Background(), 8); err == nil {
		t.Fatal("TestTrigger() = nil error, want the date rule refused")
	}
}

type fakeTriggerSample struct {
	event TriggerEvent
	err   error
}

func (f *fakeTriggerSample) LatestTriggerEvent(context.Context, model.ID) (TriggerEvent, error) {
	return f.event, f.err
}

func TestTriggerEngineTestTriggerUsesASampleInstanceAndRecordsNoAction(t *testing.T) {
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	history := &fakeTriggerHistory{}
	cfg := TriggerConfig{ID: 8, TypeID: 7, Option: webhookTrigger(true, server.URL)}
	engine := NewTriggerEngine(&fakeTriggerMatcher{}, &fakeTriggerSource{byID: map[model.ID]TriggerConfig{8: cfg}}, history, discardLogger()).
		WithHTTPClient(server.Client()).
		WithSampleSource(&fakeTriggerSample{event: TriggerEvent{
			TypeID: 7, CIID: 42, Values: map[string]string{"hostname": "web-01"},
		}})
	defer func() { _ = engine.Close(context.Background()) }()

	if err := engine.TestTrigger(context.Background(), 8); err != nil {
		t.Fatalf("TestTrigger: %v", err)
	}
	if body != `{"host":"web-01"}` {
		t.Fatalf("body = %q, want the sample rendered", body)
	}
	if len(history.rows) != 1 {
		t.Fatalf("history = %+v", history.rows)
	}
	row := history.rows[0]
	if row.CIID != 42 || row.OperateType != nil {
		t.Fatalf("test firing row = %+v, want the sample ci and no action", row)
	}
}

func TestNewTriggerEngineIgnoresEnvironmentProxies(t *testing.T) {
	engine := NewTriggerEngine(nil, nil, nil, discardLogger())
	transport, ok := engine.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T", engine.client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("trigger webhooks must not inherit HTTP_PROXY/HTTPS_PROXY")
	}
}
