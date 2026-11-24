package scanner

import (
	"database/sql"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeDB(t *testing.T, topics ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "cache.db")
	db, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE messages (id TEXT, topic TEXT, message TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, tp := range topics {
		if _, err := db.Exec("INSERT INTO messages VALUES ('i', ?, 'm')", tp); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestScanMergesConfiguredAndDBTopics(t *testing.T) {
	s := New(makeDB(t, "user_custom", "all", "user_custom", "zzz"))
	got := s.Scan()
	set := map[string]bool{}
	for i, x := range got {
		set[x] = true
		if i > 0 && got[i-1] >= x {
			t.Fatalf("not strictly sorted: %v", got)
		}
	}
	if !set["user_custom"] || !set["zzz"] || !set["sec_yara"] || len(got) != len(ConfiguredTopics)+2 {
		t.Fatalf("%v", got)
	}
}

func TestScanSurvivesMissingDB(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "nope.db"))
	if got := s.Scan(); len(got) != len(ConfiguredTopics) {
		t.Fatalf("%v", got)
	}
}

func TestHTTP(t *testing.T) {
	s := New(makeDB(t))
	s.Now = func() time.Time { return time.Date(2026, 11, 24, 10, 0, 0, 5000, time.UTC) }
	s.Refresh()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" || !strings.HasSuffix(rec.Body.String(), `"updated": "2026-11-24T10:00:00.000005+00:00"}`) || !strings.HasPrefix(rec.Body.String(), `{"topics": ["all", `) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	for path, want := range map[string]int{"/health": 200, "/x": 404, "/?a=1": 404} {
		r := httptest.NewRecorder()
		s.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != want {
			t.Errorf("%s -> %d", path, r.Code)
		}
	}
}
