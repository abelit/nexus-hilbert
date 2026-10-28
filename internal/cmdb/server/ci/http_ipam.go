package ci

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	cibiz "github.com/ongridio/ongrid/internal/cmdb/biz/ci"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	"github.com/ongridio/ongrid/internal/pkg/errs"
)

// registerIPAM attaches the address-management routes.
//
// Routes:
//
//	GET    /v1/cmdb/ipam/tree-view                       (any authed) — scopes and subnets
//	GET    /v1/cmdb/ipam/subnets/hosts                   (any authed) — the addresses a range would hold
//	GET    /v1/cmdb/ipam/subnets/{id}                    (any authed) — one subnet
//	POST   /v1/cmdb/ipam/subnets                         (any authed) — create a range
//	PUT    /v1/cmdb/ipam/subnets/{id}                    (any authed) — write a range's values
//	DELETE /v1/cmdb/ipam/subnets/{id}                    (any authed) — remove an empty range
//	PUT    /v1/cmdb/ipam/subnets/{id}/move               (any authed) — re-parent a range
//	POST   /v1/cmdb/ipam/scopes                          (any authed) — create a grouping
//	PUT    /v1/cmdb/ipam/scopes/{id}                     (any authed) — rename a grouping
//	DELETE /v1/cmdb/ipam/scopes/{id}                     (any authed) — remove an empty grouping
//	GET    /v1/cmdb/ipam/addresses                       (any authed) — a range's addresses
//	POST   /v1/cmdb/ipam/addresses                       (any authed) — assign or release
//	GET    /v1/cmdb/ipam/stats                           (any authed) — the usage summary
//	GET    /v1/cmdb/ipam/history/operations              (any authed)
//	GET    /v1/cmdb/ipam/history/scans                   (any authed)
//	POST   /v1/cmdb/ipam/history/scans                   (any authed) — a scanner's report
//
// THEY LIVE IN THE SAME HANDLER as the data centre's, for the same reasons: one
// use case, one row shape, one mount point.
func (h *Handler) registerIPAM(r chi.Router) {
	r.Get("/v1/cmdb/ipam/tree-view", h.ipamTree)
	r.Get("/v1/cmdb/ipam/stats", h.ipamStats)
	r.Get("/v1/cmdb/ipam/history/operations", h.ipamHistory)
	r.Get("/v1/cmdb/ipam/history/scans", h.ipamScanHistory)
	r.Post("/v1/cmdb/ipam/history/scans", h.ipamRecordScan)

	// `hosts` is a static segment in the same position as `{id}`, so it is
	// registered ahead of it and the route test pins that it wins.
	r.Get("/v1/cmdb/ipam/subnets/hosts", h.ipamSubnetHosts)
	r.Get("/v1/cmdb/ipam/subnets/{id}", h.ipamGetSubnet)
	r.Post("/v1/cmdb/ipam/subnets", h.ipamCreateSubnet)
	r.Put("/v1/cmdb/ipam/subnets/{id}", h.ipamUpdateSubnet)
	r.Delete("/v1/cmdb/ipam/subnets/{id}", h.ipamDeleteSubnet)
	r.Put("/v1/cmdb/ipam/subnets/{id}/move", h.ipamMoveSubnet)

	r.Post("/v1/cmdb/ipam/scopes", h.ipamCreateScope)
	r.Put("/v1/cmdb/ipam/scopes/{id}", h.ipamUpdateScope)
	r.Delete("/v1/cmdb/ipam/scopes/{id}", h.ipamDeleteScope)

	r.Get("/v1/cmdb/ipam/addresses", h.ipamAddresses)
	r.Post("/v1/cmdb/ipam/addresses", h.ipamAssignAddresses)
}

func (h *Handler) ipamTree(w http.ResponseWriter, r *http.Request) {
	got, err := h.uc.IPAMTree(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

func (h *Handler) ipamStats(w http.ResponseWriter, r *http.Request) {
	parentID, err := positiveIntParam(r.URL.Query().Get("parent_id"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.IPAMSummary(r.Context(), model.ID(parentID))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// --- hosts ---

func (h *Handler) ipamSubnetHosts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, err := positiveIntParam(q.Get("limit"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.SubnetHosts(r.Context(), q.Get("cidr"), limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	// The list is returned as-is rather than wrapped: it is a RANGE's contents,
	// and the caller asked for the range's addresses, not a page of them. The
	// bound is reported so a truncated list cannot be mistaken for the whole
	// range — and it is measured against the RANGE, not the ceiling, because a
	// caller that asked for 512 hosts of a /16 got 512 of 65534.
	hosts, err := cibiz.HostCount(q.Get("cidr"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hosts":     got,
		"truncated": int64(hosts) > int64(len(got)),
	})
}

// --- subnets ---

func (h *Handler) ipamGetSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.GetSubnet(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

func (h *Handler) ipamCreateSubnet(w http.ResponseWriter, r *http.Request) {
	body, err := decodeNodeBody(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	parentID, err := nodeParentID(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	cidr, _ := body["cidr"].(string)
	delete(body, "cidr")
	in, err := subnetScanInput(r, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	in.ParentID, in.CIDR = parentID, cidr

	got, err := h.uc.CreateSubnet(r.Context(), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ci_id": got.CIID})
}

func (h *Handler) ipamUpdateSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	body, err := decodeNodeBody(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	parentID, err := nodeParentID(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	cidr, _ := body["cidr"].(string)
	delete(body, "cidr")
	in, err := subnetScanInput(r, body)
	if err != nil {
		writeErr(w, err)
		return
	}
	in.ParentID, in.CIDR = parentID, cidr

	got, err := h.uc.UpdateSubnet(r.Context(), id, in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ci_id": got.CIID})
}

func (h *Handler) ipamDeleteSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.uc.DeleteSubnet(r.Context(), id, audit); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ipamMoveSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	body, err := decodeNodeBody(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}
	target, err := nodeParentID(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.uc.MoveSubnet(r.Context(), id, target, audit); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ci_id": id, "target_parent_id": target})
}

// subnetScanInput pulls the scan configuration and the audit fields out of a
// subnet's body.
//
// THE SCAN FIELDS ARE CONSUMED, not passed through as attributes: a subnet's
// scan lives in its own table, and leaving `cron` in the values would write an
// attribute nobody declared — which the instance write path would then refuse
// or drop depending on the policy.
func subnetScanInput(r *http.Request, body dcimNodeBody) (cibiz.SubnetInput, error) {
	var in cibiz.SubnetInput
	values := map[string]any{}
	for k, v := range body {
		switch k {
		case "agent_id", "cron", "scan_enabled":
		default:
			values[k] = v
		}
	}
	in.Values = values

	if raw, ok := body["agent_id"]; ok {
		in.SetScan = true
		in.AgentID = fmt.Sprint(raw)
	}
	if raw, ok := body["cron"]; ok {
		in.SetScan = true
		in.Cron = fmt.Sprint(raw)
	}
	if raw, ok := body["scan_enabled"]; ok {
		in.SetScan = true
		in.Enabled = truthy(raw)
	} else {
		in.Enabled = true
	}

	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		return in, err
	}
	in.Audit = audit
	return in, nil
}

// truthy reads a JSON value as a boolean, accepting the spellings a form
// library produces.
func truthy(raw any) bool {
	switch v := raw.(type) {
	case bool:
		return v
	case json.Number:
		return v.String() != "0"
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		}
	}
	return false
}

// --- scopes ---

func (h *Handler) ipamCreateScope(w http.ResponseWriter, r *http.Request) {
	body, err := decodeNodeBody(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	parentID, err := nodeParentID(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}
	name, _ := body["name"].(string)
	if name == "" {
		if raw, ok := body["scope_name"]; ok {
			name = fmt.Sprint(raw)
		}
	}
	got, err := h.uc.CreateIPScope(r.Context(), cibiz.IPScopeInput{
		ParentID: parentID, Name: name, Audit: audit,
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ci_id": got.CIID})
}

// ipamUpdateScope renames a grouping.
//
// PUT /v1/cmdb/ipam/scopes/{id} (any authenticated caller)
// Request: {"name": "..."}; the model's identifying attribute is updated.
// Response: {"ci_id": id}. Operation history receives UPDATE_SCOPE with
// "old -> new".
func (h *Handler) ipamUpdateScope(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	body, err := decodeNodeBody(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}
	name, _ := body["name"].(string)
	if name == "" {
		name = asString(body["scope_name"])
	}
	got, err := h.uc.UpdateIPScope(r.Context(), id, cibiz.IPScopeInput{Name: name, Audit: audit})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ci_id": got.CIID})
}

func (h *Handler) ipamDeleteScope(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := h.uc.DeleteIPScope(r.Context(), id, audit); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- addresses ---

func (h *Handler) ipamAddresses(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	subnetID, err := positiveIntParam(q.Get("subnet_id"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	if subnetID == 0 {
		if subnetID, err = positiveIntParam(q.Get("parent_id"), 0); err != nil {
			writeErr(w, err)
			return
		}
	}
	page, err := positiveIntParam(q.Get("page"), 1)
	if err != nil {
		writeErr(w, err)
		return
	}
	size, err := positiveIntParam(q.Get("count"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.ListSubnetAddresses(r.Context(), model.ID(subnetID), page, size)
	if err != nil {
		writeErr(w, err)
		return
	}
	body := searchResponse(&cibiz.SearchPage{
		Hits: got.Items, NumFound: got.NumFound, Page: got.Page, Counter: map[string]int{},
	})
	writeJSON(w, http.StatusOK, body)
}

// ipamAssignAddresses assigns, releases or annotates a batch of addresses.
//
// THE BODY IS READ AS A MAP because the address model is the deployment's:
// cantor's dialog sends `usage`, `use_obj`, `mac_address`, `gateway`,
// `subnet_mask` and `description`, and a struct here would drop every one of
// them. The fields this module owns are consumed; everything else is passed to
// the instance write path, which ignores attributes the model does not carry.
func (h *Handler) ipamAssignAddresses(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxWriteBody))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			writeErr(w, fmt.Errorf("%w: ips", errs.ErrInvalid))
			return
		}
		writeErr(w, errs.ErrInvalid)
		return
	}
	audit, err := actor(r, &instanceRequest{})
	if err != nil {
		writeErr(w, err)
		return
	}

	in, err := addressAssignInput(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	in.Audit = audit

	got, err := h.uc.AssignAddresses(r.Context(), in)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ci_ids":       got.AddressIDs,
		"created":      got.Created,
		"assign_count": got.AssignCount,
		"used_count":   got.UsedCount,
		"free_count":   got.FreeCount,
	})
}

// --- history ---

func (h *Handler) ipamHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := positiveIntParam(q.Get("page"), 1)
	if err != nil {
		writeErr(w, err)
		return
	}
	size, err := positiveIntParam(q.Get("count"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	if size == 0 {
		if size, err = positiveIntParam(q.Get("page_size"), 0); err != nil {
			writeErr(w, err)
			return
		}
	}
	got, err := h.uc.IPAMHistory(r.Context(), cibiz.IPAMHistoryQuery{
		CIDR:         strings.TrimSpace(q.Get("cidr")),
		OperateTypes: splitList(q.Get("operate_type")),
		Page:         page, Count: size,
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

func (h *Handler) ipamScanHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, err := positiveIntParam(q.Get("page"), 1)
	if err != nil {
		writeErr(w, err)
		return
	}
	size, err := positiveIntParam(q.Get("count"), 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	got, err := h.uc.IPAMScanHistory(r.Context(), cibiz.IPAMScanQuery{
		CIDR: strings.TrimSpace(q.Get("cidr")), ExecID: strings.TrimSpace(q.Get("exec_id")),
		Page: page, Count: size,
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// ipamRecordScan takes a scanner's report.
//
// THE REPORTER IS AN AGENT, so the body is the agent's own JSON and is stored
// as such rather than being reshaped: the fields a scanner produces are not a
// contract this module owns, and the addresses it lists are kept as the report
// wrote them.
func (h *Handler) ipamRecordScan(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxWriteBody))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		writeErr(w, errs.ErrInvalid)
		return
	}
	execID, _ := body["exec_id"].(string)
	if execID == "" {
		writeErr(w, fmt.Errorf("%w: exec_id", errs.ErrInvalid))
		return
	}
	in := cibiz.ScanReportInput{
		ExecID: execID,
		CIDR:   asString(body["cidr"]),
		Stdout: asString(body["stdout"]),
	}
	if n, err := strconv.Atoi(asString(body["status"])); err == nil {
		in.Status = n
	}
	if n, err := strconv.Atoi(asString(body["ip_num"])); err == nil {
		in.IPNum = int32(n)
	}
	if ips, ok := body["ips"]; ok {
		// A scanner may report a map OR a list; both are the report, and
		// keeping either is more useful than dropping the shape this build did
		// not expect.
		in.IPs = ips
	}
	in.StartAt = parseTimeValue(body["start_at"])
	in.EndAt = parseTimeValue(body["end_at"])
	if err := h.uc.RecordScan(r.Context(), in); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": 200})
}

// parseTimeValue accepts the two spellings a scanner has sent: RFC3339 and the
// database's own "YYYY-MM-DD HH:MM:SS".
func parseTimeValue(raw any) *time.Time {
	text := strings.TrimSpace(asString(raw))
	if text == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05"} {
		if got, err := time.Parse(layout, text); err == nil {
			return &got
		}
	}
	return nil
}

// addressAssignInput separates the fields the IPAM module owns from the
// attributes the address model owns. The caller's other keys travel as values;
// the instance write path drops those the model does not declare.
func addressAssignInput(body map[string]any) (cibiz.AddressAssignInput, error) {
	in := cibiz.AddressAssignInput{
		SubnetID: idValue(body["subnet_id"]), CIDR: asString(body["cidr"]),
		IPs: ipList(body["ips"]), Values: map[string]any{},
	}
	if in.SubnetID == 0 {
		in.SubnetID = idValue(body["parent_id"])
	}
	if len(in.IPs) == 0 {
		return in, fmt.Errorf("%w: ips", errs.ErrInvalid)
	}
	if raw, ok := body["assign_status"]; ok && raw != nil {
		n, err := strconv.Atoi(asString(raw))
		if err != nil {
			return in, fmt.Errorf("%w: assign_status", errs.ErrInvalid)
		}
		status := cibiz.AddressStatus(n)
		in.Status = &status
	}
	if raw, ok := body["is_used"]; ok && raw != nil {
		used := truthy(raw)
		in.IsUsed = &used
	}
	for key, value := range body {
		switch key {
		case "ips", "subnet_id", "parent_id", "cidr", "assign_status", "is_used":
			continue
		}
		in.Values[key] = value
	}
	return in, nil
}

// idValue reads a model id from a decoded JSON value.
func idValue(raw any) model.ID {
	switch v := raw.(type) {
	case nil:
		return 0
	case json.Number:
		n, _ := v.Int64()
		return model.ID(n)
	case float64:
		return model.ID(v)
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return model.ID(n)
	default:
		return 0
	}
}

// ipList accepts the list shapes cantor's forms have sent: an array, one
// address, or a comma/space separated string. The order is the caller's and
// duplicates are kept, because the assignment path reports one result per
// entry it was given.
func ipList(raw any) []string {
	var items []string
	switch v := raw.(type) {
	case string:
		items = strings.FieldsFunc(v, func(r rune) bool {
			return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t'
		})
	case []any:
		for _, item := range v {
			items = append(items, asString(item))
		}
	case []string:
		items = v
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// asString renders a JSON value for a text field, tolerating the number a
// scanner may send where a string is expected.
func asString(raw any) string {
	switch v := raw.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	default:
		return fmt.Sprint(v)
	}
}
