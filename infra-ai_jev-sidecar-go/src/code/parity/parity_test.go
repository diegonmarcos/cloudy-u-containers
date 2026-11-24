//go:build parity

// Parity harness (#1879): every scenario runs through the Python reference (python3 jev_gate.py <mode>)
// and through the Go port (gate.Main, same stdin, same environment) against the same mock Decisions
// server and mock code-graph MCP server, and everything observable must be identical: stdout, the
// journal lines (key order included; ts and latency_ms excluded), the requests the mocks received, the
// budget ledger, the session and decide caches and the goose context file. PARITY_REQUIRE=1 turns a
// missing python3 into a failure; PARITY_MUTATE=1 skews the mock for the Go run only (the run must go red).
package parity

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"jev-gate/gate"
	"jev-gate/pyjson"
)

var pyRef = func() string {
	p, _ := filepath.Abs("../../../../_shared/jev-gate/jev_gate.py")
	return p
}()

// ---------- mock Decisions ----------

type rec struct{ auth, body string }

type decisions struct {
	mu     sync.Mutex
	reqs   []rec
	reply  func(body *pyjson.OMap) (int, string, time.Duration)
	mutate bool
	srv    *httptest.Server
}

func (d *decisions) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	d.mu.Lock()
	d.reqs = append(d.reqs, rec{r.Header.Get("Authorization"), string(b)})
	reply := d.reply
	mut := d.mutate
	d.mu.Unlock()
	status, body, delay := 200, `{"answers":{}}`, time.Duration(0)
	if reply != nil {
		v, _ := pyjson.Parse(b)
		status, body, delay = reply(pyjson.AsMap(v))
	}
	if mut {
		body = strings.NewReplacer(`"noul": 0.97`, `"noul": 0.10`, `"noul":0.97`, `"noul":0.10`).Replace(body)
	}
	time.Sleep(delay)
	w.WriteHeader(status)
	io.WriteString(w, body)
}

// noul answers every asked question with p; choice questions with their first criterion.
func answersFor(body *pyjson.OMap, noul float64, pick func(q string, crit *pyjson.OMap) (string, float64)) string {
	ans := pyjson.NewMap()
	qs := pyjson.AsMap(body.M["questions"])
	for _, id := range qs.Keys {
		q := pyjson.AsMap(qs.M[id])
		switch q.M["type"] {
		case "noul":
			ans.Set(id, pyjson.Obj("noul", noul))
		case "choice", "score":
			crit := pyjson.AsMap(q.M["criteria"])
			c, p := pick(id, crit)
			probs := pyjson.NewMap()
			for _, k := range crit.Keys {
				if k == c {
					probs.Set(k, p)
				} else {
					probs.Set(k, (1-p)/float64(len(crit.Keys)))
				}
			}
			if q.M["type"] == "choice" {
				ans.Set(id, pyjson.Obj("choice", c, "probabilities", probs))
			} else {
				ans.Set(id, pyjson.Obj("probabilities", probs))
			}
		}
	}
	return pyjson.DumpsDefault(pyjson.Obj("id", "gen-1", "usage", pyjson.Obj("cost", 0.0007), "answers", ans))
}

func okNoul(p float64) func(*pyjson.OMap) (int, string, time.Duration) {
	return func(b *pyjson.OMap) (int, string, time.Duration) {
		return 200, answersFor(b, p, func(q string, c *pyjson.OMap) (string, float64) { return c.Keys[0], 0.97 }), 0
	}
}

func fixed(status int, body string) func(*pyjson.OMap) (int, string, time.Duration) {
	return func(*pyjson.OMap) (int, string, time.Duration) { return status, body, 0 }
}

// ---------- mock code-graph MCP ----------

type mcp struct {
	mu     sync.Mutex
	reqs   []string
	sse    bool
	text   string
	isErr  bool
	repos  []string
	status int
	srv    *httptest.Server
}

func (m *mcp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	v, _ := pyjson.Parse(b)
	req := pyjson.AsMap(v)
	m.mu.Lock()
	m.reqs = append(m.reqs, fmt.Sprintf("%s|%s|auth=%s|sid=%s", req.M["method"], pyjson.Dumps(req.M["params"], pyjson.Opts{EnsureASCII: true, SortKeys: true}), r.Header.Get("Authorization"), r.Header.Get("Mcp-Session-Id")))
	status, sse, text, isErr, repos := m.status, m.sse, m.text, m.isErr, m.repos
	m.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	id := req.M["id"]
	var result any
	switch req.M["method"] {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sess-42")
		result = pyjson.Obj("protocolVersion", "2025-03-26", "capabilities", pyjson.NewMap(), "serverInfo", pyjson.Obj("name", "mock", "version", "1"))
	case "notifications/initialized":
		w.WriteHeader(202)
		return
	case "tools/list":
		enum := make([]any, len(repos))
		for i, r := range repos {
			enum[i] = r
		}
		result = pyjson.Obj("tools", []any{
			pyjson.Obj("name", "cgc.octocode.graphrag", "inputSchema", pyjson.Obj("type", "object", "properties", pyjson.Obj("query", pyjson.Obj("type", "string"), "repo", pyjson.Obj("type", "string", "enum", enum)))),
			pyjson.Obj("name", "cgc.octocode.search", "inputSchema", pyjson.Obj("type", "object", "properties", pyjson.Obj("query", pyjson.Obj("type", "string"), "repo", pyjson.Obj("type", "string", "enum", enum)))),
			pyjson.Obj("name", "cgc.codegraph.impact_analysis", "inputSchema", pyjson.Obj("type", "object")),
		})
	case "tools/call":
		result = pyjson.Obj("content", []any{pyjson.Obj("type", "text", "text", text), pyjson.Obj("type", "image", "data", "x")}, "isError", isErr)
	default:
		result = pyjson.NewMap()
	}
	msg := pyjson.DumpsDefault(pyjson.Obj("jsonrpc", "2.0", "id", id, "result", result))
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, msg)
}

// ---------- scenario machinery ----------

type dirs struct{ root, home, project, repo, cfgPath, log, budget, moim string }

type scn struct {
	name   string
	mode   string
	args   []string
	stdin  func(d *dirs) string
	env    map[string]string
	nokey  bool
	reply  func(*pyjson.OMap) (int, string, time.Duration)
	setup  func(d *dirs, m *mcp)
	patch  func(cfg *pyjson.OMap, d *dirs)
	runs   int
	text   string
	repos  []string
	sse    *bool
	isErr  bool
	status int
}

func j(kv ...any) string { return pyjson.DumpsDefault(pyjson.Obj(kv...)) }

var (
	rootOnce sync.Once
	rootBase string
)

// mkdirs gives each scenario a fixed directory (the same path for the Python and the Go run: paths end up
// in the state sent to Decisions, in its hash and in cache keys), wiped before every run.
func mkdirs(t *testing.T, name string) *dirs {
	rootOnce.Do(func() { rootBase = t.TempDir() })
	root := filepath.Join(rootBase, strings.NewReplacer("/", "_", " ", "_").Replace(name))
	if name == "" || root == rootBase {
		t.Fatal("scenario without a name")
	}
	os.RemoveAll(root)
	d := &dirs{root: root, home: filepath.Join(root, "home"), project: filepath.Join(root, "work", "cloud-infra", "sub"), repo: filepath.Join(root, "work", "cloud-infra")}
	d.cfgPath, d.log, d.budget, d.moim = filepath.Join(root, "cfg.json"), filepath.Join(root, "log.jsonl"), filepath.Join(root, "budget.json"), filepath.Join(root, "moim.txt")
	for _, p := range []string{d.home, d.project, filepath.Join(d.repo, ".git")} {
		os.MkdirAll(p, 0o755)
	}
	os.WriteFile(filepath.Join(d.repo, "main.go"), []byte("package main\n"), 0o644)
	return d
}

func baseConfig(t *testing.T) *pyjson.OMap {
	p, _ := filepath.Abs("../../../../_shared/jev-gate/jev-gate.json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := pyjson.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return pyjson.AsMap(v)
}

func prepare(t *testing.T, s scn, impl string, dec *decisions, m *mcp) (*dirs, []string) {
	d := mkdirs(t, s.name)
	cfg := baseConfig(t)
	cfg.Set("endpoint", dec.srv.URL+"/decisions")
	cfg.Set("timeout_s", int64(1))
	g := pyjson.AsMap(cfg.M["code_graph"])
	g.Set("cache_dir", filepath.Join(d.root, "cgcache"))
	cc := pyjson.AsMap(g.M["client_configs"])
	pyjson.AsMap(cc.M["claude"]).Set("path", filepath.Join(d.root, "claude.json"))
	pyjson.AsMap(cc.M["goose"]).Set("path", filepath.Join(d.root, "goose.yaml"))
	os.WriteFile(filepath.Join(d.root, "claude.json"), []byte(j("mcpServers", pyjson.Obj(
		"cloud-cgc-pub-mcp", pyjson.Obj("url", "http://127.0.0.1:1/never"),
		"cloud-cgc-pvt-mcp", pyjson.Obj("url", m.srv.URL+"/mcp", "headers", pyjson.Obj("Authorization", "Bearer ${PARITY_TOK}"))))), 0o644)
	os.WriteFile(filepath.Join(d.root, "goose.yaml"), []byte("extensions:\n  cloud-cgc-pvt-mcp:\n    enabled: true   # trailing comment\n    type: streamable_http\n    uri: '"+m.srv.URL+"/mcp'\n    headers:\n      Authorization: \"Bearer ${PARITY_TOK}\"\n    list:\n      - skipped\n  other:\n    uri: http://elsewhere\n"), 0o644)
	if s.patch != nil {
		s.patch(cfg, d)
	}
	os.WriteFile(d.cfgPath, []byte(pyjson.DumpsDefault(cfg)), 0o644)
	if s.setup != nil {
		s.setup(d, m)
	}
	env := []string{"HOME=" + d.home, "PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8", "PYTHONIOENCODING=utf-8", "TZ=UTC",
		"JEV_GATE_CONFIG=" + d.cfgPath, "JEV_GATE_LOG=" + d.log, "JEV_GATE_BUDGET=" + d.budget, "PARITY_TOK=tok123",
		"XDG_CONFIG_HOME=" + filepath.Join(d.home, ".config")}
	if !s.nokey {
		env = append(env, "OPENROUTER_API_KEY=sk-or-v1-parity-not-a-real-key-0123456789abcdef")
	}
	if s.mode == "goose-prompt" {
		env = append(env, "GOOSE_MOIM_MESSAGE_FILE="+d.moim)
	}
	ks := make([]string, 0, len(s.env))
	for k := range s.env {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		env = append(env, k+"="+strings.ReplaceAll(s.env[k], "{{HOME}}", d.home))
	}
	return d, dedupe(env)
}

func dedupe(env []string) []string {
	idx := map[string]int{}
	var out []string
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if i, ok := idx[k]; ok {
			out[i] = kv
			continue
		}
		idx[k] = len(out)
		out = append(out, kv)
	}
	return out
}

func runPython(env []string, mode string, args []string, stdin string) string {
	cmd := exec.Command("python3", append([]string{pyRef, mode}, args...)...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return fmt.Sprintf("%s[exit=%v]", out.String(), err == nil)
}

func runGo(env []string, mode string, args []string, stdin string) string {
	saved := os.Environ()
	os.Clearenv()
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		os.Setenv(k, v)
	}
	defer func() {
		os.Clearenv()
		for _, kv := range saved {
			k, v, _ := strings.Cut(kv, "=")
			os.Setenv(k, v)
		}
	}()
	var out bytes.Buffer
	code := gate.Main(mode, args, func() string { return stdin }, &out)
	return fmt.Sprintf("%s[exit=%v]", out.String(), code == 0)
}

// artifacts renders everything a run leaves behind in a comparable form.
func artifacts(d *dirs, dec *decisions, m *mcp) string {
	var b strings.Builder
	if raw, err := os.ReadFile(d.log); err == nil {
		for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			v, err := pyjson.Parse([]byte(l))
			o := pyjson.AsMap(v)
			if err != nil || o == nil {
				fmt.Fprintf(&b, "journal(unparsed): %s\n", l)
				continue
			}
			o.Delete("ts")
			if _, ok := o.Get("latency_ms"); ok {
				o.Set("latency_ms", int64(0))
			}
			fmt.Fprintf(&b, "journal: %s\n", pyjson.DumpsDefault(o))
		}
	}
	if raw, err := os.ReadFile(d.budget); err == nil {
		v, _ := pyjson.Parse(raw)
		if o := pyjson.AsMap(v); o != nil {
			if c := pyjson.AsMap(o.M["calls"]); c != nil {
				for _, k := range c.Keys {
					c.Set(k, int64(len(pyjson.AsList(c.M[k]))))
				}
			}
			fmt.Fprintf(&b, "budget: %s\n", pyjson.DumpsDefault(o))
		}
	}
	filepath.Walk(filepath.Join(d.root, "cgcache"), func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		raw, _ := os.ReadFile(p)
		v, _ := pyjson.Parse(raw)
		if o := pyjson.AsMap(v); o != nil {
			o.Delete("exp")
			v = o
		}
		rel, _ := filepath.Rel(d.root, p)
		fmt.Fprintf(&b, "cache %s: %s\n", rel, pyjson.DumpsDefault(v))
		return nil
	})
	if raw, err := os.ReadFile(d.moim); err == nil {
		fmt.Fprintf(&b, "moim: %q\n", raw)
	}
	dec.mu.Lock()
	for i, r := range dec.reqs {
		fmt.Fprintf(&b, "decisions[%d]: auth=%s body=%s\n", i, r.auth, r.body)
	}
	dec.mu.Unlock()
	m.mu.Lock()
	for i, r := range m.reqs {
		fmt.Fprintf(&b, "mcp[%d]: %s\n", i, r)
	}
	m.mu.Unlock()
	return strings.ReplaceAll(b.String(), d.root, "<ROOT>")
}

func runScenario(t *testing.T, s scn, impl string) string {
	dec := &decisions{reply: s.reply, mutate: impl == "go" && os.Getenv("PARITY_MUTATE") == "1"}
	dec.srv = httptest.NewServer(dec)
	defer dec.srv.Close()
	m := &mcp{sse: true, text: s.text, isErr: s.isErr, repos: s.repos, status: s.status}
	if s.sse != nil {
		m.sse = *s.sse
	}
	m.srv = httptest.NewServer(m)
	defer m.srv.Close()
	// the endpoint URLs differ per run (random ports): the transcripts replace them
	d, env := prepare(t, s, impl, dec, m)
	runs := s.runs
	if runs == 0 {
		runs = 1
	}
	var out strings.Builder
	for i := 0; i < runs; i++ {
		stdin := ""
		if s.stdin != nil {
			stdin = s.stdin(d)
		}
		if impl == "py" {
			out.WriteString(runPython(env, s.mode, s.args, stdin))
		} else {
			out.WriteString(runGo(env, s.mode, s.args, stdin))
		}
		out.WriteString("\n---\n")
	}
	out.WriteString(artifacts(d, dec, m))
	r := out.String()
	r = strings.ReplaceAll(r, dec.srv.URL, "<DEC>")
	r = strings.ReplaceAll(r, m.srv.URL, "<MCP>")
	return r
}

func TestParity(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("python3 not found")
		}
		t.Skip("python3 not found")
	}
	if _, err := os.Stat(pyRef); err != nil {
		t.Fatal(err)
	}
	bad := 0
	all := scenarios()
	for _, s := range all {
		py, gg := runScenario(t, s, "py"), runScenario(t, s, "go")
		if py != gg {
			bad++
			t.Errorf("DIFF %s\n--- python\n%s\n--- go\n%s", s.name, trunc(py, 3000), trunc(gg, 3000))
		} else {
			t.Logf("same %-34s %s", s.name, trunc(strings.ReplaceAll(strings.SplitN(py, "\n", 2)[0], "\n", " "), 100))
		}
	}
	if bad > 0 {
		t.Fatalf("%d of %d scenarios differ", bad, len(all))
	}
	t.Logf("parity: %d scenarios identical", len(all))
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// ---------- serve ----------

func TestParityServe(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("python3 not found")
		}
		t.Skip("python3 not found")
	}
	big := strings.Repeat("x", 70000)
	probe := j("state", pyjson.Obj("note", "queue stalled"), "questions", pyjson.Obj("q", pyjson.Obj("type", "noul", "instructions", "Is it stuck?")))
	calls := []call{
		{"GET", "/health", ""}, {"GET", "/precision", ""}, {"GET", "/nope", ""}, {"GET", "/health?x=1", ""},
		{"POST", "/decide/probe", probe}, {"POST", "/decide/probe", probe}, {"POST", "/decide/nosuch", probe},
		{"POST", "/decide/claude_permission", probe}, {"POST", "/decide/probe", "{not json"}, {"POST", "/decide/probe", ""},
		{"POST", "/decide/probe", `{"state": 1}`}, {"POST", "/decide/probe", big},
		{"POST", "/outcome/probe", j("call", "abc123", "label", true)}, {"POST", "/outcome/probe", j("call", "", "label", true)},
		{"POST", "/outcome/probe", "[1]"}, {"POST", "/other/probe", probe}, {"POST", "/decide/bad name", probe},
		{"GET", "/precision", ""},
	}
	run := func(impl string) string {
		dec := &decisions{reply: okNoul(0.97), mutate: impl == "go" && os.Getenv("PARITY_MUTATE") == "1"}
		dec.srv = httptest.NewServer(dec)
		defer dec.srv.Close()
		m := &mcp{}
		m.srv = httptest.NewServer(m)
		defer m.srv.Close()
		d, env := prepare(t, scn{mode: "serve", name: "serve"}, impl, dec, m)
		var base string
		if impl == "py" {
			l, _ := net.Listen("tcp", "127.0.0.1:0")
			port := l.Addr().(*net.TCPAddr).Port
			l.Close()
			cmd := exec.Command("python3", pyRef, "serve")
			cmd.Env = append(env, fmt.Sprintf("JEV_GATE_PORT=%d", port), "JEV_GATE_BIND=127.0.0.1")
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
			base = fmt.Sprintf("http://127.0.0.1:%d", port)
			for i := 0; i < 100; i++ {
				if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
					c.Close()
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
		} else {
			saved := os.Environ()
			os.Clearenv()
			for _, kv := range env {
				k, v, _ := strings.Cut(kv, "=")
				os.Setenv(k, v)
			}
			cfg, err := gate.LoadConfig("")
			if err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(gate.Handler(cfg))
			defer srv.Close()
			base = srv.URL
			defer func() {
				os.Clearenv()
				for _, kv := range saved {
					k, v, _ := strings.Cut(kv, "=")
					os.Setenv(k, v)
				}
			}()
			return transcript(t, base, calls, d, dec, m)
		}
		return transcript(t, base, calls, d, dec, m)
	}
	py, gg := run("py"), run("go")
	if py != gg {
		t.Fatalf("serve transcripts differ\n--- python\n%s\n--- go\n%s", trunc(py, 4000), trunc(gg, 4000))
	}
	t.Logf("serve parity: %d calls identical\n%s", len(calls), trunc(py, 1500))
}

func transcript(t *testing.T, base string, calls []call, d *dirs, dec *decisions, m *mcp) string {
	var b strings.Builder
	for _, c := range calls {
		var body io.Reader
		if c.body != "" {
			body = strings.NewReader(c.body)
		}
		req, _ := http.NewRequest(c.method, base+c.path, body)
		if c.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			fmt.Fprintf(&b, "%s %s -> error %v\n", c.method, c.path, err)
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		fmt.Fprintf(&b, "%s %s (%d bytes) -> %d %s %s\n", c.method, c.path, len(c.body), resp.StatusCode, resp.Header.Get("Content-Type"), raw)
	}
	b.WriteString(artifacts(d, dec, m))
	r := b.String()
	r = strings.ReplaceAll(r, dec.srv.URL, "<DEC>")
	return strings.ReplaceAll(r, m.srv.URL, "<MCP>")
}

type call struct{ method, path, body string }
