package ci

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// webhookDelivery is one outbound attempt's outcome.
//
// The response is BOUNDED and used for diagnostics in-process; it is not part
// of the firing history. The request's credentials are deliberately not part of
// this value either, and an error string is sanitised before it is stored.
type webhookDelivery struct {
	OK       bool
	Status   int
	Response string
	Error    string
	Duration time.Duration
}

const webhookResponseLimit = 8 << 10

// sendWebhook performs one configured request.
//
// THE CONFIGURATION IS ADMIN-ONLY INPUT, so the URL is not restricted to a
// public network here: an on-premise CMDB routinely calls internal automation
// endpoints. What is enforced is what can be enforced without breaking that
// use — an http/https scheme, a bounded response, a caller's deadline, and no
// redirect following (a redirect would let the receiver move a request carrying
// an API key to a host the operator did not configure).
func sendWebhook(ctx context.Context, client *http.Client, webhook triggerWebhook, values map[string]string) webhookDelivery {
	started := time.Now()
	delivery := webhookDelivery{}
	finish := func() webhookDelivery {
		delivery.Duration = time.Since(started)
		if delivery.Error != "" {
			delivery.Error = redactWebhookURLs(delivery.Error)
		}
		return delivery
	}

	target := renderTriggerTemplate(webhook.URL, values)
	parsed, err := url.Parse(strings.TrimSpace(target))
	if err != nil {
		delivery.Error = fmt.Sprintf("invalid webhook url: %v", err)
		return finish()
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		delivery.Error = fmt.Sprintf("webhook url scheme %q is not http or https", parsed.Scheme)
		return finish()
	}
	if parsed.Host == "" {
		delivery.Error = "webhook url has no host"
		return finish()
	}
	if isCloudMetadataHost(parsed.Hostname()) {
		// An administrator configures these URLs, but a copied-in address must
		// not turn a hook into a cloud credential exfiltration request.
		delivery.Error = "webhook url points at a cloud metadata endpoint"
		return finish()
	}
	query := parsed.Query()
	for key, value := range webhook.Parameters {
		query.Set(key, renderTriggerTemplate(value, values))
	}
	parsed.RawQuery = query.Encode()

	method := strings.ToUpper(strings.TrimSpace(webhook.Method))
	if method == "" {
		method = http.MethodGet
	}
	body := renderTriggerTemplate(webhook.Body, values)
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, parsed.String(), reader)
	if err != nil {
		delivery.Error = fmt.Sprintf("build webhook request: %v", err)
		return finish()
	}

	for key, value := range webhook.Headers {
		req.Header.Set(key, renderTriggerTemplate(value, values))
	}
	if body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if err := applyWebhookAuth(ctx, client, req, webhook); err != nil {
		delivery.Error = err.Error()
		return finish()
	}

	httpClient := client
	if httpClient == nil {
		httpClient = newTriggerHTTPClient()
	} else {
		copy := *httpClient
		if copy.CheckRedirect == nil {
			copy.CheckRedirect = func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			}
		}
		httpClient = &copy
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		delivery.Error = fmt.Sprintf("webhook request: %v", err)
		return finish()
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, webhookResponseLimit))
	if err != nil {
		delivery.Error = fmt.Sprintf("read webhook response: %v", err)
		return finish()
	}
	delivery.Status = resp.StatusCode
	delivery.Response = string(raw)
	delivery.OK = resp.StatusCode >= 200 && resp.StatusCode < 300
	if !delivery.OK {
		delivery.Error = fmt.Sprintf("webhook returned %s", resp.Status)
	}
	return finish()
}

// applyWebhookAuth sets the one credential the operator configured. An unknown
// type is refused rather than sent unauthenticated: a trigger that silently
// loses its credential is indistinguishable from one the receiver rejects.
func applyWebhookAuth(ctx context.Context, client *http.Client, req *http.Request, webhook triggerWebhook) error {
	authType := strings.TrimSpace(webhook.AuthType)
	if authType == "" {
		authType = strings.TrimSpace(webhook.Authorization["type"])
	}
	// An operator may have put the credential in the Headers tab instead of
	// the Authorization tab. THAT CONFIGURATION IS COMMON IN ADOPTED ROWS, and
	// overwriting it with an empty Basic header turns a working webhook into a
	// 403. When the selected auth type has no values, the explicit header wins;
	// when it has values, the auth tab wins.
	hasConfiguredHeader := strings.TrimSpace(req.Header.Get("Authorization")) != ""
	// cantor lowercased the stored type (`basicauth`, `bearer`, ...); the port's
	// own editor writes the display spelling. Comparing case-insensitively lets
	// both documents authenticate the same way.
	switch strings.ToLower(authType) {
	case "", "none":
		return nil
	case "basicauth":
		username, password := webhook.Authorization["username"], webhook.Authorization["password"]
		if strings.TrimSpace(username) == "" && strings.TrimSpace(password) == "" {
			if hasConfiguredHeader {
				return nil
			}
			return fmt.Errorf("webhook BasicAuth authentication has no username or password")
		}
		req.SetBasicAuth(username, password)
		return nil
	case "bearer":
		token := strings.TrimSpace(webhook.Authorization["token"])
		if token == "" {
			if hasConfiguredHeader {
				return nil
			}
			return fmt.Errorf("webhook bearer authentication has no token")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	case "apikey":
		// cantor's request library treats an API key as HTTP Basic auth with
		// the key as the username and its value as the password. Reproducing
		// that keeps an adopted trigger's requests byte-for-byte the same.
		key := strings.TrimSpace(webhook.Authorization["key"])
		if key == "" {
			if hasConfiguredHeader {
				return nil
			}
			return fmt.Errorf("webhook API key authentication has no key name")
		}
		req.SetBasicAuth(key, webhook.Authorization["value"])
		return nil
	case "oauth2.0", "oauth2":
		token := strings.TrimSpace(webhook.Authorization["token"])
		if token == "" {
			token = strings.TrimSpace(webhook.Authorization["access_token"])
		}
		if token == "" {
			if strings.TrimSpace(webhook.Authorization["token_url"]) == "" && hasConfiguredHeader {
				return nil
			}
			acquired, err := acquireOAuthToken(ctx, client, webhook.Authorization)
			if err != nil {
				return err
			}
			token = acquired
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	default:
		return fmt.Errorf("unsupported webhook authentication type %q", authType)
	}
}

// acquireOAuthToken runs the client-credentials grant.
//
// The authorization-code grant is not attempted: it needs a person in a browser
// and a redirect endpoint, neither of which a trigger has. A configuration that
// names only that flow is refused rather than sent without a token.
func acquireOAuthToken(ctx context.Context, client *http.Client, authorization map[string]string) (string, error) {
	tokenURL := strings.TrimSpace(authorization["token_url"])
	if tokenURL == "" {
		return "", fmt.Errorf("webhook OAuth 2.0 authentication has no token_url")
	}
	parsed, err := url.Parse(tokenURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("webhook OAuth 2.0 token_url is not an http(s) URL")
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", authorization["client_id"])
	form.Set("client_secret", authorization["client_secret"])
	if scope := strings.TrimSpace(authorization["scope"]); scope != "" {
		form.Set("scope", scope)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("build OAuth token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpClient := client
	if httpClient == nil {
		httpClient = newTriggerHTTPClient()
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("OAuth token request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webhookResponseLimit))
	if err != nil {
		return "", fmt.Errorf("read OAuth token response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("OAuth token endpoint returned %s", resp.Status)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("decode OAuth token response: %w", err)
	}
	if payload.AccessToken == "" {
		return "", fmt.Errorf("OAuth token response has no access_token")
	}
	if payload.TokenType != "" && !strings.EqualFold(payload.TokenType, "bearer") {
		return "", fmt.Errorf("OAuth token type %q is not supported", payload.TokenType)
	}
	return payload.AccessToken, nil
}

// webhookHistoryPayload is what a firing row stores about its webhook attempt.
//
// IT IS A DELIBERATELY SMALL SHAPE. The request body and headers can contain
// credentials (an operator may put a token there directly), and a receiver's
// response can echo whatever it was sent; none of them is stored. The URL,
// status and a short error answer "did it fire, and did the receiver accept it"
// without turning the audit table into a copy of the traffic.
type webhookHistoryPayload struct {
	Method     string `json:"method"`
	URL        string `json:"url"`
	Status     int    `json:"status,omitempty"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func webhookHistoryFor(webhook triggerWebhook, delivery webhookDelivery, values map[string]string) (string, error) {
	renderedURL := renderTriggerTemplate(webhook.URL, values)
	redactedURL := redactedWebhookURL(renderedURL)
	errorText := redactWebhookURLs(delivery.Error)
	payload := webhookHistoryPayload{
		Method:     webhook.Method,
		URL:        redactedURL,
		Status:     delivery.Status,
		OK:         delivery.OK,
		Error:      errorText,
		DurationMS: delivery.Duration.Milliseconds(),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode trigger webhook history: %w", err)
	}
	return string(encoded), nil
}

var webhookURLPattern = regexp.MustCompile(`https?://[^\s"']+`)

// redactWebhookURLs removes the path and query from every URL in a diagnostic
// string. A request error from net/http quotes the full URL, and that URL may
// carry the receiver's secret in its path.
func redactWebhookURLs(text string) string {
	return webhookURLPattern.ReplaceAllStringFunc(text, redactedWebhookURL)
}

// isCloudMetadataHost refuses the well-known instance-metadata endpoints.
//
// THIS IS A LITERAL-HOST LIST, not a full SSRF policy. A DNS name that resolves
// to one of these addresses is not caught here (resolving would add a lookup
// and a time-of-check/time-of-use gap); the list covers the addresses providers
// document and a copied URL. Internal private endpoints remain allowed because
// an on-premise CMDB legitimately calls them.
func isCloudMetadataHost(host string) bool {
	switch strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), ".")) {
	case "169.254.169.254", "metadata.google.internal", "100.100.100.200", "fd00:ec2::254":
		return true
	default:
		return false
	}
}

// redactedWebhookURL keeps only the endpoint's scheme and host.
//
// THE PATH IS PART OF THE CREDENTIAL for several receivers — a Slack incoming
// webhook's secret is its path — and the query commonly carries one too. The
// firing history is readable by anyone who may read the instance, so it stores
// the host the request went to and nothing that could be replayed.
func redactedWebhookURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		// Keeping the raw value would store whatever an operator pasted,
		// including the path or query that made it unparseable.
		return "(invalid webhook url)"
	}
	parsed.User = nil
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	return parsed.String()
}
