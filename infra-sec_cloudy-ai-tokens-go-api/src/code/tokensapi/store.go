package tokensapi

import (
	"database/sql"
	"errors"
	"math/big"
	"strings"
	"sync"

	_ "modernc.org/sqlite"

	"tokens-api/fleetauth"
)

const schemaTokens = `CREATE TABLE IF NOT EXISTS tokens(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  audience TEXT NOT NULL, scopes TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
  last_used_at INTEGER, created_by TEXT NOT NULL, source TEXT NOT NULL,
  hint TEXT NOT NULL, idx TEXT NOT NULL UNIQUE, nonce BLOB NOT NULL, ct BLOB NOT NULL)`

const schemaAudit = `CREATE TABLE IF NOT EXISTS audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, token_id TEXT, token_name TEXT, detail TEXT NOT NULL DEFAULT '')`

// ErrIntegrity is sqlite3.IntegrityError (the UNIQUE index of a token value).
var ErrIntegrity = errors.New("IntegrityError")

// Row is one tokens row.
type Row struct {
	ID, Name, Kind, Audience, Scopes, Subject string
	CreatedAt                                 int64
	ExpiresAt, RevokedAt, LastUsedAt          sql.NullInt64
	CreatedBy, Source, Hint, Idx              string
	Nonce, Ct                                 []byte
}

const cols = "id,name,kind,audience,scopes,subject,created_at,expires_at,revoked_at,last_used_at,created_by,source,hint,idx,nonce,ct"

func scan(sc interface{ Scan(...any) error }) (*Row, error) {
	var r Row
	err := sc.Scan(&r.ID, &r.Name, &r.Kind, &r.Audience, &r.Scopes, &r.Subject, &r.CreatedAt, &r.ExpiresAt, &r.RevokedAt,
		&r.LastUsedAt, &r.CreatedBy, &r.Source, &r.Hint, &r.Idx, &r.Nonce, &r.Ct)
	return &r, err
}

// Store is the sqlite file: one connection, one lock, like the Python service.
type Store struct {
	vault *Vault
	rnd   func(n int) []byte
	now   func() int64
	mu    sync.Mutex
	db    *sql.DB
}

// OpenStore opens (and creates) the database.
func OpenStore(path string, v *Vault, rnd func(int) []byte, now func() int64) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, q := range []string{"PRAGMA journal_mode=WAL", schemaTokens, schemaAudit, "PRAGMA busy_timeout=5000"} {
		if _, err := db.Exec(q); err != nil {
			return nil, err
		}
	}
	return &Store{vault: v, rnd: rnd, now: now, db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func chk(err error) {
	if err != nil {
		panic(err)
	}
}

// Audit never receives a token value: callers pass ids, names and short reasons only.
func (s *Store) Audit(actor, action, tokenID, tokenName, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mustText(actor, action, tokenID, tokenName, detail)
	_, err := s.db.Exec("INSERT INTO audit(ts,actor,action,token_id,token_name,detail) VALUES(?,?,?,?,?,?)",
		s.now(), actor, action, tokenID, tokenName, fleetauth.CPHead(detail, 200))
	chk(err)
}

func mustText(ss ...string) {
	for _, x := range ss {
		if fleetauth.HasSurrogate(x) {
			panic("UnicodeEncodeError: surrogates not allowed")
		}
	}
}

// Insert stores a token and returns its id. expires may be nil. An error is IntegrityError or the
// ValueError family (text sqlite cannot encode); a value outside 64 bits panics like OverflowError.
func (s *Store) Insert(name, kind, audience string, scopesJSON string, subject string, expires *big.Int, createdBy, source, value string) (string, error) {
	id := "tk_" + hexOf(s.rnd(5))
	nonce, ct := s.vault.Seal(id, value)
	s.mu.Lock()
	defer s.mu.Unlock()
	if fleetauth.HasSurrogate(name) || fleetauth.HasSurrogate(subject) || fleetauth.HasSurrogate(createdBy) || fleetauth.HasSurrogate(audience) || fleetauth.HasSurrogate(scopesJSON) {
		return "", errors.New("UnicodeEncodeError")
	}
	var exp any
	if expires != nil {
		if !expires.IsInt64() {
			panic("OverflowError: Python int too large to convert to SQLite INTEGER")
		}
		exp = expires.Int64()
	}
	_, err := s.db.Exec("INSERT INTO tokens(id,name,kind,audience,scopes,subject,created_at,expires_at,created_by,source,hint,idx,nonce,ct)"+
		" VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		id, name, kind, audience, scopesJSON, subject, s.now(), exp, createdBy, source, fleetauth.CPTail(value, 4), s.vault.Index(value), nonce, ct)
	if err != nil {
		if strings.Contains(err.Error(), "constraint") {
			return "", ErrIntegrity
		}
		panic(err)
	}
	return id, nil
}

func hexOf(b []byte) string {
	const h = "0123456789abcdef"
	out := make([]byte, 0, 2*len(b))
	for _, c := range b {
		out = append(out, h[c>>4], h[c&15])
	}
	return string(out)
}

func (s *Store) one(where string, arg any) *Row {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := scan(s.db.QueryRow("SELECT "+cols+" FROM tokens WHERE "+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	chk(err)
	return r
}

// ByIndex looks a token value up through its HMAC index.
func (s *Store) ByIndex(value string) *Row { return s.one("idx=?", s.vault.Index(value)) }

// Get returns a row by id.
func (s *Store) Get(id string) *Row { return s.one("id=?", id) }

// All lists every row, newest first.
func (s *Store) All() []*Row {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query("SELECT " + cols + " FROM tokens ORDER BY created_at DESC, id")
	chk(err)
	defer rows.Close()
	var out []*Row
	for rows.Next() {
		r, err := scan(rows)
		chk(err)
		out = append(out, r)
	}
	chk(rows.Err())
	return out
}

// Touch records a use at most once a minute.
func (s *Store) Touch(id string, now int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec("UPDATE tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)", now, id, now-60)
	chk(err)
}

// Revoke marks a token revoked; the count is 1 only the first time.
func (s *Store) Revoke(id string, now int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec("UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", now, id)
	chk(err)
	n, _ := res.RowsAffected()
	return n
}

// AuditRows returns the newest audit rows.
func (s *Store) AuditRows(limit int64) []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query("SELECT seq,ts,actor,action,token_id,token_name,detail FROM audit ORDER BY seq DESC LIMIT ?", limit)
	chk(err)
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var seq, ts int64
		var actor, action string
		var tid, tnm sql.NullString
		var detail string
		chk(rows.Scan(&seq, &ts, &actor, &action, &tid, &tnm, &detail))
		m := map[string]any{"seq": seq, "ts": ts, "actor": actor, "action": action, "detail": detail, "token_id": nil, "token_name": nil}
		if tid.Valid {
			m["token_id"] = tid.String
		}
		if tnm.Valid {
			m["token_name"] = tnm.String
		}
		out = append(out, m)
	}
	chk(rows.Err())
	return out
}
