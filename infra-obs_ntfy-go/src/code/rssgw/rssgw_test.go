package rssgw

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const ndjson = `{"id":"a1","time":100,"event":"message","topic":"t1","title":"Hello <b>","message":"x & y","tags":["a","b"],"click":"https://e.x/?a=1&b=2"}
{"event":"open","topic":"t1"}
{"id":"a2","time":200,"event":"message","topic":"t2","message":"later"}
not json
`

func newGW(t *testing.T) (*Gateway, *httptest.Server) {
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "boom") {
			http.Error(w, "no", 500)
			return
		}
		w.Write([]byte(ndjson))
	}))
	t.Cleanup(ntfy.Close)
	dir := t.TempDir()
	prof := filepath.Join(dir, "p.json")
	os.WriteFile(prof, []byte(`{"base":"https://rss.example/feed","profiles":[{"id":"p1","title":"Prof","channels":[{"name":"t1"},{"name":"t2"}]}],"channels":[{"name":"t1"}]}`), 0o644)
	chans := filepath.Join(dir, "c.json")
	os.WriteFile(chans, []byte(`{"channels":[{"topic":"logs_x"}]}`), 0o644)
	g := New()
	g.ProfilesConfig, g.ChannelsConfig, g.NtfyInternal = prof, chans, ntfy.URL
	g.Now = func() time.Time { return time.Unix(0, 0) }
	return g, ntfy
}

func get(g *Gateway, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func TestRoutes(t *testing.T) {
	g, _ := newGW(t)
	if r := get(g, "/feed/health"); r.Code != 200 || r.Body.String() != "{\n  \"status\": \"ok\"\n}" {
		t.Fatalf("%d %q", r.Code, r.Body.String())
	}
	if r := get(g, "/feed/profiles.json?x=1"); r.Code != 200 || !strings.HasPrefix(r.Body.String(), "{\n  \"base\": \"https://rss.example/feed\"") {
		t.Fatal(r.Body.String())
	}
	if r := get(g, "/feed/channels.json"); !strings.Contains(r.Body.String(), `"topic": "logs_x"`) {
		t.Fatal(r.Body.String())
	}
	r := get(g, "/feed/p1.atom")
	if r.Code != 200 || r.Header().Get("Content-Type") != "application/atom+xml; charset=utf-8" {
		t.Fatalf("%d %v", r.Code, r.Header())
	}
	b := r.Body.String()
	// newest first; the Python double escaping of click links is preserved
	if strings.Index(b, "urn:ntfy:a2") > strings.Index(b, "urn:ntfy:a1") || !strings.Contains(b, "<title>Hello &lt;b&gt;</title>") || !strings.Contains(b, "<updated>1970-01-01T00:03:20Z</updated>") {
		t.Fatal(b)
	}
	if !strings.Contains(b, `<content type="text">x &amp; y | Tags: a, b | Link: https://e.x/?a=1&amp;amp;b=2</content>`) {
		t.Fatal(b)
	}
	if r := get(g, "/feed/c/logs_x.atom"); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if r := get(g, "/feed/c/ghost.atom"); r.Code != 404 || !strings.Contains(r.Body.String(), "<p>Message: Unknown channel: ghost.</p>") {
		t.Fatal(r.Body.String())
	}
	if r := get(g, "/feed/nope.atom"); r.Code != 404 {
		t.Fatal(r.Code)
	}
	if r := get(g, "/elsewhere"); r.Code != 404 || r.Header().Get("Content-Type") != "text/html;charset=utf-8" {
		t.Fatal(r.Code)
	}
}

func TestConfigUnavailableIs503(t *testing.T) {
	g, _ := newGW(t)
	g.ProfilesConfig = filepath.Join(t.TempDir(), "missing.json")
	if r := get(g, "/feed/health"); r.Code != 503 {
		t.Fatal(r.Code)
	}
}

func TestPollErrorYieldsEmptyFeed(t *testing.T) {
	g, _ := newGW(t)
	if got := g.ntfyPoll([]string{"boom"}); len(got) != 0 {
		t.Fatal("HTTP 500 must yield no messages")
	}
}
