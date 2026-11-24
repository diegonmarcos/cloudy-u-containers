//go:build parity

// Parity harness: the Node service (infra-api_cloudy-drive-git-proxy-api/src/code/index.mjs, the reference) and the
// Go port are each started against their own identical fake GitHub/Authelia/object store (shared signing keys), then
// driven with the SAME ordered request list. Status, selected headers and raw bodies must be identical, and so must
// everything the fakes saw (upstream call counts, git/session/CDN requests, credentials presented).
// PARITY_MUTATE=1 skews the Go side's accepted issuer; the harness must then report differing requests.
package parity

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
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

	"gitproxy-api/gitproxy"
	"gitproxy-api/internal/fakeup"
)

type reqSpec struct {
	Method  string
	Path    string
	Tok     string // key into the token table
	Headers map[string]string
	Body    string
}

type respRec struct {
	Status  int
	Headers map[string]string
	Body    string
}

var cmpHeaders = []string{"Content-Type", "Cache-Control", "Allow", "Content-Range", "Accept-Ranges", "Etag", "Content-Disposition", "Content-Length"}
var cachedAt = regexp.MustCompile(`"cached_at":"[^"]*"`)

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, p, _ := net.SplitHostPort(l.Addr().String())
	return p
}

type pair struct {
	nodeURL, goURL   string
	nodeFake, goFake *fakeup.Fake
}

func startPair(t *testing.T, root string, key, imp *rsa.PrivateKey, mesh string, mutate bool) *pair {
	t.Helper()
	p := &pair{nodeFake: fakeup.New(key, imp), goFake: fakeup.New(key, imp)}
	t.Cleanup(p.nodeFake.Close)
	t.Cleanup(p.goFake.Close)

	svc := filepath.Join(root, "infra-api_cloudy-drive-git-proxy-api")
	port := freePort(t)
	cmd := exec.Command("node", filepath.Join(svc, "src", "code", "index.mjs"))
	env := os.Environ()
	for k, v := range p.nodeFake.Env() {
		env = append(env, k+"="+v)
	}
	env = append(env, "PORT="+port, "BIND_HOST=127.0.0.1", "BUILD_JSON_PATH="+filepath.Join(svc, "build.json"))
	if mesh != "" {
		env = append(env, "MESH_CIDRS="+mesh)
	}
	cmd.Env = env
	var logb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logb, &logb
	if err := cmd.Start(); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "" {
			t.Skipf("node unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	p.nodeURL = "http://127.0.0.1:" + port
	deadline := time.Now().Add(15 * time.Second)
	for {
		res, err := http.Get(p.nodeURL + "/health")
		if err == nil {
			res.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("node service did not start: %s", logb.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	genv := p.goFake.Env()
	if mesh != "" {
		genv["MESH_CIDRS"] = mesh
	}
	if mutate {
		genv["ISSUER"] = "https://skewed.example.invalid"
	}
	cfg, err := gitproxy.ConfigFromEnv(func(k string) string { return genv[k] })
	if err != nil {
		t.Fatal(err)
	}
	srv, err := gitproxy.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	gs := httptest.NewServer(srv)
	t.Cleanup(gs.Close)
	p.goURL = gs.URL
	return p
}

func do(t *testing.T, base string, rs reqSpec, toks map[string]string) respRec {
	t.Helper()
	var body io.Reader
	if rs.Body != "" {
		body = strings.NewReader(rs.Body)
	}
	m := rs.Method
	if m == "" {
		m = "GET"
	}
	req, err := http.NewRequest(m, base+rs.Path, body)
	if err != nil {
		t.Fatal(err)
	}
	if rs.Tok != "" {
		req.Header.Set("Authorization", "Bearer "+toks[rs.Tok])
	}
	for k, v := range rs.Headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", m, rs.Path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	rec := respRec{Status: res.StatusCode, Headers: map[string]string{}, Body: cachedAt.ReplaceAllString(string(b), `"cached_at":"<T>"`)}
	for _, h := range cmpHeaders {
		if v := res.Header.Get(h); v != "" {
			rec.Headers[h] = v
		}
	}
	return rec
}

func tokens(key, imp *rsa.PrivateKey) map[string]string {
	now := time.Now().Unix()
	c := func(m map[string]any) map[string]any {
		b := map[string]any{"iss": fakeup.Issuer, "sub": "diego", "client_id": "cli", "scp": []string{"authelia.bearer.authz"}, "iat": now, "exp": now + 600}
		for k, v := range m {
			b[k] = v
		}
		return b
	}
	good := fakeup.Mint(key, "RS256", c(nil))
	return map[string]string{
		"good":     good,
		"garbage":  "not-a-jwt",
		"expired":  fakeup.Mint(key, "RS256", c(map[string]any{"exp": now - 10})),
		"issuer":   fakeup.Mint(key, "RS256", c(map[string]any{"iss": "https://evil.example.com"})),
		"impostor": fakeup.Mint(imp, "RS256", c(nil)),
		"none":     fakeup.Mint(nil, "none", c(nil)),
		"tampered": fakeup.Tamper(good, c(map[string]any{"scp": []string{"authelia.bearer.authz", "admin"}})),
		"scope":    fakeup.Mint(key, "RS256", c(map[string]any{"scp": []string{"nope"}})),
		"nbf":      fakeup.Mint(key, "RS256", c(map[string]any{"nbf": now + 3600})),
		"scpstr":   fakeup.Mint(key, "RS256", c(map[string]any{"scp": "x authelia.bearer.authz"})),
	}
}

func mainRequests() []reqSpec {
	var rs []reqSpec
	paths := []string{"/repos", "/endpoints", "/repos/diegonmarcos/cloudy-t-infra/tarball",
		"/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack",
		"/repos/diegonmarcos/cloudy-t-infra/commits", "/repos/diegonmarcos/cloudy-t-infra/runs",
		"/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk"}
	for _, tok := range []string{"", "garbage", "expired", "issuer", "impostor", "none", "tampered", "scope", "nbf"} {
		for _, p := range paths {
			rs = append(rs, reqSpec{Path: p, Tok: tok})
		}
	}
	rs = append(rs,
		reqSpec{Path: "/health"},
		reqSpec{Path: "/health/"},
		reqSpec{Path: "/definitely-not-a-route", Tok: "good"},
		reqSpec{Path: "/definitely-not-a-route"},
		reqSpec{Path: "/endpoints", Tok: "good"},
		reqSpec{Path: "/endpoints/", Tok: "good"},
		reqSpec{Path: "/endpoints", Tok: "scpstr"},
		reqSpec{Method: "POST", Path: "/repos", Tok: "good"},
		reqSpec{Method: "DELETE", Path: "/health"},
		reqSpec{Method: "PUT", Path: "/clone/diegonmarcos/cloudy-t-infra/git-upload-pack", Tok: "good"},
		reqSpec{Path: "/repos", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/tarball?ref=main", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/tarball", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/tarball?ref=..%2F..%2Fetc", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/tarball?ref=-x", Tok: "good"},
		reqSpec{Path: "/repos/-flag/cloud-infra/tarball", Tok: "good"},
		reqSpec{Path: "/repos/..%2F..%2Fetc/cloud-infra/tarball", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/..%2Fsecrets/tarball", Tok: "good"},
		reqSpec{Path: "/repos/a%2Fb/cloud-infra/tarball", Tok: "good"},
		reqSpec{Path: "/repos/%E0%A4%A/cloud-infra/tarball", Tok: "good"},
		reqSpec{Path: "/repos/a/./b/tarball", Tok: "good"},
		// feeds + cache behaviour
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/commits?per_page=2", Tok: "good"},
		reqSpec{Path: "/repos/DiegoNMarcos/Cloudy-T-Infra/commits?per_page=50", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/commits?per_page=abc", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/commits?per_page=0", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/commits?per_page=-4", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/commits?per_page=3x", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/runs", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/runs?per_page=1", Tok: "good"},
		reqSpec{Path: "/repos/torvalds/linux/commits", Tok: "good"},
		reqSpec{Path: "/repos/-x/cloud-infra/runs", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-u-linux/commits", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/cloudy-u-linux/commits", Tok: "good"},
		reqSpec{Path: "/repos/diegonmarcos/front-data/runs", Tok: "good"},
		// git smart-HTTP, upload-pack only
		reqSpec{Path: "/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack", Tok: "good", Headers: map[string]string{"Git-Protocol": "version=2", "Cookie": "authelia_session=owner"}},
		reqSpec{Path: "/clone/diegonmarcos/cloudy-t-infra.git/info/refs?service=git-upload-pack", Tok: "good"},
		reqSpec{Path: "/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-receive-pack", Tok: "good"},
		reqSpec{Path: "/clone/diegonmarcos/cloudy-t-infra/info/refs", Tok: "good"},
		reqSpec{Method: "POST", Path: "/clone/diegonmarcos/cloudy-t-infra/git-upload-pack", Tok: "good", Body: "0032want abc\n0000", Headers: map[string]string{"Content-Type": "application/x-git-upload-pack-request"}},
		reqSpec{Path: "/clone/-x/cloudy-t-infra/info/refs?service=git-upload-pack", Tok: "good"},
		reqSpec{Path: "/clone/diegonmarcos/missing/info/refs?service=git-upload-pack", Tok: "good"},
		// the session (cookie) path
		reqSpec{Path: "/repos", Headers: map[string]string{"Cookie": "authelia_session=owner"}},
		reqSpec{Path: "/repos", Headers: map[string]string{"Cookie": "authelia_session=guest"}},
		reqSpec{Path: "/repos", Headers: map[string]string{"Cookie": "authelia_session=dead"}},
		reqSpec{Path: "/repos", Tok: "garbage", Headers: map[string]string{"Cookie": "authelia_session=owner"}},
		reqSpec{Path: "/repos", Tok: "good", Headers: map[string]string{"Cookie": "authelia_session=guest"}},
		reqSpec{Path: "/endpoints", Headers: map[string]string{"Cookie": "authelia_session=owner"}},
		// release assets with a credential (relayed or off-mesh): full, range, sidecars, refusals
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "bytes=0-99"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "bytes=-500"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "bytes=900-"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "bytes=5000-"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "bytes=0-1,5-9"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Tok: "good", Headers: map[string]string{"Range": "items=0-1"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk.sha256", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk.source", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/Gone.apk", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/Missing.apk", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/nope/assets/App.apk", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/-x/assets/App.apk", Tok: "good"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/..%2Fx", Tok: "good"},
		reqSpec{Path: "/releases/-x/cloudy-u-android/latest/assets/App.apk", Tok: "good"},
		reqSpec{Path: "/releases/torvalds/linux/latest/assets/App.apk", Tok: "good"},
		// mesh routes dialled directly (127/8 only counts as the mesh in the second pair)
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk"},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Headers: map[string]string{"Range": "bytes=0-9"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Headers: map[string]string{"X-Forwarded-For": "1.2.3.4"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", Headers: map[string]string{"Via": "1.1 caddy"}},
		reqSpec{Path: "/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk.sha256"},
		reqSpec{Path: "/repos"},
	)
	return rs
}

func compareRun(t *testing.T, label string, np, gp *pair, reqs []reqSpec, toks map[string]string) int {
	diffs := 0
	for i, rs := range reqs {
		n := do(t, np.nodeURL, rs, toks)
		g := do(t, gp.goURL, rs, toks)
		if !reflect.DeepEqual(n, g) {
			diffs++
			t.Errorf("%s request %d %s %s tok=%q differs\n  node: %d %v %q\n  go:   %d %v %q", label, i, rs.Method, rs.Path, rs.Tok, n.Status, n.Headers, n.Body, g.Status, g.Headers, g.Body)
		}
	}
	// five concurrent feed misses on a fresh key share ONE upstream call in both
	for _, base := range []string{np.nodeURL, gp.goURL} {
		done := make(chan struct{}, 5)
		for i := 0; i < 5; i++ {
			go func() {
				do(t, base, reqSpec{Path: "/repos/diegonmarcos/cloudy-t-infra/runs?per_page=2", Tok: "good"}, toks)
				done <- struct{}{}
			}()
		}
		for i := 0; i < 5; i++ {
			<-done
		}
	}
	ns, _ := json.Marshal(np.nodeFake.Snapshot())
	gs, _ := json.Marshal(gp.goFake.Snapshot())
	if !bytes.Equal(ns, gs) {
		diffs++
		t.Errorf("%s upstream-visible behaviour differs\n  node: %s\n  go:   %s", label, ns, gs)
	}
	return diffs
}

func TestParity(t *testing.T) {
	root, _ := filepath.Abs("../../../..")
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	imp, _ := rsa.GenerateKey(rand.Reader, 2048)
	toks := tokens(key, imp)
	mutate := os.Getenv("PARITY_MUTATE") != ""

	total, diffs := 0, 0
	// instance A: declared mesh (10.0.0.0/24), so 127.0.0.1 is NOT the mesh
	a := startPair(t, root, key, imp, "", mutate)
	reqs := mainRequests()
	diffs += compareRun(t, "default", a, a, reqs, toks)
	total += len(reqs)
	// instance B: 127.0.0.0/8 is "the mesh"
	b := startPair(t, root, key, imp, "127.0.0.0/8", mutate)
	diffs += compareRun(t, "mesh127", b, b, reqs, toks)
	total += len(reqs)

	if diffs > 0 {
		t.Fatalf("%d of %d requests differ", diffs, total)
	}
	t.Logf("parity: %d requests (2 instance pairs) identical in status, headers, body and upstream-visible behaviour", total)
	fmt.Println("PARITY OK", total)
}
