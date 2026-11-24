package execd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func mustRe(s string) *regexp.Regexp { return regexp.MustCompile(s) }

func post(t *testing.T, h http.Handler, path, token, body string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Execd-Token", token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestServerPolicyAuthAudit(t *testing.T) {
	var log bytes.Buffer
	d, _, _ := fakeDocker(t)
	s := &Server{Token: "tok", Pool: NewPool(ParseSSHConfig(""), "/h"), Dock: d, Audit: NewAuditor(&log)}
	h := s.Handler()

	if c, _ := post(t, h, "/v1/exec", "", `{"command":"true"}`); c != 401 {
		t.Fatalf("missing token: %d", c)
	}
	if c, _ := post(t, h, "/v1/exec", "wrong", `{"command":"true"}`); c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	c, body := post(t, h, "/v1/exec", "tok", `{"command":"sh","args":["-c","echo hello; exit 2"]}`)
	var r Result
	json.Unmarshal([]byte(body), &r)
	if c != 200 || r.Stdout != "hello\n" || r.ExitCode != 2 {
		t.Fatalf("%d %s", c, body)
	}
	if c, _ := post(t, h, "/v1/exec", "tok", `{"command":"/bin/sh"}`); c != 403 {
		t.Fatalf("path command: %d", c)
	}
	if c, _ := post(t, h, "/v1/exec", "tok", `{"command":"rm","args":["-rf","/"]}`); c != 403 {
		t.Fatalf("rm: %d", c)
	}
	if c, _ := post(t, h, "/v1/ssh", "tok", `{"alias":"a b; id","command":"x"}`); c != 403 {
		t.Fatalf("alias: %d", c)
	}
	if c, _ := post(t, h, "/v1/docker", "tok", `{"method":"POST","path":"/containers/x/kill"}`); c != 403 {
		t.Fatalf("docker kill: %d", c)
	}
	if c, b := post(t, h, "/v1/docker", "tok", `{"method":"GET","path":"/containers/json"}`); c != 200 || !strings.Contains(b, "caddy") {
		t.Fatalf("docker: %d %s", c, b)
	}
	if c, _ := post(t, h, "/v1/exec", "tok", `not json`); c != 400 {
		t.Fatalf("bad json: %d", c)
	}
	a := log.String()
	for _, want := range []string{"[c3-execd] [AUDIT]", "exec sh argc=2", "exec rm → DENIED", "docker POST /containers/x/kill → DENIED"} {
		if !strings.Contains(a, want) {
			t.Errorf("audit lacks %q:\n%s", want, a)
		}
	}
	if strings.Contains(a, "echo hello") {
		t.Errorf("argv leaked into the audit log:\n%s", a)
	}
}

func TestHealthNeedsNoToken(t *testing.T) {
	s := &Server{Token: "tok", Pool: NewPool(ParseSSHConfig(""), "/h"), Audit: NewAuditor(&bytes.Buffer{})}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
}
