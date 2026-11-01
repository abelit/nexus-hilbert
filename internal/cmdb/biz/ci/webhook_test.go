package ci

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

func TestSendWebhookBuildsTheConfiguredRequest(t *testing.T) {
	var gotMethod, gotQuery, gotHeader, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotQuery = r.URL.RawQuery
		gotHeader = r.Header.Get("X-Source")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method:     "POST",
		URL:        server.URL + "/hooks/cmdb?existing=1",
		Parameters: map[string]string{"env": "{{ env }}", "static": "yes"},
		Headers:    map[string]string{"X-Source": "cmdb-{{ env }}"},
		Body:       `{"host":"{{ hostname }}"}`,
	}, map[string]string{"env": "prod", "hostname": "web-01"})

	if !delivery.OK {
		t.Fatalf("delivery = %+v", delivery)
	}
	if delivery.Status != http.StatusOK || !strings.Contains(delivery.Response, "accepted") {
		t.Fatalf("delivery response = %+v", delivery)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q", gotMethod)
	}
	if !strings.Contains(gotQuery, "existing=1") || !strings.Contains(gotQuery, "env=prod") || !strings.Contains(gotQuery, "static=yes") {
		t.Fatalf("query = %q", gotQuery)
	}
	if gotHeader != "cmdb-prod" {
		t.Fatalf("header = %q", gotHeader)
	}
	if gotBody != `{"host":"web-01"}` {
		t.Fatalf("body = %q", gotBody)
	}
}

func TestSendWebhookAppliesBasicAuth(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType:      "BasicAuth",
		Authorization: map[string]string{"username": "ops", "password": "s3cret"},
	}, nil)
	if !delivery.OK {
		t.Fatalf("delivery = %+v", delivery)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops:s3cret"))
	if got != want {
		t.Fatalf("authorization = %q, want %q", got, want)
	}
}

func TestSendWebhookAppliesBearerAndAPIKey(t *testing.T) {
	var bearer, apiKeyAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer = r.Header.Get("Authorization")
		apiKeyAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType:      "Bearer",
		Authorization: map[string]string{"token": "abc"},
	}, nil); !delivery.OK {
		t.Fatalf("bearer delivery = %+v", delivery)
	}
	if bearer != "Bearer abc" {
		t.Fatalf("bearer = %q", bearer)
	}

	if delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType:      "APIKey",
		Authorization: map[string]string{"key": "X-Token", "value": "k-123"},
	}, nil); !delivery.OK {
		t.Fatalf("api key delivery = %+v", delivery)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("X-Token:k-123"))
	if apiKeyAuth != want {
		t.Fatalf("api key authorization = %q, want %q (cantor's HTTPBasicAuth)", apiKeyAuth, want)
	}
}

func TestSendWebhookReportsANon2xxResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream refused"))
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "POST", URL: server.URL,
	}, nil)
	if delivery.OK {
		t.Fatalf("delivery = %+v, want failure", delivery)
	}
	if delivery.Status != http.StatusBadGateway || !strings.Contains(delivery.Response, "upstream refused") {
		t.Fatalf("delivery = %+v", delivery)
	}
	if !strings.Contains(delivery.Error, "502") {
		t.Fatalf("error = %q", delivery.Error)
	}
}

func TestSendWebhookRefusesANonHTTPScheme(t *testing.T) {
	delivery := sendWebhook(context.Background(), http.DefaultClient, triggerWebhook{
		Method: "POST", URL: "file:///etc/passwd",
	}, nil)
	if delivery.OK || delivery.Error == "" {
		t.Fatalf("delivery = %+v, want a refused URL", delivery)
	}
}

func TestSendWebhookUsesOAuth2ClientCredentials(t *testing.T) {
	var tokenForm string
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		tokenForm = string(body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "oauth-token",
			"token_type":   "Bearer",
		})
	}))
	defer tokenServer.Close()

	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType: "OAuth2.0",
		Authorization: map[string]string{
			"client_id":     "client",
			"client_secret": "secret",
			"token_url":     tokenServer.URL,
			"scope":         "cmdb.write",
		},
	}, nil)
	if !delivery.OK {
		t.Fatalf("delivery = %+v", delivery)
	}
	if got != "Bearer oauth-token" {
		t.Fatalf("authorization = %q", got)
	}
	for _, want := range []string{"grant_type=client_credentials", "client_id=client", "client_secret=secret", "scope=cmdb.write"} {
		if !strings.Contains(tokenForm, want) {
			t.Fatalf("token form = %q, want %q", tokenForm, want)
		}
	}
}

func TestSendWebhookHonoursTheContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	delivery := sendWebhook(ctx, server.Client(), triggerWebhook{Method: "GET", URL: server.URL}, nil)
	if delivery.OK {
		t.Fatalf("delivery = %+v, want timeout failure", delivery)
	}
}

func TestWebhookHistoryStoresOnlyTheEndpointHost(t *testing.T) {
	// A Slack-style hook carries its secret in the path, not only the query.
	rawURL := "https://ops:s3cret@hooks.slack.com/services/T000/B000/SECRETPATH?token=abc123"
	payload, err := webhookHistoryFor(
		triggerWebhook{Method: "POST", URL: rawURL},
		webhookDelivery{OK: false, Error: `Post "` + rawURL + `": dial failed`},
		nil,
	)
	if err != nil {
		t.Fatalf("webhookHistoryFor: %v", err)
	}
	for _, leaked := range []string{"s3cret", "abc123", "SECRETPATH", "/services/"} {
		if strings.Contains(payload, leaked) {
			t.Fatalf("history leaked %q: %s", leaked, payload)
		}
	}
	if !strings.Contains(payload, "hooks.slack.com") {
		t.Fatalf("history lost the endpoint host: %s", payload)
	}
}

func TestSendWebhookAcceptsCantorsLowercaseAuthTypes(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType:      "basicauth",
		Authorization: map[string]string{"username": "ops", "password": "s3cret"},
	}, nil)
	if !delivery.OK {
		t.Fatalf("delivery = %+v", delivery)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops:s3cret"))
	if got != want {
		t.Fatalf("authorization = %q, want %q", got, want)
	}
}

func TestSendWebhookRefusesCloudMetadataEndpoints(t *testing.T) {
	for _, raw := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://[fd00:ec2::254]/latest/meta-data/",
		"http://100.100.100.200/latest/meta-data/",
	} {
		delivery := sendWebhook(context.Background(), http.DefaultClient, triggerWebhook{Method: "GET", URL: raw}, nil)
		if delivery.OK || delivery.Error == "" {
			t.Fatalf("%s: delivery = %+v, want the metadata endpoint refused", raw, delivery)
		}
	}
}

func TestWebhookHistoryRedactsAnUnparseableURL(t *testing.T) {
	rawURL := "http://[::1/secret-path?token=abc"
	payload, err := webhookHistoryFor(
		triggerWebhook{Method: "POST", URL: rawURL},
		webhookDelivery{OK: false, Error: `parse "` + rawURL + `": invalid port`},
		nil,
	)
	if err != nil {
		t.Fatalf("webhookHistoryFor: %v", err)
	}
	if strings.Contains(payload, "secret-path") || strings.Contains(payload, "abc") {
		t.Fatalf("history leaked an unparseable URL: %s", payload)
	}
}

func TestSendWebhookErrorRedactsTheURLPath(t *testing.T) {
	delivery := sendWebhook(context.Background(), &http.Client{Timeout: 200 * time.Millisecond}, triggerWebhook{
		Method: "POST", URL: "http://127.0.0.1:1/services/SECRETPATH",
	}, nil)
	if delivery.OK {
		t.Fatalf("delivery = %+v, want failure", delivery)
	}
	if strings.Contains(delivery.Error, "SECRETPATH") || strings.Contains(delivery.Error, "/services/") {
		t.Fatalf("error leaked the URL path: %q", delivery.Error)
	}
}

func TestSendWebhookKeepsAConfiguredAuthorizationHeaderWhenBasicValuesAreAbsent(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		Headers:       map[string]string{"Authorization": "Bearer header-token"},
		AuthType:      "BasicAuth",
		Authorization: map[string]string{"type": "BasicAuth"},
	}, nil)
	if !delivery.OK {
		t.Fatalf("delivery = %+v", delivery)
	}
	if got != "Bearer header-token" {
		t.Fatalf("authorization = %q, want the operator's header preserved", got)
	}
}

func TestSendWebhookRefusesBasicAuthWithoutCredentialsAndNoHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("the receiver must not be called")
	}))
	defer server.Close()

	delivery := sendWebhook(context.Background(), server.Client(), triggerWebhook{
		Method: "GET", URL: server.URL,
		AuthType:      "BasicAuth",
		Authorization: map[string]string{"type": "BasicAuth"},
	}, nil)
	if delivery.OK || !strings.Contains(delivery.Error, "username") {
		t.Fatalf("delivery = %+v, want a clear missing-credential error", delivery)
	}
}
