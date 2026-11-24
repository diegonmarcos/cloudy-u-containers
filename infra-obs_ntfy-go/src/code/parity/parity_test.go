//go:build parity

// Package parity runs the ORIGINAL Python sidecars (infra-obs_ntfy/src/code, unmodified, via ref.py) and the Go port on
// identical inputs and requires identical outputs: broker decide() over thousands of generated event sequences and
// four policies, digest summarize()/read_history(), the topic scanner, the GitHub Atom parser and classifier, the
// syslog alert parser, and the whole RSS gateway over HTTP (status, content type and body of every route).
//
// Run: PARITY_REQUIRE=1 go test -count=1 -tags parity -v -run TestParity ./parity/
package parity

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"ntfy-sidecars/broker"
	"ntfy-sidecars/digest"
	"ntfy-sidecars/ghrss"
	"ntfy-sidecars/rssgw"
	"ntfy-sidecars/scanner"
	"ntfy-sidecars/syslogbr"
)

func requirePython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("python3 is required for the parity harness")
		}
		t.Skip("python3 not available")
	}
}

// py runs ref.py <cmd> with req on stdin and decodes its stdout.
func py(t *testing.T, cmd string, req any) any {
	t.Helper()
	requirePython(t)
	in, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	c := exec.Command("python3", "ref.py", cmd)
	c.Stdin = bytes.NewReader(in)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		t.Fatalf("ref.py %s: %v\n%s", cmd, err, errb.String())
	}
	var v any
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		t.Fatalf("ref.py %s output: %v\n%s", cmd, err, out.String())
	}
	return v
}

// norm round-trips a Go value through JSON so it has the same dynamic types as the Python output.
func norm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }

// firstDiff reports the first index where two slices of JSON values differ ("" when equal).
func firstDiff(want, got []any) string {
	if len(want) != len(got) {
		return fmt.Sprintf("length: python %d, go %d", len(want), len(got))
	}
	for i := range want {
		if !reflect.DeepEqual(want[i], got[i]) {
			return fmt.Sprintf("item %d\n python: %s\n go:     %s", i, js(want[i]), js(got[i]))
		}
	}
	return ""
}

// ---- broker ---------------------------------------------------------------------------------------------------

func policyDoc(t *testing.T, variant int) string {
	base := `{
 "severity_map": {"default": "info", "by_class": {"load_shed": "crit", "psi_high": "warn", "deploy_failed": "page", "recovered": "info", "disk_full": "crit"}},
 "category_by_unit": %s,
 "routing": {"rules": [
  {"match": "category:resources", "channels": {
    "info": [{"kind": "ntfy", "topic": "health_resources"}],
    "warn": [{"kind": "ntfy", "topic": "health_resources"}],
    "crit": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}],
    "page": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}, {"kind": "email"}]}},
  {"match": "category:mesh", "channels": {
    "info": [{"kind": "ntfy", "topic": "health_mesh"}],
    "warn": [{"kind": "ntfy", "topic": "health_mesh"}],
    "crit": [{"kind": "ntfy", "topic": "health_mesh"}],
    "page": [{"kind": "ntfy", "topic": "health_mesh"}, {"kind": "matrix"}, {"kind": "email"}]}},
  {"match": "default", "channels": {
    "info": [{"kind": "ntfy", "topic": "health_resources"}],
    "warn": [{"kind": "ntfy", "topic": "ops_reports"}],
    "crit": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}]}}]},
 "dedup": %s,
 "flap": %s,
 "escalation": %s,
 "recovery": %s
}`
	unitsA := `{"load-shedder": "resources", "caddy": "endpoints", "wg-quick*": "mesh"}`
	units := []string{
		unitsA,
		`{"_comment": "x", "wg-*": "net_a", "*-wg0": "net_b", "wg-quick-w*": "mesh", "*ick-wg0": "resources", "load-?hedder": "resources", "[ab]*": "mesh", "caddy": "endpoints"}`,
		`{"*ick-wg0": "resources", "wg-quick-w*": "mesh", "wg-*": "net_a", "_skip*": "mesh"}`,
		unitsA,
	}
	dedup := []string{`{"window_secs": 300, "by_key": {}}`, `{"window_secs": 120, "by_key": {"k1": 900, "k2": 5}}`, `{"window_secs": 300}`, `{}`}
	flap := []string{
		`{"enabled": true, "transitions": 4, "window_secs": 900, "mute_after_flap_secs": 1800}`,
		`{"enabled": false}`,
		`{"enabled": true, "transitions": 2, "window_secs": 300, "mute_after_flap_secs": 100}`,
		`{}`,
	}
	esc := []string{
		`{"enabled": true, "warn_to_crit_secs": 900, "crit_to_page_secs": 1800}`,
		`{"enabled": false}`,
		`{"enabled": true, "warn_to_crit_secs": 60, "crit_to_page_secs": 200}`,
		`{"enabled": true}`,
	}
	rec := []string{`{"enabled": true, "notice_severity": "info"}`, `{"enabled": false}`, `{"enabled": true, "notice_severity": "warn"}`, `{}`}
	return fmt.Sprintf(base, units[variant], dedup[variant], flap[variant], esc[variant], rec[variant])
}

func genSteps(seed int64, n int) []map[string]any {
	r := rand.New(rand.NewSource(seed))
	pick := func(xs ...string) string { return xs[r.Intn(len(xs))] }
	now := 1000
	steps := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		now += []int{0, 1, 10, 30, 30, 100, 299, 301, 600, 899, 901, 1000, 1801, 2000}[r.Intn(14)]
		ev := map[string]any{}
		if r.Intn(10) > 0 {
			ev["key"] = pick("k1", "k2", "k3", "oci-mail:load_shed")
		}
		if r.Intn(5) > 0 {
			ev["class"] = pick("load_shed", "psi_high", "deploy_failed", "recovered", "disk_ok", "mesh_ok", "unknown_class", "disk_full")
		}
		if r.Intn(6) == 0 {
			ev["severity"] = pick("info", "warn", "crit", "page", "bogus")
		}
		if r.Intn(4) == 0 {
			ev["category"] = pick("resources", "mesh", "nothing", "")
		}
		if r.Intn(3) > 0 {
			ev["unit"] = pick("load-shedder", "wg-quick-wg0", "wg-quick-wg1", "caddy", "_hidden", "nomatch", "alpha", "bravo", "")
		}
		if r.Intn(3) == 0 {
			ev["recovered"] = r.Intn(2) == 0
		}
		if r.Intn(12) == 0 {
			ev["ack"] = true
		}
		if r.Intn(2) == 0 {
			ev["title"] = pick("shed", "mesh down", "t")
		}
		if r.Intn(2) == 0 {
			ev["body"] = pick("b", "body text", "")
		}
		if r.Intn(4) == 0 {
			ev["source"] = pick("load-shedder", "health-agent")
		}
		steps = append(steps, map[string]any{"event": ev, "now": now})
	}
	return steps
}

func TestParityBrokerDecide(t *testing.T) {
	total := 0
	for variant := 0; variant < 4; variant++ {
		doc := policyDoc(t, variant)
		pol, err := broker.ParsePolicy([]byte(doc))
		if err != nil {
			t.Fatal(err)
		}
		var policyAny any
		_ = json.Unmarshal([]byte(doc), &policyAny)
		for seed := int64(1); seed <= 6; seed++ {
			steps := norm(t, genSteps(seed*100+int64(variant), 500)).([]any)
			want := py(t, "broker", map[string]any{"policy": policyAny, "steps": steps}).([]any)
			var got []any
			state := broker.M{}
			for _, s := range steps {
				st := s.(map[string]any)
				var actions []broker.M
				actions, state = broker.Decide(st["event"].(map[string]any), pol, state, st["now"].(float64))
				if actions == nil {
					actions = []broker.M{}
				}
				got = append(got, map[string]any{"actions": actions, "state": state})
			}
			if d := firstDiff(want, norm(t, got).([]any)); d != "" {
				t.Fatalf("variant %d seed %d: %s", variant, seed, d)
			}
			total += len(steps)
		}
	}
	t.Logf("broker decide(): %d generated steps identical to Python", total)
}

// ---- digest ---------------------------------------------------------------------------------------------------

func digestJSON(d digest.Digest) map[string]any {
	return map[string]any{
		"title": d.Title, "body": d.Body,
		"stats": map[string]any{
			"overall": d.Stats.Overall, "window": d.Stats.Window, "state_counts": d.Stats.StateCounts, "incidents": d.Stats.Incidents,
			"reds_now": d.Stats.RedsNow, "yellows_now": d.Stats.YellowsNow, "green_count": d.Stats.GreenCount,
		},
	}
}

func TestParityDigest(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	var cases []map[string]any
	for i := 0; i < 300; i++ {
		recs := []map[string]any{}
		for j := r.Intn(40); j > 0; j-- {
			rec := map[string]any{"service": []string{"maddy", "caddy", "gitea", "ntfy", "stalwart", "photoprism"}[r.Intn(6)]}
			if r.Intn(12) > 0 {
				rec["ts"] = 1_700_000_000 + r.Intn(100000)
			}
			if r.Intn(20) > 0 {
				rec["state"] = []string{"green", "green", "yellow", "red", "red", "unknown", "stale", "weird"}[r.Intn(8)]
			}
			if r.Intn(2) == 0 {
				rec["detail"] = []string{"OOM", "swap thrash ", "", "disk 99%"}[r.Intn(4)]
			}
			recs = append(recs, rec)
		}
		cases = append(cases, map[string]any{"records": recs, "now": 1_700_100_000 + r.Intn(5000), "weekly": r.Intn(2) == 0})
	}
	want := py(t, "digest", map[string]any{"cases": cases}).([]any)
	var got []any
	for _, c := range norm(t, cases).([]any) {
		cm := c.(map[string]any)
		var recs []digest.Record
		for _, x := range cm["records"].([]any) {
			recs = append(recs, x.(map[string]any))
		}
		got = append(got, digestJSON(digest.Summarize(recs, cm["now"].(float64), cm["weekly"].(bool))))
	}
	if d := firstDiff(want, norm(t, got).([]any)); d != "" {
		t.Fatal(d)
	}
}

func TestParityReadHistory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "h.jsonl")
	lines := []string{
		`{"ts": 100, "service": "a", "state": "green"}`, `garbage`, ``, `   `, `[1, 2]`, `{"ts": "str"}`, `{"ts": null}`, `{"service": "nots"}`,
		`{"ts": 5}`, `{"ts": 99.5, "service": "f"}`, `{"ts": 100.0}`, `"a string"`, `42`, `{"ts": true}`,
	}
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, since := range []float64{0, 50, 100, 100.5} {
		want := py(t, "history", map[string]any{"path": p, "since": since}).([]any)
		recs := digest.ReadHistory(p, since)
		got := []any{}
		for _, r := range recs {
			got = append(got, r)
		}
		if d := firstDiff(want, norm(t, got).([]any)); d != "" {
			t.Fatalf("since %v: %s", since, d)
		}
	}
}

// ---- scanner --------------------------------------------------------------------------------------------------

func TestParityScanner(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cache.db")
	db, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE messages (id TEXT, topic TEXT, message TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, tp := range []string{"zeta", "alpha", "all", "user_é", "sec_yara", "Upper", "alpha", "x y"} {
		if _, err := db.Exec("INSERT INTO messages VALUES ('i', ?, 'm')", tp); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	for _, dbPath := range []string{p, filepath.Join(t.TempDir(), "missing.db")} {
		want := py(t, "scanner", map[string]any{"db": dbPath}).(map[string]any)
		s := scanner.New(dbPath)
		got := s.Scan()
		if !reflect.DeepEqual(want["topics"], norm(t, got)) {
			t.Fatalf("%s\n python %v\n go     %v", dbPath, want["topics"], got)
		}
		s2 := scanner.New(dbPath)
		s2.Now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
		s2.Refresh()
		rec := httptest.NewRecorder()
		s2.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
		wantBody := strings.Replace(want["dumped"].(string), `"updated": "U"`, `"updated": "2026-01-01T00:00:00+00:00"`, 1)
		if rec.Body.String() != wantBody {
			t.Fatalf("body\n python %s\n go     %s", wantBody, rec.Body.String())
		}
	}
}

// ---- github rss -----------------------------------------------------------------------------------------------

func atomFixtures() []string {
	var many strings.Builder
	many.WriteString(`<feed xmlns="http://www.w3.org/2005/Atom">`)
	for i := 0; i < 14; i++ {
		fmt.Fprintf(&many, `<entry><title>diegonmarcos pushed to branch-%d</title><link href="https://github.com/o/r%d/compare/a...b"/><updated>2026-11-24T10:00:0%dZ</updated><content type="html">&lt;p&gt;msg %d&lt;/p&gt;</content></entry>`, i, i, i%10, i)
	}
	many.WriteString(`</feed>`)
	return []string{
		`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><title type="html">diegonmarcos pushed to main in a/b</title><link rel="alternate" href="https://github.com/a/b/compare/1...2"/><updated>2026-11-24T10:00:00Z</updated><content type="html">&lt;div class="x"&gt;&lt;a href="u"&gt;fix &amp;amp; ship &amp;quot;it&amp;quot; &amp;lt;ok&amp;gt;&lt;/a&gt;   now   é ☃&lt;/div&gt;</content></entry><entry><title>no content or link</title></entry><entry><link href="https://github.com/o/r"/></entry></feed>`,
		many.String(),
		`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>first</title></entry><entry><title></title><link href="x"/></entry><entry><title>third</title></entry></feed>`,
		`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>xhtml</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">a <b>bold</b> tail <i>it</i>.</div></content></entry></feed>`,
		`<feed xmlns="http://www.w3.org/2005/Atom"><wrap><entry><title>nested entry</title></entry></wrap></feed>`,
		`<feed xmlns="http://other.example/ns"><entry><title>wrong namespace</title></entry></feed>`,
		`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>unterminated`,
		``,
		`not xml at all`,
	}
}

func TestParityGithubRSS(t *testing.T) {
	titles := []string{
		"x pushed to main", "Committed something", "created branch b", "deleted branch b", "opened a pull request", "merged x",
		"released v1", "tagged v2", "created tag t", "opened an issue", "closed an issue", "forked r", "starred r", "watched r",
		"random text", "", "PUSHED TO main", "pull request pushed to", "issue pull request",
	}
	html := []string{"", "plain", "<b>bold</b> text", "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;", "  many   spaces\n\tand\ttabs ", "<a href='x'>l</a><br/>z", "1 < 2 > 0", "&amp;lt;"}
	want := py(t, "ghrss", map[string]any{"titles": titles, "html": html, "feeds": atomFixtures()}).(map[string]any)
	var gotClassify, gotStrip, gotParse []any
	for _, ti := range titles {
		tp, ev := ghrss.Classify(ti)
		gotClassify = append(gotClassify, []any{tp, ev})
	}
	for _, h := range html {
		gotStrip = append(gotStrip, ghrss.StripHTML(h))
	}
	for _, f := range atomFixtures() {
		entries := []any{}
		for _, e := range ghrss.ParseAtom(f) {
			entries = append(entries, map[string]any{"id": e.ID, "title": e.Title, "link": e.Link, "updated": e.Updated, "content": e.Content})
		}
		gotParse = append(gotParse, entries)
	}
	for name, pair := range map[string][2][]any{
		"classify": {want["classify"].([]any), gotClassify}, "strip_html": {want["strip"].([]any), gotStrip}, "parse_atom": {want["parse"].([]any), gotParse},
	} {
		if d := firstDiff(pair[0], norm(t, pair[1]).([]any)); d != "" {
			t.Fatalf("%s: %s", name, d)
		}
	}
}

// ---- syslog ---------------------------------------------------------------------------------------------------

func TestParitySyslog(t *testing.T) {
	lines := []string{
		`Nov 24 sauron: {"vm":"oci-mail","ts":"2026-11-24T10:00:00Z","alert":{"rule":"Webshell","path":"/var/www/x.php"}}`,
		`plain line`, `{"vm":"only"}`, `{"vm":"a","alert":{}}`, `{"vm":"a","ts":5,"alert":{"rule":7,"path":null}}`, `x {"vm": broken} y`,
		`{"vm":"a"} trailing } brace`, `prefix {"vm":"é☃","alert":{"rule":"R\"q"}}`, `{"vm":"a"}{"vm":"b"}`, `{"vm":true,"ts":1.5}`,
	}
	want := py(t, "syslog", map[string]any{"lines": lines}).([]any)
	var got []any
	for _, l := range lines {
		a, ok := syslogbr.ParseAlert(l)
		if !ok {
			got = append(got, nil)
			continue
		}
		title, msg := syslogbr.Format(a)
		got = append(got, map[string]any{"title": title, "message": msg})
	}
	if d := firstDiff(want, norm(t, got).([]any)); d != "" {
		t.Fatal(d)
	}
}

// ---- rss gateway (whole HTTP surface) ---------------------------------------------------------------------------

var updatedRE = regexp.MustCompile(`<updated>[^<]*</updated>`)

func httpGet(t *testing.T, base, path string) (int, string, string) {
	t.Helper()
	resp, err := http.Get(base + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header.Get("Content-Type"), string(b)
}

func TestParityRSSGateway(t *testing.T) {
	requirePython(t)
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		topics := strings.Split(strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)[0], ",")
		if topics[0] == "empty_topic" {
			return
		}
		if topics[0] == "http_err" {
			http.Error(w, "boom", 500)
			return
		}
		for i, tp := range topics {
			fmt.Fprintf(w, `{"id":"id%d","time":%d,"event":"message","topic":"%s","title":"Ti<tle> & %d","message":"m & <b> é☃ %d","tags":["x","y&z"],"click":"https://e.x/?a=1&b=2"}`+"\n", i, 1_700_000_000+i*10, tp, i, i)
			fmt.Fprintf(w, `{"id":"o%d","time":%d,"event":"open","topic":"%s"}`+"\n", i, 1_700_000_500, tp)
			fmt.Fprintf(w, `{"id":"n%d","time":%d,"event":"message","topic":"%s","message":""}`+"\n", i, 1_700_000_000+i*10, tp)
		}
		fmt.Fprint(w, "not json\n")
	}))
	defer ntfy.Close()

	dir := t.TempDir()
	prof := filepath.Join(dir, "profiles.json")
	chans := filepath.Join(dir, "channels.json")
	profDoc := `{
  "schema": 1, "base": "https://rss.example.com/feed", "float": 1.50, "big": 1e20, "neg0": -0, "uni": "é☃😀 \"q\" \\ /",
  "profiles": [
    {"id": "all", "title": "Everything & more", "channels": [{"name": "dev_commits"}, {"name": "sec_yara"}]},
    {"id": "empty", "title": "Empty", "channels": [{"name": "empty_topic"}]},
    {"id": "noch", "title": "No channels", "channels": []},
    {"id": "err", "title": "Err", "channels": [{"name": "http_err"}]}
  ],
  "channels": [{"name": "dev_commits", "x": [1, 2, {"z": null}]}, {"name": "sec_yara"}, {"name": "empty_topic"}, {"name": "http_err"}],
  "zz": {}, "aa": []
}`
	chanDoc := `{"tree": {"b": 1, "a": [true, false]}, "channels": [{"topic": "logs_x"}, {"topic": "app_y"}]}`
	if err := os.WriteFile(prof, []byte(profDoc), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chans, []byte(chanDoc), 0o644); err != nil {
		t.Fatal(err)
	}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cfg, _ := json.Marshal(map[string]any{"port": port, "profiles": prof, "channels": chans, "ntfy": ntfy.URL})
	cmd := exec.Command("python3", "ref.py", "rss-serve", string(cfg))
	stdout, _ := cmd.StdoutPipe()
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("python gateway did not start: %q %v %s", line, err, errb.String())
	}
	pyBase := fmt.Sprintf("http://127.0.0.1:%d", port)

	g := rssgw.New()
	g.ProfilesConfig, g.ChannelsConfig, g.NtfyInternal = prof, chans, ntfy.URL
	goSrv := httptest.NewServer(g)
	defer goSrv.Close()

	paths := []string{
		"/feed/health", "/feed/health/", "/feed/profiles.json", "/feed/profiles.json/", "/feed/profiles.json?x=1", "/feed/channels.json",
		"/feed/all.atom", "/feed/all.atom?since=1", "/feed/empty.atom", "/feed/noch.atom", "/feed/err.atom", "/feed/ghost.atom",
		"/feed/c/dev_commits.atom", "/feed/c/logs_x.atom", "/feed/c/app_y.atom", "/feed/c/empty_topic.atom", "/feed/c/http_err.atom",
		"/feed/c/ghost.atom", "/feed/c/a&b<c>.atom", "/feed/all/c/x.atom", "/feed/", "/feed", "/", "/nothing", "/feed/c/", "/feed/.atom",
	}
	for _, p := range paths {
		wc, wt, wb := httpGet(t, pyBase, p)
		gc, gt, gb := httpGet(t, goSrv.URL, p)
		// An empty feed stamps the current time; every other byte must still match.
		wb, gb = updatedRE.ReplaceAllString(wb, "<updated/>"), updatedRE.ReplaceAllString(gb, "<updated/>")
		if wc != gc || wt != gt || wb != gb {
			t.Errorf("GET %s differs\n python: %d %q\n%s\n go:     %d %q\n%s", p, wc, wt, wb, gc, gt, gb)
		}
	}
	// Strict comparison of a non-empty feed including its <updated> values.
	_, _, wb := httpGet(t, pyBase, "/feed/all.atom")
	_, _, gb := httpGet(t, goSrv.URL, "/feed/all.atom")
	if wb != gb {
		t.Errorf("non-empty feed differs\n python:\n%s\n go:\n%s", wb, gb)
	}
}

// ---- the harness itself must be able to go red ------------------------------------------------------------------

func TestParityMutationIsDetected(t *testing.T) {
	want := []any{map[string]any{"actions": []any{map[string]any{"severity": "crit"}}}}
	same := []any{map[string]any{"actions": []any{map[string]any{"severity": "crit"}}}}
	mutated := []any{map[string]any{"actions": []any{map[string]any{"severity": "warn"}}}}
	if firstDiff(want, same) != "" {
		t.Fatal("identical values must compare equal")
	}
	if firstDiff(want, mutated) == "" {
		t.Fatal("a changed severity must be reported")
	}
	if firstDiff(want, nil) == "" {
		t.Fatal("a missing step must be reported")
	}
}
