//go:build parity

// Parity harness: the same decision corpus goes through the REAL Node authz.mjs/upstream.mjs (reference, both
// service copies) and through this Go package; every decision must be identical. PARITY_MUTATE=1 skews the
// corpus the Node side sees; the harness must then report differing decisions (proves it can go red).
package parity

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"authz"
)

type bearerCase struct {
	Header *string        `json:"header"`
	Verify string         `json:"verify"`
	Scope  string         `json:"scope"`
	Claims map[string]any `json:"claims"`
}
type sessionCase struct {
	Cookie *string  `json:"cookie"`
	Verify string   `json:"verify"`
	User   string   `json:"user"`
	Users  []string `json:"users"`
}
type meshCase struct {
	Addr    string            `json:"addr"`
	Headers map[string]string `json:"headers"`
	Cidrs   []string          `json:"cidrs"`
}
type corpus struct {
	Bearer  []bearerCase     `json:"bearer"`
	Session []sessionCase    `json:"session"`
	Scopes  []map[string]any `json:"scopes"`
	Mesh    []meshCase       `json:"mesh"`
}
type result struct {
	OK     bool   `json:"ok"`
	User   string `json:"user"`
	Status int    `json:"status"`
	Code   string `json:"code"`
	Error  string `json:"error"`
}
type nodeOut struct {
	Bearer  []result   `json:"bearer"`
	Session []result   `json:"session"`
	Scopes  [][]string `json:"scopes"`
	Mesh    []bool     `json:"mesh"`
}

func norm(d authz.Decision) result {
	if d.OK {
		return result{OK: true, User: d.User}
	}
	return result{Status: d.Status, Code: d.Code, Error: d.Error}
}

func runNode(t *testing.T, casesPath, authzMjs, upstreamMjs string) nodeOut {
	t.Helper()
	cmd := exec.Command("node", "parity/driver.mjs", casesPath, authzMjs, upstreamMjs)
	cmd.Dir = ".."
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "" {
			t.Skipf("node unavailable: %v", err)
		}
		t.Fatalf("node driver: %v\n%s", err, errb.String())
	}
	var n nodeOut
	if err := json.Unmarshal(out.Bytes(), &n); err != nil {
		t.Fatalf("driver output: %v", err)
	}
	return n
}

func TestParity(t *testing.T) {
	root, _ := filepath.Abs("../../../..")
	casesPath, _ := filepath.Abs("../testdata/cases.json")
	raw, err := os.ReadFile(casesPath)
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}

	// Go side.
	var goOut nodeOut
	for _, b := range c.Bearer {
		verify := func(string) (authz.Claims, error) {
			switch b.Verify {
			case "accept":
				return authz.Claims(b.Claims), nil
			case "jwks_down":
				return nil, authz.ErrJWKSUnavailable
			}
			return nil, os.ErrInvalid
		}
		h := ""
		if b.Header != nil {
			h = *b.Header
		}
		goOut.Bearer = append(goOut.Bearer, norm(authz.DecideAuth(h, verify, b.Scope)))
	}
	for _, s := range c.Session {
		verify := func(string) (string, error) {
			switch s.Verify {
			case "accept":
				return s.User, nil
			case "down":
				return "", authz.ErrSessionUnavailable
			}
			return "", os.ErrInvalid
		}
		ck := ""
		if s.Cookie != nil {
			ck = *s.Cookie
		}
		goOut.Session = append(goOut.Session, norm(authz.DecideSession(ck, verify, s.Users)))
	}
	for _, sc := range c.Scopes {
		goOut.Scopes = append(goOut.Scopes, authz.ScopesOf(authz.Claims(sc)))
	}
	for _, m := range c.Mesh {
		h := http.Header{}
		for k, v := range m.Headers {
			h.Set(k, v)
		}
		goOut.Mesh = append(goOut.Mesh, authz.IsDirectMesh(m.Addr, h, m.Cidrs))
	}

	if os.Getenv("PARITY_MUTATE") != "" {
		// Skew what the reference sees: drop the required scope everywhere.
		for i := range c.Bearer {
			c.Bearer[i].Scope = ""
		}
		mb, _ := json.Marshal(c)
		casesPath = filepath.Join(t.TempDir(), "mutated.json")
		if err := os.WriteFile(casesPath, mb, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	refs := []string{"infra-api_cloudy-drive-git-proxy-api", "infra-api_cloud-me-api"}
	diffs := 0
	for _, svc := range refs {
		src := filepath.Join(root, svc, "src", "code")
		ref := runNode(t, casesPath, filepath.Join(src, "authz.mjs"), filepath.Join(root, "infra-api_cloudy-drive-git-proxy-api", "src", "code", "upstream.mjs"))
		for i := range goOut.Bearer {
			if goOut.Bearer[i] != ref.Bearer[i] {
				t.Errorf("%s bearer[%d] %q: go=%+v node=%+v", svc, i, hdr(c.Bearer[i].Header), goOut.Bearer[i], ref.Bearer[i])
				diffs++
			}
		}
		for i := range goOut.Session {
			if goOut.Session[i] != ref.Session[i] {
				t.Errorf("%s session[%d]: go=%+v node=%+v", svc, i, goOut.Session[i], ref.Session[i])
				diffs++
			}
		}
		for i := range goOut.Scopes {
			if !reflect.DeepEqual(goOut.Scopes[i], ref.Scopes[i]) {
				t.Errorf("%s scopes[%d]: go=%v node=%v", svc, i, goOut.Scopes[i], ref.Scopes[i])
				diffs++
			}
		}
		for i := range goOut.Mesh {
			if goOut.Mesh[i] != ref.Mesh[i] {
				t.Errorf("%s mesh[%d] %+v: go=%v node=%v", svc, i, c.Mesh[i], goOut.Mesh[i], ref.Mesh[i])
				diffs++
			}
		}
	}
	if diffs > 0 {
		t.Fatalf("%d requests differ", diffs)
	}
	t.Logf("parity: %d bearer + %d session + %d scopes + %d mesh decisions identical against %d Node copies",
		len(c.Bearer), len(c.Session), len(c.Scopes), len(c.Mesh), len(refs))
}

func hdr(p *string) string {
	if p == nil {
		return "<undefined>"
	}
	return strings.ReplaceAll(*p, "\x00", "?")
}
