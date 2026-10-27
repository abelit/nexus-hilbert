package cantorimport

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	driver "github.com/go-sql-driver/mysql"
)

// sourceUser is the part of cantor's users row needed for attribution.
type sourceUser struct {
	UID        int64
	Username   string
	Nickname   string
	Email      string
	Mobile     string
	DateJoined sql.NullTime
}

// prepareUsers builds the old-uid -> target-user-id map.
//
// THE ADMINISTRATOR IS NEVER DUPLICATED. cantor uid 1 is the built-in admin in
// every installation, and the target already has one; mapping it to the new
// superuser keeps the imported audit trail attached to the person who now
// administers the system instead of creating a second, disabled `admin`.
//
// EVERY OTHER IDENTITY IS CREATED DISABLED WITH NO PASSWORD. The import needs
// stable target ids for c_records.uid and the history tables, and the history
// page resolves those ids through /api/v1/users. Creating a disabled row is
// better than showing #46 forever, but it must not create a login: pass_hash
// is empty and status is disabled, so the IAM login path rejects the row before
// it ever compares a password.
func prepareUsers(ctx context.Context, source, target *sql.DB, opts Options, report *Report, log *slog.Logger) (map[int64]int64, error) {
	if opts.UserMode == UserModePreserve {
		used, err := usedUIDs(ctx, source, opts.Tables)
		if err != nil {
			return nil, err
		}
		report.UsersPreserved = len(used)
		return nil, nil
	}
	if opts.DryRun {
		// A dry run must not create identities, so there is no target id to map
		// an unknown source reference to. Keeping the source ids is enough to
		// exercise every row transform without writing.
		return nil, nil
	}

	targetOK, err := tableExists(ctx, target, "users")
	if err != nil {
		return nil, err
	}
	if !targetOK {
		return nil, fmt.Errorf("cantor import: target has no users table; cannot map audit users (use --users=preserve to keep numeric ids)")
	}
	adminID, err := targetAdminID(ctx, target)
	if err != nil {
		return nil, err
	}
	if adminID == 0 {
		return nil, fmt.Errorf("cantor import: target has no administrator to map cantor uid 1 to")
	}
	targetByEmail, err := targetEmails(ctx, target)
	if err != nil {
		return nil, err
	}
	sourceUsers, sourceHasUsers, err := readSourceUsers(ctx, source)
	if err != nil {
		return nil, err
	}
	if !sourceHasUsers {
		report.Warnings = append(report.Warnings,
			"source has no users table; every referenced user becomes a disabled placeholder")
	}
	used, err := usedUIDs(ctx, source, opts.Tables)
	if err != nil {
		return nil, err
	}

	mapping := make(map[int64]int64, len(used)+len(sourceUsers))
	// The administrator is always available as the fallback for a required,
	// NULL user reference, even when no source row happens to use uid 1.
	mapping[1] = adminID
	if opts.UserMode == UserModeAdmin {
		for _, old := range used {
			mapping[old] = adminID
			report.UsersMapped++
		}
		return mapping, nil
	}
	usedSet := make(map[int64]bool, len(used))
	for _, old := range used {
		usedSet[old] = true
	}

	create := func(u sourceUser, uid int64) (int64, error) {
		email := strings.TrimSpace(u.Email)
		if email == "" {
			email = fmt.Sprintf("cantor-uid-%d@invalid.local", uid)
		}
		if id, ok := targetByEmail[strings.ToLower(email)]; ok {
			report.UsersMapped++
			return id, nil
		}
		display := strings.TrimSpace(u.Nickname)
		if display == "" {
			display = strings.TrimSpace(u.Username)
		}
		if display == "" {
			display = email
		}
		display = truncateRunes(display, 128)
		phone := truncateRunes(strings.TrimSpace(u.Mobile), 32)
		created := time.Now().UTC()
		if u.DateJoined.Valid {
			created = u.DateJoined.Time.UTC()
		}
		res, err := target.ExecContext(ctx, `
INSERT INTO users (email, pass_hash, display_name, phone, role, is_superuser, status, created_at, updated_at)
VALUES (?, '', ?, ?, 'user', 0, 'disabled', ?, ?)`,
			email, display, phone, created, time.Now().UTC())
		if err != nil {
			if isDuplicateKey(err) {
				// A concurrent import won the race; use its row.
				var id int64
				if qerr := target.QueryRowContext(ctx, "SELECT id FROM users WHERE email = ?", email).Scan(&id); qerr == nil {
					targetByEmail[strings.ToLower(email)] = id
					report.UsersMapped++
					return id, nil
				}
			}
			return 0, fmt.Errorf("cantor import: create disabled user for uid %d: %w", uid, err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			return 0, err
		}
		targetByEmail[strings.ToLower(email)] = id
		report.UsersCreated++
		return id, nil
	}

	// Source users are processed first. UID 1 is the administrator; every other
	// source user becomes a disabled target identity (or maps by email).
	for _, u := range sourceUsers {
		if u.UID == 1 {
			mapping[u.UID] = adminID
			report.UsersMapped++
			continue
		}
		if !usedSet[u.UID] {
			// Cantor's users table contains identities that never touched a CMDB
			// row (agents, old accounts). Importing them would create disabled
			// IAM noise for no attribution benefit.
			continue
		}
		id, err := create(u, u.UID)
		if err != nil {
			return nil, err
		}
		mapping[u.UID] = id
	}

	// A history row can reference a user cantor has already deleted from its
	// users table. Keep the attribution with a placeholder rather than dropping
	// the row or pointing every unknown id at the administrator.
	for _, old := range used {
		if _, ok := mapping[old]; ok {
			continue
		}
		if old == 1 {
			mapping[old] = adminID
			report.UsersMapped++
			continue
		}
		id, err := create(sourceUser{UID: old}, old)
		if err != nil {
			return nil, err
		}
		mapping[old] = id
	}
	log.Info("cmdb import: users prepared",
		slog.Int("mapped", report.UsersMapped),
		slog.Int("created", report.UsersCreated))
	return mapping, nil
}

func targetAdminID(ctx context.Context, target *sql.DB) (int64, error) {
	var id int64
	err := target.QueryRowContext(ctx,
		"SELECT id FROM users WHERE is_superuser = 1 ORDER BY id LIMIT 1").Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, fmt.Errorf("cantor import: find target administrator: %w", err)
	}
	err = target.QueryRowContext(ctx, "SELECT id FROM users ORDER BY id LIMIT 1").Scan(&id)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("cantor import: find target administrator: %w", err)
	}
	return id, nil
}

func targetEmails(ctx context.Context, target *sql.DB) (map[string]int64, error) {
	rows, err := target.QueryContext(ctx, "SELECT id, email FROM users WHERE email IS NOT NULL AND email <> ''")
	if err != nil {
		return nil, fmt.Errorf("cantor import: list target users: %w", err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id int64
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		out[strings.ToLower(strings.TrimSpace(email))] = id
	}
	return out, rows.Err()
}

func readSourceUsers(ctx context.Context, source *sql.DB) ([]sourceUser, bool, error) {
	ok, err := tableExists(ctx, source, "users")
	if err != nil || !ok {
		return nil, ok, err
	}
	rows, err := source.QueryContext(ctx, `
SELECT uid, COALESCE(username, ''), COALESCE(nickname, ''), COALESCE(email, ''), COALESCE(mobile, ''), date_joined
FROM users ORDER BY uid`)
	if err != nil {
		return nil, true, fmt.Errorf("cantor import: read source users: %w", err)
	}
	defer rows.Close()
	var out []sourceUser
	for rows.Next() {
		var u sourceUser
		if err := rows.Scan(&u.UID, &u.Username, &u.Nickname, &u.Email, &u.Mobile, &u.DateJoined); err != nil {
			return nil, true, err
		}
		out = append(out, u)
	}
	return out, true, rows.Err()
}

// usedUIDs gathers every numeric user reference the copy will transform. It
// runs before the copy so placeholders exist before rows reference them.
func usedUIDs(ctx context.Context, source *sql.DB, tables []string) ([]int64, error) {
	if len(tables) == 0 {
		tables = cmdbTables
	}
	seen := map[int64]bool{}
	for _, table := range tables {
		ok, err := tableExists(ctx, source, table)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		cols, err := tableColumns(ctx, source, table)
		if err != nil {
			return nil, err
		}
		columnNames := map[string]bool{}
		for _, c := range cols {
			columnNames[c.Name] = true
		}
		for _, column := range []string{"uid", "owner"} {
			if !columnNames[column] {
				continue
			}
			if column == "owner" && table != "c_ad_rules" {
				continue
			}
			q, err := quoteIdent(table)
			if err != nil {
				return nil, err
			}
			cq, _ := quoteIdent(column)
			rows, err := source.QueryContext(ctx, "SELECT DISTINCT "+cq+" FROM "+q+" WHERE "+cq+" IS NOT NULL")
			if err != nil {
				return nil, fmt.Errorf("cantor import: read %s.%s: %w", table, column, err)
			}
			for rows.Next() {
				var raw sql.NullInt64
				if err := rows.Scan(&raw); err != nil {
					rows.Close()
					return nil, err
				}
				if raw.Valid {
					seen[raw.Int64] = true
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
	}
	out := make([]int64, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func truncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func isDuplicateKey(err error) bool {
	var me *driver.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}
