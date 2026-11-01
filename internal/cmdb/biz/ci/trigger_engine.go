package ci

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	model "github.com/ongridio/ongrid/internal/cmdb/model"
	cimodel "github.com/ongridio/ongrid/internal/cmdb/model/ci"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// Trigger-dispatch errors.
var (
	// ErrTriggerDateDispatchUnsupported is returned by the manual test route for
	// a date-attribute trigger. Those rules need a scheduler, which is a
	// separate piece of work; answering "sent" while nothing is scheduled would
	// be worse than saying so.
	ErrTriggerDateDispatchUnsupported = fmt.Errorf("%w: date triggers are not dispatched in this build", errs.ErrNotWiredYet)

	// ErrTriggerNoWebhook is returned when a manual test names a rule whose
	// action is a notification. Notification delivery is not wired in this
	// build, and the webhook dispatch path cannot stand in for it.
	ErrTriggerNoWebhook = fmt.Errorf("%w: this trigger has no webhook action", errs.ErrInvalid)

	// ErrTriggerConfigNotFound is returned when a manual test names a rule that
	// disappeared between the permission check and the dispatch.
	ErrTriggerConfigNotFound = fmt.Errorf("%w: trigger does not exist", errs.ErrNotFound)
)

// TriggerDispatcher is the instance write path's view of the trigger engine.
// Prepare runs on the write goroutine (matching and filtering only); Send hands
// the prepared attempts to the background sender.
type TriggerDispatcher interface {
	Prepare(ctx context.Context, event TriggerEvent) ([]TriggerFiring, error)
	Send(firings []TriggerFiring)
}

var _ TriggerDispatcher = (*TriggerEngine)(nil)

// TriggerConfig is one stored rule as the dispatcher receives it.
//
// Option is the document with its authorization block REMOVED; Authorization
// carries the decrypted values. The split is deliberate: the engine never sees
// ciphertext, and the option it reads and logs cannot contain the credential.
type TriggerConfig struct {
	ID     model.ID
	TypeID model.ID
	AttrID *model.ID

	Option        map[string]any
	Authorization map[string]string
}

// TriggerSource answers the dispatcher's questions about stored rules.
type TriggerSource interface {
	TriggersForType(ctx context.Context, typeID model.ID) ([]TriggerConfig, error)
	TriggerByID(ctx context.Context, id model.ID) (*TriggerConfig, error)
}

// TriggerFilterMatcher answers whether one instance satisfies a trigger's
// filter. It is the instance side's existing membership query, not a second
// expression evaluator.
type TriggerFilterMatcher interface {
	InstanceMatches(ctx context.Context, expr string, ciID model.ID) (bool, error)
}

// TriggerSampleSource supplies a real instance's values for a manual test.
// cantor fired the rule against the type's first instance; using the same
// instance keeps a test request's templates as meaningful as a live one's.
type TriggerSampleSource interface {
	LatestTriggerEvent(ctx context.Context, typeID model.ID) (TriggerEvent, error)
}

// TriggerHistoryWriter persists one firing outcome.
type TriggerHistoryWriter interface {
	InsertTriggerRecord(ctx context.Context, row *cimodel.TriggerHistory) error
}

// TriggerFiring is a prepared outbound attempt: the rule was matched and the
// filter, if any, already passed.
//
// IT HOLDS THE DECRYPTED CREDENTIAL in memory only. Nothing logs this value and
// the history row deliberately omits it.
type TriggerFiring struct {
	TriggerID   model.ID
	TriggerName string
	Action      model.OperateType

	TypeID   model.ID
	CIID     model.ID
	RecordID model.ID

	Webhook triggerWebhook
	Values  map[string]string

	// Test marks a manual test. cantor left operate_type NULL on those firings,
	// because no instance write caused them.
	Test bool
}

// TriggerEngine matches committed instance writes and delivers their webhooks
// on a bounded background queue.
//
// THE WRITE PATH ONLY MATCHES AND ENQUEUES. Delivering on the request goroutine
// would make a slow receiver a slow CMDB write, and an unreachable one an
// error the write did not cause. The queue is bounded and dropping is logged:
// a trigger is a side effect, and it must not be able to take the instance
// write down with it.
type TriggerEngine struct {
	matcher TriggerFilterMatcher
	source  TriggerSource
	sample  TriggerSampleSource
	history TriggerHistoryWriter
	log     *slog.Logger

	client  *http.Client
	timeout time.Duration

	mu      sync.Mutex
	queue   chan TriggerFiring
	started bool
	closed  bool
	done    chan struct{}
}

const triggerQueueSize = 128

// NewTriggerEngine builds the dispatcher. A nil logger falls back to
// slog.Default; the HTTP client is bounded so a receiver that never answers
// cannot pin a worker forever.
func NewTriggerEngine(matcher TriggerFilterMatcher, source TriggerSource, history TriggerHistoryWriter, log *slog.Logger) *TriggerEngine {
	if log == nil {
		log = slog.Default()
	}
	return &TriggerEngine{
		matcher: matcher, source: source, history: history,
		log:     log.With(slog.String("comp", "cmdb-trigger")),
		client:  newTriggerHTTPClient(),
		timeout: 15 * time.Second,
		queue:   make(chan TriggerFiring, triggerQueueSize),
		done:    make(chan struct{}),
	}
}

// newTriggerHTTPClient is the sender's default client.
//
// IT IGNORES THE PROCESS'S HTTP_PROXY/HTTPS_PROXY SETTINGS. A proxy sees the
// full request including the operator's credential; cantor disabled proxy
// inheritance for the same reason. A deployment that genuinely needs one for
// outbound traffic has to inject an explicit client through WithHTTPClient.
func newTriggerHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{Timeout: 10 * time.Second, Transport: transport}
}

// WithHTTPClient replaces the sender's client. It exists so tests can point the
// dispatcher at an httptest server without a network.
func (e *TriggerEngine) WithHTTPClient(client *http.Client) *TriggerEngine {
	if e != nil && client != nil {
		e.client = client
	}
	return e
}

// WithSampleSource injects the instance lookup a manual test uses for its
// template values.
func (e *TriggerEngine) WithSampleSource(sample TriggerSampleSource) *TriggerEngine {
	if e != nil {
		e.sample = sample
	}
	return e
}

// Prepare matches an event against the model's enabled data-event rules and
// returns the attempts that should fire.
//
// IT RUNS ON THE WRITE GOROUTINE, but does no network I/O. The filter is a
// membership query against the same search language the console uses, so a
// rule's condition means exactly what it means in the resource page. A rule
// that cannot be parsed or whose filter fails is skipped with a log line: one
// broken rule must not stop the model's other rules.
func (e *TriggerEngine) Prepare(ctx context.Context, event TriggerEvent) ([]TriggerFiring, error) {
	if e == nil || e.source == nil {
		return nil, nil
	}
	configs, err := e.source.TriggersForType(ctx, event.TypeID)
	if err != nil {
		return nil, fmt.Errorf("load triggers for model %d: %w", event.TypeID, err)
	}

	out := make([]TriggerFiring, 0, len(configs))
	for _, config := range configs {
		// A non-null attr_id marks a date-attribute rule. Those are scheduled,
		// not driven by a write, and are out of this dispatcher's scope.
		if config.AttrID != nil {
			continue
		}
		rule, err := parseTriggerRule(config.Option)
		if err != nil {
			e.log.Warn("skipping malformed trigger",
				slog.Any("trigger_id", config.ID), slog.Any("err", err))
			continue
		}
		if !rule.matches(event) || rule.Webhook == nil {
			continue
		}
		if rule.Filter != "" {
			if e.matcher == nil {
				e.log.Warn("skipping filtered trigger with no matcher",
					slog.Any("trigger_id", config.ID))
				continue
			}
			matched, err := e.matcher.InstanceMatches(ctx, rule.Filter, event.CIID)
			if err != nil {
				e.log.Warn("skipping trigger whose filter could not be evaluated",
					slog.Any("trigger_id", config.ID), slog.Any("err", err))
				continue
			}
			if !matched {
				continue
			}
		}

		webhook := *rule.Webhook
		webhook.Authorization = config.Authorization
		if webhook.AuthType == "" {
			webhook.AuthType = webhook.Authorization["type"]
		}
		out = append(out, TriggerFiring{
			TriggerID: config.ID, TriggerName: rule.Name, Action: rule.Action,
			TypeID: event.TypeID, CIID: event.CIID, RecordID: event.RecordID,
			Webhook: webhook, Values: event.Values,
		})
	}
	return out, nil
}

// Send enqueues prepared attempts. It never blocks the caller: when the queue
// is full the attempt is dropped and logged, because delaying or failing the
// instance write for a trigger would invert the relationship between the change
// and its side effect.
func (e *TriggerEngine) Send(firings []TriggerFiring) {
	if e == nil || len(firings) == 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	if !e.started {
		e.started = true
		go e.work()
	}
	for _, firing := range firings {
		select {
		case e.queue <- firing:
		default:
			e.log.Warn("trigger queue is full; dropping firing",
				slog.Any("trigger_id", firing.TriggerID),
				slog.Any("ci_id", firing.CIID))
		}
	}
}

func (e *TriggerEngine) work() {
	defer close(e.done)
	for firing := range e.queue {
		ctx, cancel := context.WithTimeout(context.Background(), e.timeout)
		if err := e.deliver(ctx, firing); err != nil {
			e.log.Warn("trigger delivery failed",
				slog.Any("trigger_id", firing.TriggerID),
				slog.Any("ci_id", firing.CIID),
				slog.Any("err", err))
		}
		cancel()
	}
}

// deliver performs one attempt and records its outcome. The history write uses
// a fresh short context: the delivery context is already spent, and failing to
// record "the receiver timed out" would erase the evidence of the timeout.
func (e *TriggerEngine) deliver(ctx context.Context, firing TriggerFiring) error {
	delivery := sendWebhook(ctx, e.client, firing.Webhook, firing.Values)

	if e.history != nil {
		row := &cimodel.TriggerHistory{
			CIID:      firing.CIID,
			TriggerID: triggerIDPtr(firing.TriggerID),
			IsOK:      delivery.OK,
		}
		if !firing.Test {
			operate := string(firing.Action)
			row.OperateType = &operate
		}
		if firing.RecordID > 0 {
			recordID := firing.RecordID
			row.RecordID = &recordID
		}
		name := truncateTriggerName(firing.TriggerName)
		row.TriggerName = &name
		if payload, err := webhookHistoryFor(firing.Webhook, delivery, firing.Values); err == nil {
			row.Webhook = &payload
		}
		historyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := e.history.InsertTriggerRecord(historyCtx, row)
		cancel()
		if err != nil {
			e.log.Warn("could not record trigger firing",
				slog.Any("trigger_id", firing.TriggerID), slog.Any("err", err))
		}
	}

	if !delivery.OK {
		return fmt.Errorf("trigger %d webhook: %s", firing.TriggerID, delivery.Error)
	}
	return nil
}

// TestTrigger fires one rule immediately and reports the delivery outcome. The
// history row is still written, so a failed manual test leaves the same
// evidence a failed automatic firing would. A disabled rule is fired: the
// operator asked for this specific row, not for the model's live set.
func (e *TriggerEngine) TestTrigger(ctx context.Context, triggerID model.ID) error {
	if e == nil || e.source == nil {
		return errs.ErrNotWiredYet
	}
	config, err := e.source.TriggerByID(ctx, triggerID)
	if err != nil {
		return err
	}
	if config == nil {
		return ErrTriggerConfigNotFound
	}
	if config.AttrID != nil {
		return ErrTriggerDateDispatchUnsupported
	}
	rule, err := parseTriggerRule(config.Option)
	if err != nil {
		return err
	}
	if rule.Webhook == nil {
		return ErrTriggerNoWebhook
	}
	webhook := *rule.Webhook
	webhook.Authorization = config.Authorization
	if webhook.AuthType == "" {
		webhook.AuthType = webhook.Authorization["type"]
	}

	event := TriggerEvent{TypeID: config.TypeID, Values: map[string]string{}}
	if e.sample != nil {
		sample, sampleErr := e.sample.LatestTriggerEvent(ctx, config.TypeID)
		if sampleErr != nil {
			e.log.Warn("could not load a sample instance for the trigger test",
				slog.Any("trigger_id", config.ID), slog.Any("err", sampleErr))
		} else {
			event = sample
		}
	}
	firing := TriggerFiring{
		TriggerID: config.ID, TriggerName: rule.Name, Action: rule.Action,
		TypeID: config.TypeID, CIID: event.CIID,
		Webhook: webhook, Values: event.Values, Test: true,
	}
	runCtx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
	return e.deliver(runCtx, firing)
}

// Close stops accepting work and waits for the queued attempts to finish. The
// queue is drained rather than abandoned so a shutdown does not turn an
// already-accepted trigger into a silent no-op.
func (e *TriggerEngine) Close(ctx context.Context) error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	if e.closed {
		started := e.started
		e.mu.Unlock()
		if !started {
			return nil
		}
		select {
		case <-e.done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	e.closed = true
	started := e.started
	if started {
		close(e.queue)
	}
	e.mu.Unlock()
	if !started {
		return nil
	}
	select {
	case <-e.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func triggerIDPtr(id model.ID) *model.ID {
	if id <= 0 {
		return nil
	}
	return &id
}

func truncateTriggerName(name string) string {
	const max = 64
	if utf8.RuneCountInString(name) <= max {
		return name
	}
	runes := []rune(name)
	return string(runes[:max])
}
