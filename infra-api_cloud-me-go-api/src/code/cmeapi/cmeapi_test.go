package cmeapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"cloudme-api/internal/ojson"
)

func str(s string) *string { return &s }

func TestCleanPath(t *testing.T) {
	for _, bad := range []string{"", "/etc/passwd", "../x.json", "a/../../x.json", `a\b.json`, "a/b/", ".", "a\x00b.json", strings.Repeat("x", 301)} {
		b := bad
		if _, err := CleanPath(&b); err == nil {
			t.Errorf("CleanPath(%q) must refuse", bad)
		}
	}
	if _, err := CleanPath(nil); err == nil {
		t.Error("a missing path must be refused")
	}
	if p, err := CleanPath(str("c3/c3-mail.json")); err != nil || p != "c3/c3-mail.json" {
		t.Errorf("clean path kept: %q %v", p, err)
	}
	if p, _ := CleanPath(str("a//b/./c.json")); p != "a/b/c.json" {
		t.Errorf("normalised: %q", p)
	}
}

func rt(t *testing.T) *Runtime {
	t.Helper()
	r, err := RuntimeBlock()
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestGate(t *testing.T) {
	g, err := MakeGate(rt(t))
	if err != nil {
		t.Fatal(err)
	}
	code := func(err error) string {
		if err == nil {
			return ""
		}
		return err.(*gateErr).Code
	}
	for _, p := range []string{"tokens.json", "a/secrets.yaml", "a/.env.json", "vault/x.json", ".git/config.txt", "x/id_rsa.txt", "a/credentials.json", "k/prod.pem.txt", "x.sh", "x.png", "a/secret-thing.json", "a/private.md"} {
		if code(g.CheckPath(p)) != "path_denied" {
			t.Errorf("gate must deny path %s", p)
		}
	}
	for _, p := range []string{"c3/c3-mail.json", "A_CONFIGS-USER/a0/build.json", "README.md", "x/y/service.yaml"} {
		if code(g.CheckPath(p)) != "" {
			t.Errorf("gate must allow path %s", p)
		}
	}
	ghp := "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
	j := func(p ...string) string { return strings.Join(p, "") }
	for label, body := range map[string]string{
		"private key": j("-----BEGIN ", "OPENSSH PRIVATE KEY-----\nabc\n"), "rsa key": j("-----BEGIN ", "RSA PRIVATE KEY-----"),
		"gh token": `{"x":"` + ghp + `"}`, "fine-grained pat": j("github", "_pat_", strings.Repeat("A", 30)),
		"aws id": j("AK", "IA", strings.Repeat("A", 16)), "age key": j("AGE-SECRET", "-KEY-1ABC"),
		"json password": j(`{"db":{"pass`, `word":"`, `hunter2hunter2"}}`), "json api_key": j(`{"api`, `_key": "`, `abcdef123456"}`),
		"yaml token": j("github_", "token: ", "abcdefgh12345\n"), "env style": j("SERVICE_", "SECRET=", "abcdefgh12345\n"),
		"sops blob":        j("k: ENC[", "AES256_GCM,data:abc]"),
		"nbsp after colon": j("pass", "word:", " ", "abcdefgh12345"), "second line": "# c\n" + j("api", "_key", ": ", "abcdefgh12345"),
	} {
		if code(g.CheckContent(body)) != "secret_filtered" {
			t.Errorf("gate must filter content: %s", label)
		}
	}
	for _, body := range []string{`{"domain":"example.org","relays":["mx1"],"spam":{"enabled":true}}`, "# readme\nnothing here", j("token", `_url: ""`+"\n"), j(`{"pass`, `word":""}`)} {
		if code(g.CheckContent(body)) != "" {
			t.Errorf("gate must pass benign content %.24s", body)
		}
	}
	if code(g.CheckSize(int64(rt(t).Files.MaxBytes)+1)) != "too_large" || code(g.CheckSize(10)) != "" {
		t.Error("size gate")
	}
}

func TestRedact(t *testing.T) {
	if RedactSecrets("a SECRETVALUE1 b", []string{"SECRETVALUE1"}) != "a [REDACTED] b" || RedactSecrets("a abc b", []string{"abc"}) != "a abc b" {
		t.Error("redaction")
	}
}

func TestAutocompleteNormalize(t *testing.T) {
	n := NormalizeAutocomplete(`{"ids":[{"label":" DNI ","value":"X1"},{"label":"blank","value":"  "},{"label":"n","value":5},7],"secrets":[{"label":"wifi","value":"pw"}],"passwords":[{"label":"x","value":"y"}],"urls":"nope"}`)
	got := string(ojson.Marshal(n))
	want := `{"v":1,"ids":[{"label":"DNI","value":"X1"}],"addresses":[],"urls":[],"secrets":[{"label":"wifi","value":"pw"}]}`
	if got != want {
		t.Errorf("normalize:\n got  %s\n want %s", got, want)
	}
	var rows []string
	for i := 0; i < acMaxPerPage+50; i++ {
		rows = append(rows, `{"label":"l","value":"v"}`)
	}
	big := NormalizeAutocomplete(`{"ids":[` + strings.Join(rows, ",") + `]}`)
	ids, _ := big.Get("ids")
	if len(ids.([]any)) != acMaxPerPage {
		t.Error("a page is capped")
	}
	for _, bad := range []string{"nonsense", "[1]", "null"} {
		if NormalizeAutocomplete(bad) != nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if string(ojson.Marshal(EmptyAutocomplete())) != `{"v":1,"ids":[],"addresses":[],"urls":[],"secrets":[]}` {
		t.Error("empty document")
	}
	if jsSlice("a\U0001F600b", 3) != "a\U0001F600" || jsSlice("abc", 5) != "abc" {
		t.Error("UTF-16 slicing counts code units")
	}
}

func TestLoadRuntimeRefusals(t *testing.T) {
	mut := func(f func(m map[string]any)) error {
		var m map[string]any
		_ = json.Unmarshal(runtimeJSON, &m)
		f(m)
		b, _ := json.Marshal(m)
		_, err := LoadRuntime(b)
		return err
	}
	if err := mut(func(map[string]any) {}); err != nil {
		t.Fatalf("declared runtime must load: %v", err)
	}
	rp := func(m map[string]any) map[string]any { return m["repos"].(map[string]any) }
	list := func(m map[string]any) []any { return rp(m)["list"].([]any) }
	for name, f := range map[string]func(m map[string]any){
		"vault repo": func(m map[string]any) {
			rp(m)["list"] = append(list(m), map[string]any{"name": "cloud-me_vault", "ssh": "git@github.com:diegonmarcos/cloud-me_vault.git", "branch": "main", "key_env": "CME_KEY_VAULT_B64"})
		},
		"open /me/repos": func(m map[string]any) { m["endpoints"].([]any)[2].(map[string]any)["auth"] = "none" },
		"https transport": func(m map[string]any) {
			list(m)[0].(map[string]any)["ssh"] = "https://github.com/diegonmarcos/cloud-me-containers.git"
		},
		"dataset undeclared": func(m map[string]any) {
			m["datasets"].(map[string]any)["x-repo"] = map[string]any{"repo": "nope", "path": "a.json"}
		},
		"wildcard cors": func(m map[string]any) {
			c := m["cors"].(map[string]any)
			c["origins"] = append(c["origins"].([]any), "https://*.example.com")
		},
		"bad filter regex":   func(m map[string]any) { m["files"].(map[string]any)["deny_content"] = "[" },
		"ac repo undeclared": func(m map[string]any) { m["autocomplete"].(map[string]any)["repo"] = "nope" },
		"ac not json":        func(m map[string]any) { m["autocomplete"].(map[string]any)["path"] = "a.yaml" },
		"ac route no file":   func(m map[string]any) { delete(m, "autocomplete") },
		"no known_hosts pin": func(m map[string]any) { rp(m)["known_hosts"] = "github.com ssh-rsa AAAA" },
		"session missing":    func(m map[string]any) { delete(m["authelia"].(map[string]any), "session") },
	} {
		if mut(f) == nil {
			t.Errorf("LoadRuntime must refuse: %s", name)
		}
	}
}

// One declaration, no drifting duplicate: the embedded runtime equals this service's build.json and the Node service's.
func TestRuntimeMatchesBuildJson(t *testing.T) {
	var emb any
	_ = json.Unmarshal(runtimeJSON, &emb)
	for _, p := range []string{"../../../build.json", "../../../../infra-api_cloud-me-api/build.json"} {
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

// The builtin datasets are shipped in the image; the embedded copies equal the Node service's files byte for byte.
func TestBuiltinDataMatchesNode(t *testing.T) {
	ents, err := dataFS.ReadDir("data")
	if err != nil || len(ents) == 0 {
		t.Fatalf("no embedded data: %v", err)
	}
	for _, e := range ents {
		mine, _ := dataFS.ReadFile("data/" + e.Name())
		node, err := os.ReadFile(filepath.Join("../../../../infra-api_cloud-me-api/src/code/data", e.Name()))
		if err != nil || !bytes.Equal(mine, node) {
			t.Errorf("data/%s differs from the Node service's copy (%v)", e.Name(), err)
		}
	}
	nodes, _ := filepath.Glob("../../../../infra-api_cloud-me-api/src/code/data/*.json")
	if len(nodes) != len(ents) {
		t.Errorf("the Node service ships %d datasets, this port embeds %d", len(nodes), len(ents))
	}
}

func TestTableDrift(t *testing.T) {
	r := rt(t)
	noop := func(w http.ResponseWriter, req *http.Request, c *reqCtx) {}
	all := map[string]handler{}
	for _, e := range r.Endpoints {
		all[e.Path] = noop
	}
	if _, err := buildTable(r, all); err != nil {
		t.Fatalf("complete table: %v", err)
	}
	extra := map[string]handler{"/me/extra": noop}
	for k, v := range all {
		extra[k] = v
	}
	if _, err := buildTable(r, extra); err == nil {
		t.Error("an undeclared handler must refuse the table")
	}
	for k := range all {
		missing := map[string]handler{}
		for k2, v := range all {
			if k2 != k {
				missing[k2] = v
			}
		}
		if _, err := buildTable(r, missing); err == nil {
			t.Errorf("a declared route without a handler (%s) must refuse the table", k)
		}
	}
}
