//go:build parity

// Parity harness: the Node service (infra-api_cloud-me-api/src/code/index.mjs, the reference) and the Go port are started
// against the same local bare git repos (real git, read-only clones), the same stub JWKS/Authelia, and driven with the SAME ordered
// request list. Status, selected headers and raw bodies must be identical. PARITY_MUTATE=1 skews the Go side's accepted issuer;
// the harness must then report differing requests.
package parity

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
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

	"cloudme-api/cmeapi"
)

const issuer = "https://auth.diegonmarcos.com"
const keyVal = "PLANTEDKEYVALUE-0123456789abcdef"

func j(p ...string) string { return strings.Join(p, "") }

func sh(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "" {
			t.Skipf("git unavailable: %v", err)
		}
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func mkRepo(t *testing.T, tmp, remotes, name string, files map[string]string, links map[string]string) {
	work := filepath.Join(tmp, "work-"+name)
	_ = os.MkdirAll(work, 0o755)
	sh(t, work, "init", "-q", "-b", "main")
	for p, c := range files {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(work, p)), 0o755)
		if err := os.WriteFile(filepath.Join(work, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for p, target := range links {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(work, p)), 0o755)
		if err := os.Symlink(target, filepath.Join(work, p)); err != nil {
			t.Fatal(err)
		}
	}
	sh(t, work, "add", "-A")
	sh(t, work, "commit", "-q", "-m", "seed")
	sh(t, tmp, "clone", "-q", "--bare", work, filepath.Join(remotes, name))
}

func fixtures(t *testing.T, withAC bool) string {
	tmp := t.TempDir()
	remotes := filepath.Join(tmp, "remotes")
	_ = os.MkdirAll(remotes, 0o755)
	ghp := "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
	mkRepo(t, tmp, remotes, "cloud-me-containers", map[string]string{
		"c3/c3-mail.json":       `{"domain":"live.example","relays":["mx9"],"n":1.0,"u":"— <x> & é","big":1e21,"small":0.0000001}`,
		"c3/c3-mcp-apis.json":   `{"leaked":"` + ghp + `"}`,
		"c3/ok.json":            `{"b":2,"a":[3,{"z":null}],"a2":"x"}`,
		"c3/bad.json":           `{not json`,
		"tokens.json":           `{"a":1}`,
		"notes/readme.md":       "hello " + keyVal + " world\n",
		"notes/creds.yaml":      j("pass", "word: ", "abcdefgh1234\n"),
		"notes/latin.txt":       "caf\xe9 ok\n",
		"notes/crlf.yaml":       "a: 1\r\nb: 2\r\n",
		"notes/big.txt":         strings.Repeat("x", 262145),
		"notes/dir.md/inner.md": "inside\n",
	}, map[string]string{"notes/escape.md": "/etc/hostname", "notes/inside-link.md": "readme.md"})
	cfg := map[string]string{"x/build.json": `{"ok":true}`}
	if withAC {
		cfg["autocomplete.json"] = `{"ids":[{"label":" National ID ","value":"X0000000T"},{"label":"blank","value":"  "},{"label":5,"value":"num-label"}],"addresses":[{"label":"Home","value":"1 Example Street, Sampletown"}],"urls":[{"label":"Site","value":"https://example.org"}],"secrets":[{"label":"Wi-Fi","value":"` + j("fake-", "passphrase-1234") + `"},{"label":"blank","value":""}],"passwords":[{"label":"dropped","value":"zzzzzzzz"}]}`
	}
	mkRepo(t, tmp, remotes, "cloud-me_configs", cfg, nil)
	mkRepo(t, tmp, remotes, "cloud-me_cgc", map[string]string{"README.md": "# cgc\n"}, nil)
	return remotes
}

type stubs struct {
	url string
	key *rsa.PrivateKey
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newStub(t *testing.T, key *rsa.PrivateKey) string {
	e := []byte{byte(key.E >> 16), byte(key.E >> 8), byte(key.E)}
	for len(e) > 1 && e[0] == 0 {
		e = e[1:]
	}
	jwk := map[string]string{"kty": "RSA", "kid": "k1", "n": b64u(key.N.Bytes()), "e": b64u(e)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/jwks.json" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{jwk}})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/auth-request") {
			c := r.Header.Get("Cookie")
			if strings.Contains(c, "authelia_session=me") {
				w.Header().Set("Remote-User", "me@diegonmarcos.com")
				w.WriteHeader(200)
				return
			}
			if strings.Contains(c, "authelia_session=other") {
				w.Header().Set("Remote-User", "other@x.com")
				w.WriteHeader(200)
				return
			}
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func jwt(key *rsa.PrivateKey, claims map[string]any, kid string) string {
	hb, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid})
	pb, _ := json.Marshal(claims)
	h, p := b64u(hb), b64u(pb)
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	return h + "." + p + "." + b64u(sig)
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_, p, _ := net.SplitHostPort(l.Addr().String())
	return p
}

type spec struct {
	Method  string
	Path    string
	Tok     string
	Headers map[string]string
}

type rec struct {
	Status  int
	Headers map[string]string
	Body    string
}

var cmpHeaders = []string{"Content-Type", "Cache-Control", "X-Content-Type-Options", "X-Source-Commit", "Vary", "Allow", "Content-Length",
	"Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Max-Age", "Access-Control-Allow-Credentials"}
var syncedAt = regexp.MustCompile(`"synced_at":"[^"]*"`)

func do(t *testing.T, base string, s spec, toks map[string]string) rec {
	t.Helper()
	m := s.Method
	if m == "" {
		m = "GET"
	}
	req, _ := http.NewRequest(m, base+s.Path, nil)
	if s.Tok != "" {
		req.Header.Set("Authorization", "Bearer "+toks[s.Tok])
	}
	for k, v := range s.Headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", m, s.Path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := rec{Status: res.StatusCode, Headers: map[string]string{}, Body: syncedAt.ReplaceAllString(string(b), `"synced_at":"<T>"`)}
	for _, h := range cmpHeaders {
		if v := res.Header.Get(h); v != "" {
			r.Headers[h] = v
		}
	}
	return r
}

func e2eBuild(t *testing.T, nodeBuild string) string {
	b, err := os.ReadFile(nodeBuild)
	if err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	_ = json.Unmarshal(b, &d)
	ds := d["runtime"].(map[string]any)["datasets"].(map[string]any)
	for k, v := range ds {
		if m, ok := v.(map[string]any); ok && m["builtin"] != nil {
			ds["real-"+strings.TrimPrefix(k, "c3-")] = v
			ds[k] = map[string]any{"repo": "cloud-me-containers", "path": "c3/" + k + ".json"}
		}
	}
	// extra repo-backed datasets: invalid JSON, normal, and one whose file is absent
	ds["x-bad"] = map[string]any{"repo": "cloud-me-containers", "path": "c3/bad.json"}
	ds["x-ok"] = map[string]any{"repo": "cloud-me-containers", "path": "c3/ok.json"}
	out := filepath.Join(t.TempDir(), "e2e-build.json")
	nb, _ := json.Marshal(d)
	if err := os.WriteFile(out, nb, 0o644); err != nil {
		t.Fatal(err)
	}
	return out
}

func requests() []spec {
	var rs []spec
	paths := []string{"/endpoints", "/repos", "/config/c3-mail", "/repos/cloud-me-containers/file?path=README.md", "/autocomplete", "/me/autocomplete", "/me/config/c3-mail"}
	for _, tok := range []string{"", "garbage", "expired", "issuer", "scope", "badkid"} {
		for _, p := range paths {
			rs = append(rs, spec{Path: p, Tok: tok})
		}
	}
	rs = append(rs,
		spec{Path: "/health"}, spec{Path: "/me/health"}, spec{Path: "/health/"}, spec{Path: "/me/health/"},
		spec{Path: "/config/c3-mail", Tok: "good", Headers: map[string]string{"Cookie": "authelia_session=me"}},
		spec{Path: "/config/c3-mail", Tok: "garbage", Headers: map[string]string{"Cookie": "authelia_session=me"}},
		spec{Path: "/config/c3-mail", Headers: map[string]string{"Cookie": "authelia_session=me"}},
		spec{Path: "/config/c3-mail", Headers: map[string]string{"Cookie": "authelia_session=other"}},
		spec{Path: "/config/c3-mail", Headers: map[string]string{"Cookie": "authelia_session=dead"}},
		spec{Path: "/autocomplete", Headers: map[string]string{"Cookie": "authelia_session=me"}},
		spec{Path: "/autocomplete", Headers: map[string]string{"Cookie": "authelia_session=other"}},
		spec{Path: "/endpoints", Tok: "good"},
		spec{Path: "/me/endpoints", Tok: "good"},
		spec{Path: "/repos", Tok: "good"},
		spec{Path: "/config/c3-mail", Tok: "good"},
		spec{Path: "/config/c3-mcp-apis", Tok: "good"},
		spec{Path: "/config/c3-dns-routing", Tok: "good"},
		spec{Path: "/config/x-ok", Tok: "good"},
		spec{Path: "/config/x-bad", Tok: "good"},
		spec{Path: "/config/nope", Tok: "good"},
		spec{Path: "/config/_doc", Tok: "good"},
		spec{Path: "/config/__proto__", Tok: "good"},
		spec{Path: "/config/constructor", Tok: "good"},
		spec{Path: "/config/toString", Tok: "good"},
		spec{Path: "/config/c3-mail/", Tok: "good"},
		spec{Path: "/config/%FF", Tok: "good"},
		spec{Path: "/autocomplete", Tok: "good"},
		spec{Method: "POST", Path: "/autocomplete", Tok: "good"},
		spec{Method: "POST", Path: "/config/c3-mail", Tok: "good"},
		spec{Method: "PUT", Path: "/config/c3-mail", Tok: "good"},
		spec{Method: "DELETE", Path: "/repos", Tok: "good"},
		spec{Path: "/nope", Tok: "good"},
		spec{Path: "/nope"},
		spec{Path: "/repos/cloud-me_vault/file?path=x.json", Tok: "good"},
		spec{Path: "/repos/unknown/file?path=x.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=..%2Fetc%2Fhostname", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=%2Fetc%2Fhostname", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=tokens.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=.git%2Fconfig", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fcreds.yaml", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fescape.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Finside-link.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Freadme.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Flatin.txt", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fcrlf.yaml", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fbig.txt", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fdir.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=notes%2Fdir.md%2Finner.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=c3%2Fc3-mail.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=c3%2F.%2Fc3-mail.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=c3%2F%2Fc3-mail.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=c3%2Fc3-mail.json%2F", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=nonexistent.md", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=a%00b.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=a%5Cb.json", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=x.png", Tok: "good"},
		spec{Path: "/repos/cloud-me-containers/file?path=a&path=c3%2Fc3-mail.json", Tok: "good"},
		spec{Path: "/repos/cloud-me_configs/file?path=x%2Fbuild.json", Tok: "good"},
		spec{Path: "/repos/cloud-me_configs/file?path=autocomplete.json", Tok: "good"},
		spec{Path: "/repos/cloud-me_cgc/file?path=README.md", Tok: "good"},
		spec{Path: "/me/repos/cloud-me_cgc/file?path=README.md", Tok: "good"},
		spec{Path: "/me/repos", Tok: "good"},
		spec{Path: "/me/me/repos", Tok: "good"},
	)
	for _, n := range []string{"mail", "security-network", "dns-routing", "observability", "mcp-apis"} {
		rs = append(rs, spec{Path: "/config/real-" + n, Tok: "good"})
	}
	// CORS: preflights and echoes
	pf := func(o string) spec {
		return spec{Method: "OPTIONS", Path: "/config/c3-mail", Headers: map[string]string{"Origin": o, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}}
	}
	for _, o := range []string{"https://c3-mail.diegonmarcos.com", "https://diegonmarcos.github.io", "https://evil.example", "https://evil-diegonmarcos.com",
		"https://x.diegonmarcos.com.evil.io", "http://c3-mail.diegonmarcos.com", "null", "https://diegonmarcos.com", "https://a.b.diegonmarcos.com"} {
		rs = append(rs, pf(o), spec{Path: "/config/c3-mail", Tok: "good", Headers: map[string]string{"Origin": o}}, spec{Path: "/config/c3-mail", Headers: map[string]string{"Origin": o}})
	}
	rs = append(rs, spec{Method: "OPTIONS", Path: "/config/c3-mail"}, spec{Method: "OPTIONS", Path: "/nope", Headers: map[string]string{"Origin": "https://c3-mail.diegonmarcos.com"}})
	return rs
}

func TestParity(t *testing.T) {
	root, _ := filepath.Abs("../../../..")
	nodeSvc := filepath.Join(root, "infra-api_cloud-me-api")
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	now := time.Now().Unix()
	scope := "authelia.bearer.authz"
	rt, _ := cmeapi.RuntimeBlock()
	scope = rt.Authelia.RequiredScope
	good := jwt(key, map[string]any{"iss": issuer, "exp": now + 600, "scp": []string{scope}}, "k1")
	toks := map[string]string{
		"good":    good,
		"garbage": "garbage",
		"expired": jwt(key, map[string]any{"iss": issuer, "exp": now - 10, "scp": []string{scope}}, "k1"),
		"issuer":  jwt(key, map[string]any{"iss": "https://evil.example", "exp": now + 600, "scp": []string{scope}}, "k1"),
		"scope":   jwt(key, map[string]any{"iss": issuer, "exp": now + 600, "scp": []string{"other"}}, "k1"),
		"badkid":  jwt(key, map[string]any{"iss": issuer, "exp": now + 600, "scp": []string{scope}}, "zzz"),
	}
	mutate := os.Getenv("PARITY_MUTATE") != ""
	diffs, total := 0, 0

	for _, withAC := range []bool{true, false} {
		label := map[bool]string{true: "with-autocomplete-file", false: "without-autocomplete-file"}[withAC]
		remotes := fixtures(t, withAC)
		stub := newStub(t, key)
		build := e2eBuild(t, filepath.Join(nodeSvc, "build.json"))

		// Node (reference)
		port := freePort(t)
		cmd := exec.Command("node", filepath.Join(nodeSvc, "src", "code", "index.mjs"))
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "BUILD_JSON_PATH=" + build, "PORT=" + port, "BIND_HOST=127.0.0.1",
			"JWKS_URL=" + stub + "/jwks.json", "AUTHELIA_VERIFY_URL=" + stub + "/auth-request",
			"CME_DATA_DIR=" + t.TempDir(), "CME_KEY_DIR=" + t.TempDir(), "CME_URL_OVERRIDE_DIR=" + remotes,
			"CME_KEY_CONTAINERS_B64=" + base64.StdEncoding.EncodeToString([]byte(keyVal))}
		var logb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &logb, &logb
		if err := cmd.Start(); err != nil {
			if os.Getenv("PARITY_REQUIRE") == "" {
				t.Skipf("node unavailable: %v", err)
			}
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
		nodeURL := "http://127.0.0.1:" + port

		// Go port
		env := map[string]string{"BUILD_JSON_PATH": build, "JWKS_URL": stub + "/jwks.json", "AUTHELIA_VERIFY_URL": stub + "/auth-request",
			"CME_DATA_DIR": t.TempDir(), "CME_KEY_DIR": t.TempDir(), "CME_URL_OVERRIDE_DIR": remotes,
			"CME_KEY_CONTAINERS_B64": base64.StdEncoding.EncodeToString([]byte(keyVal))}
		if mutate {
			env["ISSUER"] = "https://skewed.example.invalid"
		}
		cfg, err := cmeapi.ConfigFromEnv(func(k string) string { return env[k] })
		if err != nil {
			t.Fatal(err)
		}
		srv, err := cmeapi.New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		gs := httptest.NewServer(srv)
		t.Cleanup(gs.Close)
		srv.StartSync(t.Context())

		// wait until both have synced all three repos
		waitSynced := func(base string, goSide bool) {
			deadline := time.Now().Add(40 * time.Second)
			for time.Now().Before(deadline) {
				tok := "good"
				if goSide && mutate {
					// the skewed issuer refuses our token; poll the store directly instead
					all := true
					for _, r := range srv.Store().Repos() {
						all = all && r.State.OK
					}
					if all {
						return
					}
				} else {
					r := do2(base+"/repos", toks[tok])
					if strings.Count(r, `"ok":true`) == 3 {
						return
					}
				}
				time.Sleep(150 * time.Millisecond)
			}
			t.Fatalf("%s did not sync: %s", base, logb.String())
		}
		waitSynced(nodeURL, false)
		waitSynced(gs.URL, true)

		for i, rs := range requests() {
			n := do(t, nodeURL, rs, toks)
			g := do(t, gs.URL, rs, toks)
			total++
			if !reflect.DeepEqual(n, g) {
				diffs++
				t.Errorf("[%s] request %d %s %s tok=%q differs\n  node: %d %v %q\n  go:   %d %v %q", label, i, rs.Method, rs.Path, rs.Tok, n.Status, n.Headers, trunc(n.Body), g.Status, g.Headers, trunc(g.Body))
			}
		}
		if strings.Contains(logb.String(), keyVal) {
			t.Error("the Node log printed a held key (reference sanity)")
		}
	}
	if diffs > 0 {
		t.Fatalf("%d of %d requests differ", diffs, total)
	}
	t.Logf("parity: %d requests (2 fixture variants, real git, real JWT/JWKS/session) identical in status, headers and raw body", total)
	fmt.Println("PARITY OK", total)
}

func do2(u, tok string) string {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

func trunc(s string) string {
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}
