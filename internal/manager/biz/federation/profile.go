package federation

import model "github.com/ongridio/ongrid/internal/manager/model/federation"

// SourceProfile is the only kind-specific data the shared module needs. The
// differences between an external alert source and an ITSM ticket source are
// data, not behaviour.
type SourceProfile struct {
	Kind            string
	DefaultDays     int
	DefaultPageSize int
	MaxPageSize     int
	DefaultTable    string
	StatusField     string
	SeverityField   string
	KeywordField    string
	StatsMode       string
}

const (
	StatsModeUpstream = "upstream_stats"
	StatsModeTargeted = "targeted_counts"
)

// Profile returns the source profile for kind.
func Profile(kind string) (SourceProfile, bool) {
	switch kind {
	case model.KindExternalAlert:
		return SourceProfile{
			Kind:            model.KindExternalAlert,
			DefaultDays:     7,
			DefaultPageSize: 50,
			MaxPageSize:     500,
			DefaultTable:    "alert_instances",
			StatusField:     "status",
			SeverityField:   "alert.labels.severity",
			KeywordField:    "alertname",
			StatsMode:       StatsModeUpstream,
		}, true
	case model.KindITSMTicket:
		return SourceProfile{
			Kind:            model.KindITSMTicket,
			DefaultDays:     30,
			DefaultPageSize: 20,
			MaxPageSize:     100,
			DefaultTable:    "",
			StatusField:     "form_data.instanceStatus",
			SeverityField:   "",
			KeywordField:    "form_data.title",
			StatsMode:       StatsModeTargeted,
		}, true
	default:
		return SourceProfile{}, false
	}
}
