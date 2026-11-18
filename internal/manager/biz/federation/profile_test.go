package federation

import "testing"

func TestProfile(t *testing.T) {
	alert, ok := Profile(KindExternalAlert)
	if !ok {
		t.Fatal("external_alert profile missing")
	}
	if alert.MaxPageSize != 500 || alert.DefaultDays != 7 || alert.DefaultTable != "alert_instances" || alert.StatusField != "status" {
		t.Fatalf("alert profile = %+v", alert)
	}

	ticket, ok := Profile(KindITSMTicket)
	if !ok {
		t.Fatal("itsm_ticket profile missing")
	}
	if ticket.MaxPageSize != 100 || ticket.DefaultDays != 30 || ticket.DefaultTable != "" || ticket.StatusField != "form_data.instanceStatus" {
		t.Fatalf("ticket profile = %+v", ticket)
	}

	if _, ok := Profile("incident"); ok {
		t.Fatal("unknown kind returned a profile")
	}
}
