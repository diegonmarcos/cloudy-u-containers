// Package scanner is the Go port of topic-scanner.py: it serves every configured ntfy topic plus any topic found in
// the ntfy cache.db, refreshed in the background.
package scanner

import (
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"ntfy-sidecars/pyjson"

	_ "modernc.org/sqlite"
)

// ConfiguredTopics is the full taxonomy, shown even before the first message arrives.
var ConfiguredTopics = []string{
	"all",
	"dev_commits", "dev_pull-requests", "dev_releases",
	"deploy_ship", "deploy_containers",
	"health_mesh", "health_endpoints", "health_dns", "health_resources", "health_containers",
	"ops_backups", "ops_reports",
	"sec_audit", "sec_tls", "sec_connections", "sec_yara",
}

// Scanner holds the refresh state.
type Scanner struct {
	DBPath string
	Logf   func(string, ...any)
	Now    func() time.Time

	mu      sync.Mutex
	topics  []string
	updated string
}

// New returns a scanner on the production cache path.
func New(dbPath string) *Scanner {
	return &Scanner{DBPath: dbPath, Now: time.Now}
}

func (s *Scanner) logf(f string, a ...any) {
	if s.Logf != nil {
		s.Logf(f, a...)
	}
}

// Scan returns all configured topics plus those found in cache.db, sorted and de-duplicated.
func (s *Scanner) Scan() []string {
	set := map[string]bool{}
	for _, t := range ConfiguredTopics {
		set[t] = true
	}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", s.DBPath))
	if err == nil {
		defer db.Close()
		rows, qerr := db.Query("SELECT DISTINCT topic FROM messages ORDER BY topic")
		if qerr != nil {
			err = qerr
		} else {
			for rows.Next() {
				var t string
				if rows.Scan(&t) == nil {
					set[t] = true
				}
			}
			if e := rows.Err(); e != nil {
				err = e
			}
			rows.Close()
		}
	}
	if err != nil {
		s.logf("[scanner] warning: could not read cache.db: %v", err)
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// isoformat is datetime.now(timezone.utc).isoformat().
func isoformat(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond()/1000 == 0 {
		return t.Format("2006-01-02T15:04:05") + "+00:00"
	}
	return t.Format("2006-01-02T15:04:05.000000") + "+00:00"
}

// Refresh rescans and stores the result.
func (s *Scanner) Refresh() {
	r := s.Scan()
	s.mu.Lock()
	s.topics = r
	s.updated = isoformat(s.Now())
	s.mu.Unlock()
	s.logf("[scanner] refreshed: %d topics", len(r))
}

// Loop refreshes every interval until stop is closed.
func (s *Scanner) Loop(interval time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.Refresh()
		}
	}
}

// ServeHTTP implements http.Handler: "/" topics JSON, "/health" ok, anything else 404 with an empty body.
func (s *Scanner) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Unsupported method", http.StatusNotImplemented)
		return
	}
	switch strings.TrimSpace(r.RequestURI) {
	case "/", "":
		s.mu.Lock()
		o := pyjson.NewOMap()
		o.Set("topics", append([]string{}, s.topics...))
		o.Set("updated", s.updated)
		s.mu.Unlock()
		body := pyjson.Dumps(o, -1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(body))
	case "/health":
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	default:
		w.WriteHeader(404)
	}
}
