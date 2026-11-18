package fedclient

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestClient(t *testing.T, srv *httptest.Server, mutate func(*Config)) *Client {
	t.Helper()
	cfg := Config{
		BaseURL:     srv.URL,
		APIPath:     "/api/v1/alerts",
		AuthType:    "bearer",
		Auth:        AuthData{Token: "tok"},
		PageSizeCap: 500,
		Timeout:     2 * time.Second,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func writeEnvelope(w http.ResponseWriter, data string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"status":"success","message":"","data":`+data+`}`)
}

func TestQuerySendsBearerAndRepeatedFilters(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		writeEnvelope(w, `{"table":"alert_instances","time_range":"7d","total":2,"page":1,"page_size":50,"pages":1,"items":[{"_id":"a"},{"_id":"b"}]}`)
	}))
	defer srv.Close()

	page, err := newTestClient(t, srv, nil).Query(context.Background(), Query{
		Days:      7,
		Filters:   []string{"status:eq:firing", "alert.labels.severity:eq:critical"},
		OrFilters: []string{"alert.labels.host:eq:web-1"},
		Page:      1,
		PageSize:  50,
	})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if got.Header.Get("Authorization") != "Bearer tok" {
		t.Fatalf("Authorization = %q", got.Header.Get("Authorization"))
	}
	q := got.URL.Query()
	if got.Method != http.MethodGet {
		t.Fatalf("method = %s", got.Method)
	}
	if got.URL.Path != "/api/v1/alerts" {
		t.Fatalf("path = %s", got.URL.Path)
	}
	if q.Get("table") != "alert_instances" || q.Get("days") != "7" || q.Get("page") != "1" || q.Get("page_size") != "50" {
		t.Fatalf("query = %v", q)
	}
	if len(q["filter"]) != 2 || len(q["or_filter"]) != 1 {
		t.Fatalf("repeated filters lost: %v", q)
	}
	if page.Total != 2 || page.Page != 1 || page.PageSize != 50 || page.Pages != 1 || len(page.Items) != 2 {
		t.Fatalf("page = %+v", page)
	}
	if string(page.Items[0]) != `{"_id":"a"}` {
		t.Fatalf("item = %s", page.Items[0])
	}
}

func TestQueryFixedParamsWin(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		writeEnvelope(w, `{"total":0,"page":1,"page_size":25,"pages":0,"items":[]}`)
	}))
	defer srv.Close()

	client := newTestClient(t, srv, func(c *Config) {
		c.FixedParams = map[string][]string{
			"table":     {"pinned_table"},
			"page_size": {"25"},
		}
	})
	if _, err := client.Query(context.Background(), Query{Table: "dynamic", Days: 7, Page: 1, PageSize: 50}); err != nil {
		t.Fatalf("Query: %v", err)
	}
	q := got.URL.Query()
	if q.Get("table") != "pinned_table" {
		t.Fatalf("fixed table lost: %v", q)
	}
	if q.Get("page_size") != "25" {
		t.Fatalf("fixed page_size lost: %v", q)
	}
}

func TestQueryClampsPageSizeToCap(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		writeEnvelope(w, `{"total":0,"page":1,"page_size":500,"pages":0,"items":[]}`)
	}))
	defer srv.Close()

	page, err := newTestClient(t, srv, nil).Query(context.Background(), Query{Days: 7, Page: 0, PageSize: 9999})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if got.URL.Query().Get("page_size") != "500" {
		t.Fatalf("page_size = %s", got.URL.Query().Get("page_size"))
	}
	if got.URL.Query().Get("page") != "1" {
		t.Fatalf("page = %s", got.URL.Query().Get("page"))
	}
	if page.PageSize != 500 || page.Page != 1 {
		t.Fatalf("page = %+v", page)
	}
}

func TestQueryAcceptsTotalPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, `{"total":7,"page":2,"page_size":20,"total_pages":4,"items":null}`)
	}))
	defer srv.Close()

	page, err := newTestClient(t, srv, nil).Query(context.Background(), Query{Days: 7, Page: 2, PageSize: 20})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if page.Pages != 4 {
		t.Fatalf("Pages = %d", page.Pages)
	}
	if page.Items == nil {
		t.Fatal("Items must be an empty slice, not nil")
	}
}

func TestProbeAlwaysGETEvenWhenQueryMethodIsPOST(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		writeEnvelope(w, `{"total":0,"page":1,"page_size":1,"items":[]}`)
	}))
	defer srv.Close()

	client := newTestClient(t, srv, func(c *Config) { c.Method = "POST" })
	if err := client.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if got.Method != http.MethodGet {
		t.Fatalf("probe method = %s", got.Method)
	}
	if got.URL.Query().Get("page_size") != "1" {
		t.Fatalf("probe query = %v", got.URL.Query())
	}
}

func TestQueryPOSTSendsJSONBodyWithRepeatedFilters(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("body: %v (%s)", err, raw)
		}
		writeEnvelope(w, `{"total":0,"page":1,"page_size":50,"items":[]}`)
	}))
	defer srv.Close()

	client := newTestClient(t, srv, func(c *Config) { c.Method = "POST" })
	if _, err := client.Query(context.Background(), Query{
		Days: 7, Page: 1, PageSize: 50,
		Filters: []string{"a:eq:1", "b:eq:2"},
	}); err != nil {
		t.Fatalf("Query: %v", err)
	}
	if body["table"] != "alert_instances" {
		t.Fatalf("body table = %v", body["table"])
	}
	filters, ok := body["filter"].([]any)
	if !ok || len(filters) != 2 {
		t.Fatalf("body filter = %#v", body["filter"])
	}
}

func TestQueryBasicAuth(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		writeEnvelope(w, `{"total":0,"page":1,"page_size":50,"items":[]}`)
	}))
	defer srv.Close()

	client := newTestClient(t, srv, func(c *Config) {
		c.AuthType = "basic"
		c.Auth = AuthData{Username: "bob", Password: "s3cret"}
	})
	if _, err := client.Query(context.Background(), Query{Days: 7, Page: 1, PageSize: 50}); err != nil {
		t.Fatalf("Query: %v", err)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("bob:s3cret"))
	if auth != want {
		t.Fatalf("Authorization = %q, want %q", auth, want)
	}
}

func TestQueryUpstreamErrorIsScrubbed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `boom token=tok password=s3cret basic=`+
			base64.StdEncoding.EncodeToString([]byte("bob:s3cret")))
	}))
	defer srv.Close()

	client := newTestClient(t, srv, func(c *Config) {
		c.AuthType = "bearer"
		c.Auth = AuthData{Token: "tok", Username: "bob", Password: "s3cret"}
	})
	_, err := client.Query(context.Background(), Query{Days: 7, Page: 1, PageSize: 50})
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	for _, secret := range []string{"tok", "s3cret", base64.StdEncoding.EncodeToString([]byte("bob:s3cret"))} {
		if strings.Contains(msg, secret) {
			t.Fatalf("error leaks %q: %s", secret, msg)
		}
	}
	if !strings.Contains(msg, "502") {
		t.Fatalf("error should name the status: %s", msg)
	}
}

func TestQueryRejectsNonSuccessEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"error","message":"bad query"}`)
	}))
	defer srv.Close()

	_, err := newTestClient(t, srv, nil).Query(context.Background(), Query{Days: 7, Page: 1, PageSize: 50})
	if err == nil || !strings.Contains(err.Error(), "bad query") {
		t.Fatalf("err = %v", err)
	}
}

func TestQueryHonorsContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writeEnvelope(w, `{"total":0,"page":1,"page_size":50,"items":[]}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := newTestClient(t, srv, nil).Query(ctx, Query{Days: 7, Page: 1, PageSize: 50})
	if err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestNewRejectsMissingEndpoint(t *testing.T) {
	if _, err := New(Config{BaseURL: "http://x"}); err == nil {
		t.Fatal("expected missing api path error")
	}
	if _, err := New(Config{APIPath: "/a"}); err == nil {
		t.Fatal("expected missing base url error")
	}
}

func TestNewRejectsUserinfoInBaseURL(t *testing.T) {
	if _, err := New(Config{BaseURL: "http://user:pass@x", APIPath: "/a"}); err == nil {
		t.Fatal("expected userinfo rejection")
	}
}

func TestScrubRemovesRawAndControlStrippedSecrets(t *testing.T) {
	auth := AuthData{Token: "tok\n", Username: "bob", Password: "s3cret"}
	blob := base64.StdEncoding.EncodeToString([]byte("bob:s3cret"))
	in := "token=tok stripped=tok\n pass=s3cret basic=" + blob
	out := Scrub(in, auth)
	for _, secret := range []string{"tok", "s3cret", blob} {
		if strings.Contains(out, secret) {
			t.Fatalf("Scrub left %q in %q", secret, out)
		}
	}
}
