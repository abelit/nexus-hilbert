package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	discoverybiz "github.com/ongridio/ongrid/internal/cmdb/biz/discovery"
	model "github.com/ongridio/ongrid/internal/cmdb/model"
	discoverymodel "github.com/ongridio/ongrid/internal/cmdb/model/discovery"
)

var _ discoverybiz.AgentRepo = (*Repo)(nil)

// --- principals ---

func (r *Repo) CreateAgentPrincipal(ctx context.Context, in discoverybiz.AgentPrincipalWrite) (*discoverymodel.AgentPrincipal, error) {
	row := &discoverymodel.AgentPrincipal{
		Name: in.Name, PublicID: in.PublicID, SecretSHA256: in.SecretSHA256,
		RiemannID: in.RiemannID, ScopesJSON: in.ScopesJSON, ExpiresAt: in.ExpiresAt,
	}
	if in.CreatedBy != 0 {
		row.CreatedBy = &in.CreatedBy
	}
	if err := r.db.WithContext(ctx).Create(row).Error; err != nil {
		return nil, fmt.Errorf("cmdb discovery: create agent principal: %w", err)
	}
	return row, nil
}

func (r *Repo) FindAgentPrincipalByPublicID(ctx context.Context, publicID string) (*discoverymodel.AgentPrincipal, error) {
	var row discoverymodel.AgentPrincipal
	err := r.db.WithContext(ctx).Where("public_id = ?", publicID).First(&row).Error
	switch {
	case err == nil:
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, nil
	default:
		return nil, fmt.Errorf("cmdb discovery: find agent principal: %w", err)
	}
}

func (r *Repo) ListAgentPrincipals(ctx context.Context) ([]discoverymodel.AgentPrincipal, error) {
	var rows []discoverymodel.AgentPrincipal
	if err := r.db.WithContext(ctx).Order("id").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb discovery: list agent principals: %w", err)
	}
	return rows, nil
}

func (r *Repo) RevokeAgentPrincipal(ctx context.Context, id model.ID, at time.Time) error {
	if err := r.db.WithContext(ctx).Model(&discoverymodel.AgentPrincipal{}).
		Where("id = ?", id).Update("revoked_at", at).Error; err != nil {
		return fmt.Errorf("cmdb discovery: revoke agent principal: %w", err)
	}
	return nil
}

func (r *Repo) TouchAgentPrincipal(ctx context.Context, id model.ID, at time.Time) error {
	if err := r.db.WithContext(ctx).Model(&discoverymodel.AgentPrincipal{}).
		Where("id = ?", id).Update("last_used_at", at).Error; err != nil {
		return fmt.Errorf("cmdb discovery: touch agent principal: %w", err)
	}
	return nil
}

// --- eulers ---

func (r *Repo) UpsertEuler(ctx context.Context, in discoverybiz.EulerWrite) (*discoverymodel.Euler, error) {
	var row discoverymodel.Euler
	err := r.db.WithContext(ctx).Where("euler_id = ?", in.EulerID).First(&row).Error
	switch {
	case err == nil:
		updates := map[string]any{
			"riemann_id": in.RiemannID, "hostname": in.Hostname, "ip_address": in.IPAddress,
			"os_type": in.OSType, "version": in.Version, "roles_json": in.RolesJSON,
			"capabilities_json": in.CapabilitiesJSON, "status": in.Status,
		}
		if len(in.PublicKey) > 0 {
			updates["public_key"] = in.PublicKey
		}
		if in.CertSerial != "" {
			updates["cert_serial"] = in.CertSerial
		}
		if err := r.db.WithContext(ctx).Model(&row).Updates(updates).Error; err != nil {
			return nil, fmt.Errorf("cmdb discovery: update euler: %w", err)
		}
		if err := r.db.WithContext(ctx).First(&row, row.ID).Error; err != nil {
			return nil, fmt.Errorf("cmdb discovery: reload euler: %w", err)
		}
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		row = discoverymodel.Euler{
			EulerID: in.EulerID, RiemannID: in.RiemannID, Hostname: in.Hostname,
			IPAddress: in.IPAddress, OSType: in.OSType, Version: in.Version,
			RolesJSON: in.RolesJSON, CapabilitiesJSON: in.CapabilitiesJSON,
			PublicKey: in.PublicKey, CertSerial: in.CertSerial, Status: in.Status,
		}
		if err := r.db.WithContext(ctx).Create(&row).Error; err != nil {
			return nil, fmt.Errorf("cmdb discovery: create euler: %w", err)
		}
		return &row, nil
	default:
		return nil, fmt.Errorf("cmdb discovery: find euler: %w", err)
	}
}

func (r *Repo) LoadEuler(ctx context.Context, eulerID string) (*discoverymodel.Euler, error) {
	var row discoverymodel.Euler
	err := r.db.WithContext(ctx).Where("euler_id = ?", eulerID).First(&row).Error
	switch {
	case err == nil:
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, nil
	default:
		return nil, fmt.Errorf("cmdb discovery: load euler: %w", err)
	}
}

func (r *Repo) ListEulers(ctx context.Context) ([]discoverymodel.Euler, error) {
	var rows []discoverymodel.Euler
	if err := r.db.WithContext(ctx).Order("id").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("cmdb discovery: list eulers: %w", err)
	}
	return rows, nil
}

func (r *Repo) TouchEuler(ctx context.Context, eulerID string, at time.Time, capabilities string) error {
	updates := map[string]any{"last_seen_at": at}
	if capabilities != "" {
		updates["capabilities_json"] = capabilities
	}
	if err := r.db.WithContext(ctx).Model(&discoverymodel.Euler{}).
		Where("euler_id = ?", eulerID).Updates(updates).Error; err != nil {
		return fmt.Errorf("cmdb discovery: touch euler: %w", err)
	}
	return nil
}

// --- enrollment tokens ---

func (r *Repo) CreateEnrollmentToken(ctx context.Context, in discoverybiz.EnrollmentTokenWrite) (*discoverymodel.EnrollmentToken, error) {
	row := &discoverymodel.EnrollmentToken{
		TokenSHA256: in.TokenSHA256, LabelsJSON: in.LabelsJSON, ExpiresAt: in.ExpiresAt,
	}
	if in.EulerID != "" {
		row.EulerID = &in.EulerID
	}
	if in.CreatedBy != 0 {
		row.CreatedBy = &in.CreatedBy
	}
	if err := r.db.WithContext(ctx).Create(row).Error; err != nil {
		return nil, fmt.Errorf("cmdb discovery: create enrollment token: %w", err)
	}
	return row, nil
}

func (r *Repo) ConsumeEnrollmentToken(ctx context.Context, hash string, at time.Time) (*discoverymodel.EnrollmentToken, error) {
	var row discoverymodel.EnrollmentToken
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&discoverymodel.EnrollmentToken{}).
			Where("token_sha256 = ? AND used_at IS NULL AND expires_at > ?", hash, at).
			Update("used_at", at)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return tx.Where("token_sha256 = ?", hash).First(&row).Error
	})
	switch {
	case err == nil:
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, nil
	default:
		return nil, fmt.Errorf("cmdb discovery: consume enrollment token: %w", err)
	}
}

// --- task state and report receipts ---

func (r *Repo) UpsertEulerTaskState(ctx context.Context, in discoverybiz.EulerTaskStateWrite) error {
	var row discoverymodel.EulerTaskState
	err := r.db.WithContext(ctx).
		Where("euler_id = ? AND task_id = ?", in.EulerID, in.TaskID).First(&row).Error
	switch {
	case err == nil:
		if err := r.db.WithContext(ctx).Model(&row).Updates(map[string]any{
			"revision": in.Revision, "state": in.State, "last_error": in.Error, "last_ack_at": in.At,
		}).Error; err != nil {
			return fmt.Errorf("cmdb discovery: update task state: %w", err)
		}
	case errors.Is(err, gorm.ErrRecordNotFound):
		row = discoverymodel.EulerTaskState{
			EulerID: in.EulerID, TaskID: in.TaskID, Revision: in.Revision,
			State: in.State, LastError: in.Error, LastAckAt: &in.At,
		}
		if err := r.db.WithContext(ctx).Create(&row).Error; err != nil {
			return fmt.Errorf("cmdb discovery: create task state: %w", err)
		}
	default:
		return fmt.Errorf("cmdb discovery: load task state: %w", err)
	}
	return nil
}

func (r *Repo) CreateReportReceipt(ctx context.Context, in discoverybiz.ReportReceiptWrite) (*discoverymodel.ReportReceipt, error) {
	row := &discoverymodel.ReportReceipt{
		ReportID: in.ReportID, TaskID: in.TaskID, Status: in.Status,
	}
	if in.CIID != 0 {
		row.CIID = &in.CIID
	}
	err := r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
	if err != nil {
		return nil, fmt.Errorf("cmdb discovery: create report receipt: %w", err)
	}
	if row.ID == 0 {
		return r.FindReportReceipt(ctx, in.ReportID)
	}
	return row, nil
}

func (r *Repo) FindReportReceipt(ctx context.Context, reportID string) (*discoverymodel.ReportReceipt, error) {
	var row discoverymodel.ReportReceipt
	err := r.db.WithContext(ctx).Where("report_id = ?", reportID).First(&row).Error
	switch {
	case err == nil:
		return &row, nil
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, nil
	default:
		return nil, fmt.Errorf("cmdb discovery: find report receipt: %w", err)
	}
}

// --- pool lifecycle ---

func (r *Repo) MarkPoolStale(ctx context.Context, typeID model.ID, uniqueValue string, at time.Time) error {
	if uniqueValue == "" {
		return nil
	}
	if err := r.db.WithContext(ctx).Model(&discoverymodel.PoolEntry{}).
		Where("type_id = ? AND unique_value = ?", typeID, uniqueValue).
		Update("stale_at", at).Error; err != nil {
		return fmt.Errorf("cmdb discovery: mark pool stale: %w", err)
	}
	return nil
}
