//go:build parity

// Package parity runs the ORIGINAL Python ntfy-bridge.py (via ref.py, unmodified) and the Go port against identical
// servers and requires identical behaviour: the full bootstrap request transcript against a stateful fake Mattermost
// (fresh and established scenarios), the /c3 slash handler and button callbacks over HTTP, the ntfy stream bridge,
// and the pure helpers.
//
// Run: PARITY_REQUIRE=1 go test -count=1 -tags parity -v -run TestParity ./parity/
// Needs python3 with: pip install requests websocket-client Pillow
package parity

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"mm-bridge/bridge"
	"mm-bridge/fakemm"
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

func py(t *testing.T, cmd string, req any) []byte {
	t.Helper()
	requirePython(t)
	in, _ := json.Marshal(req)
	c := exec.Command("python3", "ref.py", cmd, string(in))
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		t.Fatalf("ref.py %s: %v\n%s", cmd, err, errb.String())
	}
	return out.Bytes()
}

func norm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func envFor(mm string) map[string]string {
	return map[string]string{
		"NTFY_URL": "http://ntfy.invalid", "TOPICS": "health_mesh,dev_commits,Sec Audit!,new_topic", "MM_URL": mm,
		"MM_ADMIN_EMAIL": "admin@example.org", "MM_ADMIN_USERNAME": "admin", "MM_ADMIN_PASSWORD": "pw-not-secret",
		"C3_API_URL": "http://c3.invalid", "C3_PORT": "8887", "C3_ACTION_URL": "http://bots:8887/c3/action", "C3_SLASH_URL": "http://bots:8887/c3",
		"MM_SIDEBAR_CATEGORIES":  `{"ntfy": "NTFY", "agents": "AGENTS", "default_channels": "Projects"}`,
		"MM_CLAUDE_PASSWORD":     "claude-pw-not-secret",
		"MM_AGENTS_LLM_BACKENDS": `[{"name": "claude-superset", "url": "http://x"}]`,
	}
}

func goConfig(mm string) *bridge.Config {
	for k, v := range envFor(mm) {
		os.Setenv(k, v)
	}
	cfg, err := bridge.ConfigFromEnv()
	if err != nil {
		panic(err)
	}
	return cfg
}

func TestParityBootstrapTranscript(t *testing.T) {
	requirePython(t)
	for _, scenario := range []string{"fresh", "established"} {
		t.Run(scenario, func(t *testing.T) {
			fake := fakemm.New(scenario)
			defer fake.Close()

			py(t, "bootstrap", map[string]any{"env": envFor(fake.URL)})
			want := norm(t, fake.Transcript).([]any)

			fake.Reset()
			b := bridge.New(goConfig(fake.URL))
			b.Sleep = func(_ time.Duration) {}
			if _, err := b.Bootstrap(nil); err != nil {
				t.Fatal(err)
			}
			got := norm(t, fake.Transcript).([]any)

			if len(want) != len(got) {
				t.Errorf("transcript length: python %d, go %d", len(want), len(got))
			}
			for i := 0; i < len(want) && i < len(got); i++ {
				if !reflect.DeepEqual(want[i], got[i]) {
					t.Fatalf("request %d differs\n python: %s\n go:     %s", i, js(want[i]), js(got[i]))
				}
			}
			if len(want) < 25 {
				t.Fatalf("transcript too short to prove anything: %d requests", len(want))
			}
			t.Logf("%s: %d requests identical", scenario, len(want))
		})
	}
}

func js(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestParityPureHelpers(t *testing.T) {
	topics := []string{"health_mesh", "Sec Audit!", "  ÄÖ weird  ", "---", "", strings.Repeat("a", 80), "a--b__c", "dev/commits"}
	msgs := []map[string]any{
		{}, {"title": "T", "message": "M", "priority": 4, "tags": []any{"a", "b"}}, {"message": "only body", "priority": 3},
		{"title": "x", "tags": []any{}}, {"priority": 5}, {"title": "", "message": "", "tags": []any{"t"}},
	}
	want := map[string][]any{}
	_ = json.Unmarshal(py(t, "funcs", map[string]any{"env": envFor("http://mm.invalid"), "topics": topics, "messages": msgs}), &want)
	var gotSan, gotFmt []any
	for _, tp := range topics {
		gotSan = append(gotSan, bridge.SanitizeChannel(tp))
	}
	for _, m := range msgs {
		nm := norm(t, m).(map[string]any)
		gotFmt = append(gotFmt, bridge.FormatMessage(nm))
	}
	if !reflect.DeepEqual(want["sanitize"], norm(t, gotSan)) {
		t.Fatalf("sanitize\n python %v\n go     %v", want["sanitize"], gotSan)
	}
	if !reflect.DeepEqual(want["format"], norm(t, gotFmt)) {
		t.Fatalf("format\n python %v\n go     %v", want["format"], gotFmt)
	}
}

// fakeC3 is a deterministic C3 API for both implementations.
func fakeC3() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/health/tier1":
			fmt.Fprint(w, `[{"alias":"oci-apps","reachable":true},{"vm":"gcp-proxy","reachable":false},{"alias":"oci-mail","reachable":true}]`)
		case r.URL.Path == "/health/tier3":
			fmt.Fprint(w, `{"results":[{"alias":"oci-apps","reachable":true,"resources":{"memoryUsed":3.5,"memoryTotal":24,"diskPercent":"41%"},"containers":[1,2,3]},{"vm":"gcp-proxy","reachable":false,"resources":"n/a","containers":null},{"alias":"x","resources":{"memoryUsed":"?"}}]}`)
		case r.URL.Path == "/health/deployed/oci-apps":
			fmt.Fprint(w, `[{"vm":"oci-apps","alias":"a","containers":[{"name":"ntfy","status":"Up 3 days"},{"name":"caddy","state":"running"},{"status":"?"}]}]`)
		case r.URL.Path == "/health/deployed/flat":
			fmt.Fprint(w, `[{"name":"c1","status":"up"},{"name":"c2","state":"exited"}]`)
		case r.URL.Path == "/health/deployed/empty":
			fmt.Fprint(w, `[]`)
		case r.URL.Path == "/health/deployed/boom":
			http.Error(w, "boom", 500)
		case strings.HasSuffix(r.URL.Path, "/start"), strings.HasSuffix(r.URL.Path, "/stop"), strings.HasSuffix(r.URL.Path, "/reset"), strings.HasSuffix(r.URL.Path, "/restart"):
			if strings.Contains(r.URL.Path, "bad") {
				http.Error(w, "nope", 404)
				return
			}
			fmt.Fprint(w, `{"ok":true}`)
		default:
			http.Error(w, "missing", 404)
		}
	}))
}

func TestParityC3Slash(t *testing.T) {
	requirePython(t)
	c3 := fakeC3()
	defer c3.Close()
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cfg, _ := json.Marshal(map[string]any{"env": envFor("http://mm.invalid"), "port": port, "c3": c3.URL, "token": ""})
	cmd := exec.Command("python3", "ref.py", "c3-serve", string(cfg))
	stdout, _ := cmd.StdoutPipe()
	var errb bytes.Buffer
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("python handler did not start: %q %v %s", line, err, errb.String())
	}
	pyBase := fmt.Sprintf("http://127.0.0.1:%d", port)

	os.Setenv("C3_API_URL", c3.URL)
	gcfg := goConfig("http://mm.invalid")
	gcfg.C3APIURL = c3.URL
	gb := bridge.New(gcfg)
	goSrv := httptest.NewServer(gb.SlashHandler())
	defer goSrv.Close()

	form := func(text string) (string, string) { return "/c3", "text=" + url.QueryEscape(text) + "&channel_id=ch1" }
	act := func(cmd string) (string, string) {
		b, _ := json.Marshal(map[string]any{"context": map[string]any{"command": cmd}})
		return "/c3/action", string(b)
	}
	type call struct{ path, body string }
	var calls []call
	for _, text := range []string{"status", "vms", "help", "", "wake oci-apps", "sleep oci-apps", "reset oci-apps", "wake bad", "ps oci-apps", "ps flat", "ps empty", "ps boom", "ps",
		"start oci-apps ntfy", "stop oci-apps ntfy", "restart oci-apps ntfy", "restart oci-apps bad", "start oci-apps", "WAKE oci-apps", "gpu", "models", "nonsense words"} {
		p, b := form(text)
		calls = append(calls, call{p, b})
		p, b = act(text)
		calls = append(calls, call{p, b})
	}
	calls = append(calls, call{"/c3", "text="}, call{"/c3", ""}, call{"/c3/action", "not json"}, call{"/c3/action", `{"context":{}}`}, call{"/other", "text=status"})
	post := func(base string, c call) (int, string, string) {
		resp, err := http.Post(base+c.path, "application/x-www-form-urlencoded", strings.NewReader(c.body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header.Get("Content-Type"), string(b)
	}
	for _, c := range calls {
		wc, wt, wb := post(pyBase, c)
		gc, gt, gbody := post(goSrv.URL, c)
		if wc != gc || wt != gt || wb != gbody {
			t.Errorf("POST %s %q differs\n python: %d %q %s\n go:     %d %q %s", c.path, c.body, wc, wt, wb, gc, gt, gbody)
		}
	}
	t.Logf("%d slash/action calls identical", len(calls))
}

func TestParityNtfyStream(t *testing.T) {
	requirePython(t)
	var mu sync.Mutex
	var posts []any
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var v any
		_ = json.Unmarshal(b, &v)
		mu.Lock()
		posts = append(posts, v)
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer hook.Close()
	stream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"event":"open","topic":"x"}`+"\n")
		fmt.Fprint(w, `{"event":"message","topic":"health_mesh","title":"Down","message":"mesh is down","priority":5,"tags":["warning","mesh"]}`+"\n")
		fmt.Fprint(w, "\n")
		fmt.Fprint(w, "this is not json\n")
		fmt.Fprint(w, `{"event":"keepalive"}`+"\n")
		fmt.Fprint(w, `{"event":"message","topic":"Sec Audit!","message":"login from new host"}`+"\n")
		fmt.Fprint(w, `{"event":"message","message":"no topic"}`+"\n")
		fmt.Fprint(w, `{"event":"message","topic":"dev_commits","title":"push","message":"abc123","tags":[]}`)
	}))
	defer stream.Close()

	topics := "health_mesh,Sec Audit!,dev_commits"
	py(t, "bridge", map[string]any{"env": envFor("http://mm.invalid"), "ntfy": stream.URL, "topics": topics, "webhook": hook.URL + "/hooks/abc"})
	want := append([]any{}, posts...)
	posts = nil

	cfg := goConfig("http://mm.invalid")
	cfg.NtfyURL, cfg.Topics = stream.URL, topics
	if err := bridge.New(cfg).SubscribeAndBridge(hook.URL + "/hooks/abc"); err != nil {
		t.Fatal(err)
	}
	if len(want) < 4 {
		t.Fatalf("python posted only %d messages", len(want))
	}
	if !reflect.DeepEqual(want, norm(t, posts)) {
		t.Fatalf("webhook posts differ\n python: %s\n go:     %s", js(want), js(posts))
	}
}

func TestParityMutationIsDetected(t *testing.T) {
	a := []any{map[string]any{"method": "POST", "path": "/api/v4/channels", "body": map[string]any{"name": "x"}}}
	b := []any{map[string]any{"method": "POST", "path": "/api/v4/channels", "body": map[string]any{"name": "y"}}}
	if reflect.DeepEqual(a, b) {
		t.Fatal("a changed request body must not compare equal")
	}
	if !reflect.DeepEqual(a, norm(t, a)) {
		t.Fatal("round trip must be stable")
	}
}
