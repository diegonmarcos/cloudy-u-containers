package gitproxy

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"gitproxy-api/internal/fakeup"
)

const fake = fakeup.FakeToken

func TestRedaction(t *testing.T) {
	for _, s := range []string{fake, "Bearer " + fake, `{"error":"upstream said: Authorization: Bearer ` + fake + `"}`, `https://x:` + fake + `@github.com/a/b.git`} {
		out := RedactSecrets(s, []string{fake})
		if strings.Contains(out, fake) || !strings.Contains(out, Redacted) {
			t.Errorf("not redacted: %q", out)
		}
	}
	if RedactSecrets(`{"a":1}`, []string{fake}) != `{"a":1}` {
		t.Error("a clean body is left alone")
	}
	if RedactSecrets("abcdef", []string{"abc"}) != "abcdef" {
		t.Error("secrets under 8 chars are ignored")
	}
	// longest first: a secret containing another as a substring leaves no readable tail
	if got := RedactSecrets("xx-longsecret1234-yy", []string{"longsecr", "longsecret1234"}); strings.Contains(got, "et1234") {
		t.Errorf("tail left behind: %q", got)
	}
}

func TestHeadersAndURLs(t *testing.T) {
	h := UpstreamHeaders(fake)
	if h.Get("Authorization") != "Bearer "+fake {
		t.Error("upstreamHeaders carries the token")
	}
	in := http.Header{}
	in.Set("Authorization", "Bearer fleet-jwt")
	in.Set("Cookie", "authelia_session=s")
	in.Set("Git-Protocol", "version=2")
	in.Set("Content-Type", "application/x-git-upload-pack-request")
	in.Set("X-Forwarded-For", "1.2.3.4")
	g := GitUpstreamHeaders(fake, in)
	if !strings.HasPrefix(g.Get("Authorization"), "Basic ") || g.Get("Cookie") != "" || g.Get("X-Forwarded-For") != "" ||
		strings.Contains(strings.Join(g.Values("Authorization"), ""), "fleet-jwt") {
		t.Errorf("git headers leak the caller's credentials: %v", g)
	}
	if g.Get("Git-Protocol") != "version=2" || g.Get("Content-Type") != "application/x-git-upload-pack-request" || g.Get("Accept-Encoding") != "identity" {
		t.Errorf("git protocol headers: %v", g)
	}
	if GitURL("https://github.com", "o", "r", "info/refs?service=git-upload-pack") != "https://github.com/o/r.git/info/refs?service=git-upload-pack" {
		t.Error("GitURL")
	}
	if TarballURL("https://a", "o", "r", "") != "https://a/repos/o/r/tarball" || TarballURL("https://a", "o", "r", "feature/x") != "https://a/repos/o/r/tarball/feature%2Fx" {
		t.Error("TarballURL")
	}
	if encodeURIComponent("a b/é!") != "a%20b%2F%C3%A9!" {
		t.Errorf("encodeURIComponent: %s", encodeURIComponent("a b/é!"))
	}
}

func TestValidators(t *testing.T) {
	for _, s := range []string{"diegonmarcos", "a", "cloud-infra", "x.y_z"} {
		if !ValidName(s) {
			t.Errorf("ValidName(%q)", s)
		}
	}
	for _, s := range []string{"", ".", "..", "-flag", "a/b", "../x", strings.Repeat("a", 101), "a b"} {
		if ValidName(s) {
			t.Errorf("ValidName(%q) must be false", s)
		}
	}
	for _, s := range []string{"", "main", "feature/x", "v1.2.3"} {
		if !ValidRef(s) {
			t.Errorf("ValidRef(%q)", s)
		}
	}
	for _, s := range []string{"../..", "-x", "/x", "a..b", "a b", strings.Repeat("a", 256)} {
		if ValidRef(s) {
			t.Errorf("ValidRef(%q) must be false", s)
		}
	}
	if !ValidTag("latest") || !ValidTag("v1.2.3") || ValidTag("") || ValidTag("a/b") || ValidTag("..") || ValidTag("-x") {
		t.Error("ValidTag")
	}
	if !ValidRange("bytes=0-") || !ValidRange("bytes=100-199") || !ValidRange("bytes=-500") ||
		ValidRange("bytes=0-1,5-9") || ValidRange("items=0-1") || ValidRange("bytes=x-") {
		t.Error("ValidRange")
	}
}

func TestFeedsUnit(t *testing.T) {
	rt, err := RuntimeBlock()
	if err != nil {
		t.Fatal(err)
	}
	l := rt.Feeds.Repos
	if !RepoDeclared(l, "diegonmarcos", "cloudy-t-infra") || !RepoDeclared(l, "DiegoNMarcos", "Cloudy-T-Infra") {
		t.Error("allow-list is case-insensitive")
	}
	if RepoDeclared(l, "diegonmarcos", "cloudy-t-infra-x") || RepoDeclared(l, "torvalds", "linux") || RepoDeclared(l, "diegonmarcos", "cloud-vault") {
		t.Error("allow-list must refuse prefixes, strangers and the vault")
	}
	max := int(rt.Feeds.MaxPerPage)
	for raw, want := range map[string]int{"": 5, "abc": 5, "3": 3, "0": 1, "-4": 1, "999": max, "50": 50, " 7x": 7} {
		if got := ClampPerPage(raw, max); got != want {
			t.Errorf("ClampPerPage(%q) = %d, want %d", raw, got, want)
		}
	}
	if max < 50 {
		t.Errorf("max_per_page %d must serve the Store's per_page=50", max)
	}
	if FeedURL("https://x", "o", "r", "commits", 20) != "https://x/repos/o/r/commits?per_page=20" || FeedURL("https://x", "o", "r", "runs", 20) != "https://x/repos/o/r/actions/runs?per_page=20" {
		t.Error("feed URLs")
	}
	c, _ := json.Marshal(ProjectCommit(raw(`{"sha":"a","commit":{},"smuggled":1}`)))
	if string(c) != `{"sha":"a"}` {
		t.Errorf("projectCommit drops unknown and absent fields: %s", c)
	}
	r, _ := json.Marshal(ProjectRepo(raw(`{"full_name":"o/r","private":null,"owner":null,"size":0,"token":"x"}`)))
	if string(r) != `{"full_name":"o/r","owner":null,"private":false,"size_kb":0}` {
		t.Errorf("projectRepo: %s", r)
	}
}

func TestLoadRuntimeRefusals(t *testing.T) {
	var base map[string]any
	if err := json.Unmarshal(runtimeJSON, &base); err != nil {
		t.Fatal(err)
	}
	mut := func(f func(m map[string]any)) error {
		var m map[string]any
		_ = json.Unmarshal(runtimeJSON, &m)
		f(m)
		b, _ := json.Marshal(m)
		_, err := LoadRuntime(b)
		return err
	}
	if err := mut(func(map[string]any) {}); err != nil {
		t.Fatalf("the declared runtime must load: %v", err)
	}
	for name, f := range map[string]func(m map[string]any){
		"feeds missing":       func(m map[string]any) { delete(m, "feeds") },
		"empty allow-list":    func(m map[string]any) { m["feeds"].(map[string]any)["repos"] = []any{} },
		"malformed repo":      func(m map[string]any) { m["feeds"].(map[string]any)["repos"] = []any{"no-slash"} },
		"zero ttl":            func(m map[string]any) { m["feeds"].(map[string]any)["cache_ttl_s"] = 0 },
		"max_per_page 101":    func(m map[string]any) { m["feeds"].(map[string]any)["max_per_page"] = 101 },
		"session missing":     func(m map[string]any) { delete(m["authelia"].(map[string]any), "session") },
		"empty session users": func(m map[string]any) { m["authelia"].(map[string]any)["session"].(map[string]any)["users"] = []any{} },
		"non-https git_base":  func(m map[string]any) { m["upstream"].(map[string]any)["git_base"] = "http://github.com" },
		"empty endpoints":     func(m map[string]any) { m["endpoints"] = []any{} },
		"relative base_path":  func(m map[string]any) { m["base_path"] = "git" },
	} {
		if mut(f) == nil {
			t.Errorf("LoadRuntime must THROW on: %s", name)
		}
	}
}

// One declaration, no drifting duplicate: the embedded runtime equals this service's build.json and the Node service's.
func TestRuntimeMatchesBuildJson(t *testing.T) {
	var emb any
	_ = json.Unmarshal(runtimeJSON, &emb)
	for _, p := range []string{"../../../build.json", "../../../../infra-api_cloudy-drive-git-proxy-api/build.json"} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		var doc struct {
			Runtime any `json:"runtime"`
		}
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(emb, doc.Runtime) {
			t.Errorf("embedded runtime.json differs from the runtime block of %s", p)
		}
	}
}

func TestTableDrift(t *testing.T) {
	rt, _ := RuntimeBlock()
	noop := func(http.ResponseWriter, *http.Request, *reqCtx) {}
	all := map[string]handler{}
	for _, e := range rt.Endpoints {
		all[e.Path] = noop
	}
	if _, err := buildTable(rt, all); err != nil {
		t.Fatalf("complete table: %v", err)
	}
	extra := map[string]handler{"/git/undeclared": noop}
	for k, v := range all {
		extra[k] = v
	}
	if _, err := buildTable(rt, extra); err == nil {
		t.Error("a handler nobody declared must refuse the table")
	}
	for k := range all {
		missing := map[string]handler{}
		for k2, v := range all {
			if k2 != k {
				missing[k2] = v
			}
		}
		if _, err := buildTable(rt, missing); err == nil {
			t.Errorf("a declared route without a handler (%s) must refuse the table", k)
		}
	}
}

func TestPathname(t *testing.T) {
	for in, want := range map[string]string{"/a/b": "/a/b", "/a/./b": "/a/b", "/a/../b": "/b", "/a/%2e%2e/b": "/b", "/x/..": "/", "/": "/", "/a%2Fb/c": "/a%2Fb/c"} {
		r := httptest.NewRequest("GET", "http://x"+in, nil)
		if got := pathname(r); got != want {
			t.Errorf("pathname(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---- live, in process, against the fake upstream ----

type live struct {
	f     *fakeup.Fake
	srv   *httptest.Server
	good  string
	owner string
	mkReq func(path, tok string) (int, string, http.Header)
}

func newLive(t *testing.T, mesh string) *live {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	imp, _ := rsa.GenerateKey(rand.Reader, 2048)
	f := fakeup.New(key, imp)
	t.Cleanup(f.Close)
	env := f.Env()
	if mesh != "" {
		env["MESH_CIDRS"] = mesh
	}
	cfg, err := ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	now := time.Now().Unix()
	good := fakeup.Mint(key, "RS256", map[string]any{"iss": fakeup.Issuer, "sub": "diego", "scp": []string{"authelia.bearer.authz"}, "iat": now, "exp": now + 300})
	l := &live{f: f, srv: srv, good: good}
	l.mkReq = func(path, tok string) (int, string, http.Header) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b), res.Header
	}
	return l
}

func code(body string) string {
	var m map[string]any
	_ = json.Unmarshal([]byte(body), &m)
	c, _ := m["code"].(string)
	return c
}

func TestLiveRefusalsAndNoLeak(t *testing.T) {
	l := newLive(t, "")
	now := time.Now().Unix()
	claims := func(m map[string]any) map[string]any {
		b := map[string]any{"iss": fakeup.Issuer, "sub": "diego", "scp": []string{"authelia.bearer.authz"}, "exp": now + 300}
		for k, v := range m {
			b[k] = v
		}
		return b
	}
	good0 := fakeup.Mint(l.f.Key, "RS256", claims(nil))
	for label, c := range map[string]struct {
		tok    string
		status int
		code   string
	}{
		"none":     {"", 401, "missing_authorization"},
		"garbage":  {"not-a-jwt", 401, "invalid_token"},
		"expired":  {fakeup.Mint(l.f.Key, "RS256", claims(map[string]any{"exp": now - 10})), 401, "invalid_token"},
		"issuer":   {fakeup.Mint(l.f.Key, "RS256", claims(map[string]any{"iss": "https://evil.example.com"})), 401, "invalid_token"},
		"impostor": {fakeup.Mint(l.f.Impostor, "RS256", claims(nil)), 401, "invalid_token"},
		"alg none": {fakeup.Mint(nil, "none", claims(nil)), 401, "invalid_token"},
		"tampered": {fakeup.Tamper(good0, claims(map[string]any{"scp": []string{"authelia.bearer.authz", "admin"}})), 401, "invalid_token"},
		"scope":    {fakeup.Mint(l.f.Key, "RS256", claims(map[string]any{"scp": []string{"nope"}})), 403, "insufficient_scope"},
	} {
		for _, p := range []string{"/repos", "/endpoints", "/repos/diegonmarcos/cloudy-t-infra/tarball", "/repos/diegonmarcos/cloudy-t-infra/commits", "/repos/diegonmarcos/cloudy-t-infra/runs",
			"/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack"} {
			st, body, _ := l.mkReq(p, c.tok)
			if st != c.status || code(body) != c.code {
				t.Errorf("%s %s: got %d %s, want %d %s", p, label, st, body, c.status, c.code)
			}
		}
	}
	if n := l.f.Snapshot()["hits"].(map[string]int)["/repos/diegonmarcos/cloudy-t-infra/commits"]; n != 0 {
		t.Errorf("refused feed requests dialled GitHub %d times, want 0", n)
	}
	if st, b, _ := l.mkReq("/health", ""); st != 200 || b != `{"status":"ok","service":"git-proxy-api"}` {
		t.Errorf("/health: %d %s", st, b)
	}
	if st, b, _ := l.mkReq("/definitely-not-a-route", l.good); st != 404 || code(b) != "no_such_route" {
		t.Errorf("unmatched route: %d %s", st, b)
	}
	// the hard leak case: upstream fails quoting our Authorization header
	st, b, _ := l.mkReq("/repos/diegonmarcos/cloudy-t-infra/tarball?ref=main", l.good)
	if st != 502 || code(b) != "upstream_error" || strings.Contains(b, fake) {
		t.Errorf("tarball failure: %d %s", st, b)
	}
	st, b, _ = l.mkReq("/repos", l.good)
	if st != 200 || strings.Contains(b, fake) || strings.Contains(b, "smuggled") || !strings.Contains(b, `"count":1`) {
		t.Errorf("repos: %d %s", st, b)
	}
	for _, p := range []string{"/repos/-flag/cloud-infra/tarball", "/repos/..%2F..%2Fetc/cloud-infra/tarball", "/repos/a%2Fb/cloud-infra/tarball"} {
		if st, b, _ := l.mkReq(p, l.good); st != 400 || code(b) != "bad_repo" {
			t.Errorf("%s: %d %s", p, st, b)
		}
	}
	if st, b, _ := l.mkReq("/repos/diegonmarcos/cloudy-t-infra/tarball?ref=..%2F..%2Fetc", l.good); st != 400 || code(b) != "bad_ref" {
		t.Errorf("bad ref: %d %s", st, b)
	}
}

func TestLiveFeedsCache(t *testing.T) {
	l := newLive(t, "")
	hits := func(p string) int { return l.f.Snapshot()["hits"].(map[string]int)[p] }
	st, b, _ := l.mkReq("/repos/diegonmarcos/cloudy-t-infra/commits?per_page=2", l.good)
	if st != 200 || strings.Count(b, `"sha":`) != 2 || strings.Contains(b, "smuggled") || !strings.Contains(b, `"cached_at":"`) {
		t.Errorf("commits: %d %s", st, b)
	}
	if st, b, _ = l.mkReq("/repos/DiegoNMarcos/Cloudy-T-Infra/commits?per_page=50", l.good); st != 200 || strings.Count(b, `"sha":`) != 7 {
		t.Errorf("commits 2: %d %s", st, b)
	}
	if hits("/repos/diegonmarcos/cloudy-t-infra/commits") != 1 {
		t.Error("a second request (other case, other per_page) must be served from CACHE")
	}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if st, b, _ := l.mkReq("/repos/diegonmarcos/cloudy-t-infra/runs", l.good); st != 200 || !strings.Contains(b, `"conclusion":"success"`) {
				t.Errorf("runs: %d %s", st, b)
			}
		}()
	}
	wg.Wait()
	if hits("/repos/diegonmarcos/cloudy-t-infra/actions/runs") != 1 {
		t.Errorf("five CONCURRENT misses must share ONE upstream call, got %d", hits("/repos/diegonmarcos/cloudy-t-infra/actions/runs"))
	}
	if st, b, _ := l.mkReq("/repos/torvalds/linux/commits", l.good); st != 403 || code(b) != "repo_not_declared" || hits("/repos/torvalds/linux/commits") != 0 {
		t.Errorf("undeclared: %d %s", st, b)
	}
	st, b, _ = l.mkReq("/repos/diegonmarcos/cloudy-u-linux/commits", l.good)
	if st != 502 || code(b) != "upstream_error" || strings.Contains(b, fake) {
		t.Errorf("feed failure: %d %s", st, b)
	}
	l.mkReq("/repos/diegonmarcos/cloudy-u-linux/commits", l.good)
	if hits("/repos/diegonmarcos/cloudy-u-linux/commits") != 2 {
		t.Error("a FAILED upstream answer must not be cached")
	}
	if st, b, _ := l.mkReq("/repos/diegonmarcos/front-data/runs", l.good); st != 404 || code(b) != "not_found" {
		t.Errorf("upstream 404: %d %s", st, b)
	}
}

func TestLiveReleaseAssetsAndMesh(t *testing.T) {
	l := newLive(t, "127.0.0.0/8")
	// direct mesh dial (127/8 declared as the mesh for this instance): no credential needed
	st, b, h := l.mkReq("/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", "")
	if st != 200 || len(b) != fakeup.AssetBytes || h.Get("Accept-Ranges") != "bytes" || h.Get("Etag") != `"e1"` {
		t.Errorf("asset: %d len=%d %v", st, len(b), h)
	}
	for _, c := range l.f.Snapshot()["cdn"].([]string) {
		if strings.Split(c, "|")[1] != "" {
			t.Errorf("the credential followed the redirect to the object store: %s", c)
		}
	}
	// relayed by a proxy: judged as an authelia route
	req, _ := http.NewRequest("GET", l.srv.URL+"/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", nil)
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Errorf("relayed mesh route must need a credential, got %d", res.StatusCode)
	}
	res.Body.Close()
	req, _ = http.NewRequest("GET", l.srv.URL+"/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", nil)
	req.Header.Set("Range", "bytes=0-99")
	res, _ = http.DefaultClient.Do(req)
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 206 || len(body) != 100 || res.Header.Get("Content-Range") != "bytes 0-99/1000" {
		t.Errorf("range: %d %d %v", res.StatusCode, len(body), res.Header)
	}
	req, _ = http.NewRequest("GET", l.srv.URL+"/releases/diegonmarcos/cloudy-u-android/latest/assets/App.apk", nil)
	req.Header.Set("Range", "bytes=5000-")
	res, _ = http.DefaultClient.Do(req)
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 416 || code(string(body)) != "range_not_satisfiable" || res.Header.Get("Content-Range") != "bytes */1000" {
		t.Errorf("416: %d %s %v", res.StatusCode, body, res.Header)
	}
	for p, c := range map[string]string{
		"/releases/diegonmarcos/cloudy-u-android/latest/assets/Nope.apk": "not_found",
		"/releases/diegonmarcos/cloudy-u-android/nope/assets/App.apk":    "not_found",
		"/releases/torvalds/linux/latest/assets/App.apk":                 "repo_not_declared",
		"/releases/diegonmarcos/cloudy-u-android/-x/assets/App.apk":      "bad_tag",
		"/releases/-x/cloudy-u-android/latest/assets/App.apk":            "bad_repo",
		"/releases/diegonmarcos/cloudy-u-android/latest/assets/..%2Fx":   "bad_asset",
	} {
		if _, b, _ := l.mkReq(p, ""); code(b) != c {
			t.Errorf("%s: got %s want %s", p, b, c)
		}
	}
}
