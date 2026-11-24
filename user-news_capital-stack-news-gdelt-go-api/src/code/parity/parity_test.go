//go:build parity

// Parity harness (#1882, gdelt-api): the same requests go to the Node service (server.ts under node 22
// with better-sqlite3, the reference) and to the Go port, both fed by one fake GDELT upstream, and the
// raw response bodies (key order and number formatting included) must be identical. PARITY_REQUIRE=1
// makes a missing toolchain a failure. PARITY_MUTATE=1 skews the Go side's upstream so the harness must go red.
package parity

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"gdelt-api/gdelt"
)

func free(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// upstream answers like GDELT, deterministically per (query, mode).
func upstream(mutate bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q, mode := r.URL.Query().Get("query"), r.URL.Query().Get("mode")
		if q == "fail topic" {
			http.Error(w, "boom", 500)
			return
		}
		if q == "partial" && mode == "timelinevol" {
			http.Error(w, "boom", 503)
			return
		}
		seed := len(q)
		switch mode {
		case "artlist":
			tone := "-2.5"
			if mutate {
				tone = "-9.5"
			}
			fmt.Fprintf(w, `{"articles":[{"url":"https://a/%[1]s","title":"<b>Tom & \"Jerry\" é %[1]s</b>","seendate":"20240101T000000Z","socialimage":"","domain":"a.com","language":"English","sourcecountry":"FR","tone":"%[2]s"},{"url":"u2","tone":%[3]d.25},{"title":"no tone, no url"},{"url":"u4","tone":"abc"},{"url":"u5","tone":1e2}]}`, q, tone, seed)
		case "timelinevol":
			fmt.Fprintf(w, `{"timeline":[{"series":"Volume","data":[{"date":"20240101T000000Z","value":%d.5},{"date":"20240102T000000Z","value":"3"},{"date":"20240103T000000Z"},{"date":"x","value":"zz"}]}]}`, seed)
		case "tonechart":
			fmt.Fprintf(w, `{"tonechart":[{"url":"x","title":"y","tone":"1.5","domain":"z"},{"url":"w","tone":%d}]}`, seed)
		default:
			http.Error(w, "bad mode", 400)
		}
	})
}

func startNode(t *testing.T, up string) string {
	dir, _ := filepath.Abs("../../../../user-news_capital-stack-news-gdelt-api/src/code")
	tmp := t.TempDir()
	// Node 22 (the production runtime) so better-sqlite3 has a prebuilt binary.
	run := func(cwd string, env []string, name string, args ...string) {
		cmd := exec.Command(name, args...)
		cmd.Dir = cwd
		cmd.Env = append(os.Environ(), env...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	if _, err := exec.LookPath("npm"); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("npm not found")
		}
		t.Skip("npm not found")
	}
	run(tmp, nil, "npm", "install", "--no-audit", "--no-fund", "--prefix", tmp, "node@22")
	node22 := filepath.Join(tmp, "node_modules", "node", "bin", "node")
	npmCli, _ := exec.Command("sh", "-c", "dirname $(readlink -f $(command -v npm))").Output()
	npmJS := filepath.Join(strings.TrimSpace(string(npmCli)), "..", "bin", "npm-cli.js")
	path := "PATH=" + filepath.Dir(node22) + ":" + os.Getenv("PATH")
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "better-sqlite3")); err != nil {
		run(dir, []string{path}, node22, npmJS, "ci", "--omit=dev", "--no-audit", "--no-fund")
	}
	port := free(t)
	cmd := exec.Command(node22, "--experimental-strip-types", "server.ts")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), path, fmt.Sprintf("PORT=%d", port), "MCP_HTTP_HOST=127.0.0.1", "CACHE_DIR="+t.TempDir(),
		"FETCH_INTERVAL=3600", "GDELT_BASE="+up, "BASE_PATH=/news")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func startGo(t *testing.T, up string) string {
	store, err := gdelt.Open(gdelt.Config{CacheDir: t.TempDir(), Base: up, FetchInterval: time.Hour, Pause: 500 * time.Millisecond, TopicPause: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	store.Start()
	ts := httptest.NewServer(&gdelt.Server{Store: store, BasePath: "/news", Started: time.Now()})
	t.Cleanup(ts.Close)
	return ts.URL
}

func body(base, method, path string) (int, string, string) {
	req, _ := http.NewRequest(method, base+path, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Content-Type") + "|" + resp.Header.Get("Access-Control-Allow-Origin") + "|" + resp.Header.Get("Access-Control-Allow-Methods"), string(b)
}

var vol = regexp.MustCompile(`"uptime":\d+`)
var ts = regexp.MustCompile(`"lastFetch":"[^"]+"`)

func norm(s string) string {
	return ts.ReplaceAllString(vol.ReplaceAllString(s, `"uptime":N`), `"lastFetch":"T"`)
}

func waitReady(t *testing.T, name, base string) {
	for i := 0; i < 180; i++ {
		_, _, b := body(base, "GET", "/health")
		if strings.Contains(b, `"cachedTopics":8`) && !strings.Contains(b, `"lastFetch":null`) {
			// the background loop ends with the last topic; give its final pause time to finish
			time.Sleep(2500 * time.Millisecond)
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("%s did not finish its initial fetch", name)
}

func TestParity(t *testing.T) {
	mut := os.Getenv("PARITY_MUTATE") == "1"
	refUp := httptest.NewServer(upstream(false))
	defer refUp.Close()
	goUp := httptest.NewServer(upstream(mut))
	defer goUp.Close()
	node := startNode(t, refUp.URL)
	gob := startGo(t, goUp.URL)
	waitReady(t, "node", node)
	waitReady(t, "go", gob)

	type req struct{ method, path string }
	reqs := []req{
		{"GET", "/health"},
		{"GET", "/news/topics"},
		{"GET", "/news/articles"},
		{"GET", "/news/articles?q=economy&limit=2"},
		{"GET", "/news/articles?q=economy&limit=0"},
		{"GET", "/news/articles?q=economy&limit=-5"},
		{"GET", "/news/articles?q=economy&limit=9999"},
		{"GET", "/news/articles?q=economy&limit=abc"},
		{"GET", "/news/articles?q=economy&limit=7x"},
		{"GET", "/news/articles?q=custom+query%20%26+more"},
		{"GET", "/news/articles?q=fail+topic"},
		{"GET", "/news/articles?q=partial"},
		{"GET", "/news/timeline"},
		{"GET", "/news/timeline?q=energy"},
		{"GET", "/news/timeline?q=partial"},
		{"GET", "/news/tone"},
		{"GET", "/news/tone?q=health"},
		{"GET", "/news/tone?q=partial"},
		{"GET", "/news/topics"},
		{"GET", "/health"},
		{"GET", "/news/nope"},
		{"GET", "/nope?x=1"},
		{"GET", "/news/articles/"},
		{"POST", "/news/articles"},
		{"OPTIONS", "/anything"},
		{"OPTIONS", "/news/articles"},
	}
	bad := 0
	for _, r := range reqs {
		c1, h1, b1 := body(node, r.method, r.path)
		c2, h2, b2 := body(gob, r.method, r.path)
		b1, b2 = norm(b1), norm(b2)
		t.Logf("%-8s %-46s %d %s", r.method, r.path, c1, truncate(b1, 90))
		if c1 != c2 || h1 != h2 || b1 != b2 {
			bad++
			t.Errorf("DIFF %s %s\n  node: %d %s %s\n  go:   %d %s %s", r.method, r.path, c1, h1, truncate(b1, 400), c2, h2, truncate(b2, 400))
		}
	}
	if bad > 0 {
		t.Fatalf("%d of %d requests differ", bad, len(reqs))
	}
	t.Logf("parity: %d requests identical", len(reqs))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
