package mcpoauth

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY, secret_hash TEXT, redirect_uris TEXT NOT NULL,
  client_name TEXT, auth_method TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, sub TEXT NOT NULL, scope TEXT, resource TEXT,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
  sub TEXT NOT NULL, scope TEXT, resource TEXT, expires INTEGER NOT NULL,
  family TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family);
`

// store is the sqlite file: one connection, one lock, opened lazily like the Python service.
type store struct {
	path string
	mu   sync.Mutex
	db   *sql.DB
}

func (s *store) open() *sql.DB {
	if s.db != nil {
		return s.db
	}
	if d := filepath.Dir(s.path); d != "" && d != "." {
		if err := os.MkdirAll(d, 0o777); err != nil {
			panic(err)
		}
	}
	db, err := sql.Open("sqlite", s.path)
	if err != nil {
		panic(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		panic(err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		panic(err)
	}
	if _, err := db.Exec(schema); err != nil {
		panic(err)
	}
	s.db = db
	return db
}

func (s *store) exec(q string, args ...any) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.open().Exec(q, args...)
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n
}

// row runs a query expected to give at most one row and scans it into dest; false when there is none.
func (s *store) row(q string, dest []any, args ...any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rowLocked(q, dest, args...)
}

func (s *store) rowLocked(q string, dest []any, args ...any) bool {
	err := s.open().QueryRow(q, args...).Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		panic(err)
	}
	return true
}

// sqlDB is the part of *sql.DB the handlers use inside a locked section.
type sqlDB interface {
	QueryRow(q string, args ...any) *sql.Row
	Exec(q string, args ...any) (sql.Result, error)
}

// scanRow scans one row; false when there is none.
func scanRow(r *sql.Row, dest ...any) bool {
	err := r.Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		panic(err)
	}
	return true
}

// locked runs fn with the lock held (single-use read + delete).
func (s *store) locked(fn func(db sqlDB)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.open())
}

func (s *store) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		s.db.Close()
	}
}
