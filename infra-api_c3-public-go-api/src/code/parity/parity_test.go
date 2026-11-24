//go:build parity

// Parity harness: the Node service (infra-api_c3-public-api/src/code/api/index.ts under tsx, the reference; npm ci runs
// once here) and the Go port get identical environments (own fake analytics backends, own fake SMTP store, same bundle) and
// the SAME ordered request list. Status, selected headers and raw bodies must be identical, and so must everything the
// fakes saw. PARITY_MUTATE=1 makes the Go side's rate limit one lower; the harness must then report differing requests.
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
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"c3public-api/c3pub"
)

// ---- fake SMTP store ----

type smtpRec struct {
	Helo string
	From string
	To   []string
	Data string
}

type fakeSMTP struct {
	ln   net.Listener
	mu   sync.Mutex
	Msgs []smtpRec
}

func newSMTP(t *testing.T) *fakeSMTP {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeSMTP) addr() (string, int) {
	h, p, _ := net.SplitHostPort(f.ln.Addr().String())
	var port int
	fmt.Sscanf(p, "%d", &port)
	return h, port
}

func (f *fakeSMTP) serve(c net.Conn) {
	defer c.Close()
	rd := bufio.NewReader(c)
	w := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
	w("220 fake ESMTP")
	var rec smtpRec
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		up := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
			rec.Helo = strings.TrimSpace(line[4:])
			w("250 fake")
		case strings.HasPrefix(up, "MAIL FROM:"):
			rec.From = strings.Trim(strings.SplitN(line[10:], " ", 2)[0], "<> ")
			w("250 ok")
		case strings.HasPrefix(up, "RCPT TO:"):
			to := strings.Trim(strings.SplitN(line[8:], " ", 2)[0], "<> ")
			if strings.Contains(to, "reject") {
				w("550 5.1.1 no such user")
				continue
			}
			rec.To = append(rec.To, to)
			w("250 ok")
		case up == "DATA":
			w("354 go")
			var data bytes.Buffer
			for {
				l, err := rd.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				data.WriteString(strings.TrimPrefix(l, "."))
				if strings.HasPrefix(l, "..") {
					// dot-unstuffing: only one leading dot is removed
				}
			}
			rec.Data = data.String()
			if len(rec.To) > 0 && strings.Contains(rec.To[0], "slow") {
				time.Sleep(1500 * time.Millisecond)
			}
			f.mu.Lock()
			f.Msgs = append(f.Msgs, rec)
			f.mu.Unlock()
			w("250 queued")
			rec = smtpRec{}
		case up == "QUIT":
			w("221 bye")
			return
		case up == "RSET":
			rec = smtpRec{}
			w("250 ok")
		default:
			w("502 unsupported")
		}
	}
}

func (f *fakeSMTP) snapshot() []smtpRec {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]smtpRec(nil), f.Msgs...)
	return out
}

// ---- fake analytics backend ----

type hit struct {
	Method, URL, Auth, CType, Body string
}

type fakeBackend struct {
	srv  *httptest.Server
	mu   sync.Mutex
	Hits []hit
}

func newBackend(t *testing.T) *fakeBackend {
	f := &fakeBackend{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.Hits = append(f.Hits, hit{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(b)})
		f.mu.Unlock()
		switch {
		case strings.Contains(r.URL.Path, "teapot"):
			w.WriteHeader(418)
			io.WriteString(w, "short and stout")
		case r.Method == "POST":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Backend", "fake")
			w.WriteHeader(201)
			io.WriteString(w, `{"ok":true}`)
		default:
			w.Header().Set("Content-Type", "image/gif")
			w.WriteHeader(200)
			io.WriteString(w, "GIF89a")
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeBackend) snapshot() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.Hits...)
}

// ---- one service instance (Node or Go) ----

type inst struct {
	url     string
	smtp    *fakeSMTP
	backend *fakeBackend
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

type env struct {
	m map[string]string
}

func buildEnv(t *testing.T, sm *fakeSMTP, be *fakeBackend, bundle, superapp string, port string, rate int) map[string]string {
	sh, sp := sm.addr()
	bj, _ := json.Marshal(map[string]any{
		"matomo":      map[string]any{"url": be.srv.URL + "/matomo.php", "service": "matomo", "methods": []string{"GET", "POST"}, "auth_header_env": nil},
		"umami":       map[string]any{"url": be.srv.URL + "/api/send", "service": "umami", "methods": []string{"POST"}, "auth_header_env": nil},
		"openobserve": map[string]any{"url": be.srv.URL + "/openobserve/api/default/default/_json", "service": "openobserve", "methods": []string{"POST"}, "auth_header_env": "OPENOBSERVE_AUTHORIZATION"},
	})
	lj, _ := json.Marshal(map[string]any{"max_body_bytes": 4096, "max_ingest_lines": 5000, "rate_per_ip_per_min": rate, "rate_per_sid_per_min": 1000, "request_timeout_ms": 300, "smtp_timeout_ms": 5000, "dedupe_ttl_ms": 1800000})
	tj, _ := json.Marshal(map[string]any{"maddy-direct": map[string]any{"host": sh, "port": sp}})
	return map[string]string{
		"HOST": "127.0.0.1", "PORT": port, "BASE_PATH": "/c3-public-api",
		"BACKENDS_JSON": string(bj), "LIMITS_JSON": string(lj), "OPENOBSERVE_AUTHORIZATION": "Basic b2JzZXJ2ZTpwdw==",
		"SMTP_HOST": sh, "SMTP_PORT": fmt.Sprint(sp), "MAIL_TARGETS_JSON": string(tj), "SMTP_HELO_DOMAIN": "c3-public-api.diegonmarcos.com",
		"PROFILE_CONNECT_MAIL_TO": "me@diegonmarcos.com", "PROFILE_CONNECT_MAIL_FROM": "superapp-connect@diegonmarcos.com",
		"PROFILE_CONNECT_CODE_TTL_S": "600", "PROFILE_CONNECT_RESEND_COOLDOWN_S": "60", "PROFILE_CONNECT_MAX_ATTEMPTS": "3",
		"PROFILE_CONNECT_BUNDLE_DIR": bundle, "SUPERAPP_DIR": superapp, "LOG_LEVEL": "silent",
	}
}

// ---- requests ----

type spec struct {
	Method  string
	Path    string
	Headers map[string]string
	Body    string
	Loose   bool   // compare the status only (the body quotes the V8 JSON parser message, which varies by Node version)
	XFF     string // client address (default: a fresh one per request so the rate limit never interferes)
}

type rec struct {
	Status  int
	Headers map[string]string
	Body    string
}

var cmpHeaders = []string{"Content-Type", "Content-Length", "Cache-Control", "Retry-After", "Allow", "X-Backend",
	"X-Ratelimit-Limit", "X-Ratelimit-Remaining", "X-Ratelimit-Reset", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials",
	"Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Expose-Headers", "Access-Control-Max-Age", "Vary"}

var counter int

func do(t *testing.T, base string, s spec) rec {
	t.Helper()
	m := s.Method
	if m == "" {
		m = "GET"
	}
	var body io.Reader
	if s.Body != "" {
		body = strings.NewReader(s.Body)
	}
	req, err := http.NewRequest(m, base+s.Path, body)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range s.Headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("X-Forwarded-For") == "" && s.XFF != "-" {
		x := s.XFF
		if x == "" {
			x = fmt.Sprintf("198.51.100.%d", 1+counter%250)
			counter++
		}
		req.Header.Set("X-Forwarded-For", x)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", m, s.Path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := rec{Status: res.StatusCode, Headers: map[string]string{}, Body: string(b)}
	for _, h := range cmpHeaders {
		if v := res.Header.Get(h); v != "" {
			if h == "Content-Length" && res.StatusCode == 204 {
				continue // net/http drops Content-Length on 204 (Node sends 0): semantically equal
			}
			if strings.HasPrefix(h, "X-Ratelimit-Reset") || h == "Retry-After" {
				v = "<N>"
			}
			r.Headers[h] = v
		}
	}
	return r
}

func requests() []spec {
	j := map[string]string{"Content-Type": "application/json"}
	mesh := "10.0.0.7"
	rfc := "From: Sender <sender@example.org>\r\nTo: Rcpt <rcpt@diegonmarcos.com>\r\nSubject: hello\r\nMessage-ID: <%s@example.org>\r\n\r\nbody line\r\n.dot line\r\n"
	msg := func(id string) string { return fmt.Sprintf(rfc, id) }
	b64 := func(s string) string { return strings.TrimRight(encodeB64([]byte(s)), "\n") }
	rs := []spec{
		{Path: "/health"}, {Method: "HEAD", Path: "/health"}, {Path: "/ready"}, {Method: "HEAD", Path: "/ready"}, {Path: "/health/"}, {Path: "/health?x=1"},
		{Method: "POST", Path: "/health"}, {Method: "DELETE", Path: "/ready"}, {Method: "POST", Path: "/superapp/config/diego"}, {Method: "GET", Path: "/profile/connect/start"}, {Method: "GET", Path: "/analytics/matomo/x/y"}, {Path: "/nope"}, {Path: "/"}, {Path: "/c3-public-api/health"},
		{Method: "OPTIONS", Path: "/health"},
		{Method: "OPTIONS", Path: "/health", Headers: map[string]string{"Origin": "https://c3.diegonmarcos.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}},
		{Method: "OPTIONS", Path: "/nope", Headers: map[string]string{"Origin": "https://c3.diegonmarcos.com", "Access-Control-Request-Method": "GET"}},
		{Path: "/health", Headers: map[string]string{"Origin": "https://c3.diegonmarcos.com"}},
		{Path: "/nope", Headers: map[string]string{"Origin": "null"}},
		// superapp
		{Path: "/superapp/config/diego"}, {Method: "HEAD", Path: "/superapp/config/diego"}, {Path: "/superapp/config/nobody"}, {Path: "/superapp/config/Bad%20Slug"},
		{Path: "/superapp/config/-x"}, {Path: "/superapp/config/diego/extra"}, {Path: "/superapp/config/"}, {Path: "/superapp/config/..%2Fsecret"},
		// analytics
		{Path: "/analytics/matomo?idsite=1&rec=1"}, {Path: "/analytics/matomo"}, {Method: "POST", Path: "/analytics/matomo", Headers: j, Body: `{ "a" : 1, "b":[1, 2] }`},
		{Method: "POST", Path: "/analytics/matomo", Headers: map[string]string{"Content-Type": "text/plain"}, Body: "plain body"},
		{Method: "POST", Path: "/analytics/umami", Headers: j, Body: `{"type":"event","payload":{"url":"/"}}`},
		{Method: "POST", Path: "/analytics/openobserve", Headers: j, Body: `[{"a":1}]`},
		{Method: "POST", Path: "/analytics/openobserve", Headers: map[string]string{"Content-Type": "application/json", "Authorization": "Bearer caller"}, Body: `[{"a":2}]`},
		{Method: "POST", Path: "/analytics/matomo", Headers: j, Body: `{bad json`, Loose: true},
		{Method: "POST", Path: "/analytics/matomo", Headers: j, Body: strings.Repeat("x", 5000)},
		{Method: "PUT", Path: "/analytics/umami", Headers: j, Body: `{"a":1}`},
		{Method: "DELETE", Path: "/analytics/matomo"}, {Method: "HEAD", Path: "/analytics/matomo"},
		{Path: "/analytics/matomo/sub?x=1"}, {Path: "/analytics/matomo/"}, {Path: "/analytics/matomo/teapot"},
		{Path: "/analytics/nope"}, {Path: "/analytics/"}, {Path: "/analytics"},
		{Method: "OPTIONS", Path: "/analytics/matomo", Headers: map[string]string{"Origin": "https://c3.diegonmarcos.com", "Access-Control-Request-Method": "POST"}},
		// mail bridge: auth
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m0"), XFF: "203.0.113.9"},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Auth-User": "cf-worker"}, Body: msg("m1"), XFF: "203.0.113.9"},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "Remote-User": "diego"}, Body: msg("m2"), XFF: "203.0.113.9"},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m3"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m3"), XFF: mesh}, // same Message-ID: deduped
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m4"), XFF: "172.18.0.4"},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m5"), XFF: "10.1.0.3"},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: msg("m6"), XFF: "11.0.0.1"},
		// mail bridge: bodies
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `{"raw":"` + b64(msg("j1")) + `"}`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `{"raw":""}`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `{"other":1}`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `[1]`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `null`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `5`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `"` + strings.ReplaceAll(msg("j2"), "\r\n", `\r\n`) + `"`, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: ``, XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: j, Body: `{bad`, XFF: mesh, Loose: true},
		{Method: "POST", Path: "/mail/http-to-smtp", XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: strings.Repeat("x", 5000), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "message/rfc822"}, Body: strings.ReplaceAll(msg("m7"), "\r\n", "\n"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: "Subject: no from, no msgid\r\n\r\nx\r\n", XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Original-To": "envelope@diegonmarcos.com"}, Body: msg("m8"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain"}, Body: "From: A B <a@x.org>\r\nTo: x@y.org,\r\n z@y.org\r\nMessage-ID:\r\n <folded@x.org>\r\n\r\nhi\r\n", XFF: mesh},
		{Method: "GET", Path: "/mail/http-to-smtp", XFF: mesh}, {Method: "PUT", Path: "/mail/http-to-smtp", XFF: mesh},
		// mail targets
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Mail-Target": "maddy-direct"}, Body: msg("t1"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Mail-Target": " Maddy "}, Body: msg("t2"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Mail-Target": "stalwart"}, Body: msg("t3"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Mail-Target": "nope"}, Body: msg("t4"), XFF: mesh},
		// mail delivery failure + slow (pending, then a retry that joins / is answered)
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Original-To": "reject@diegonmarcos.com"}, Body: msg("f1"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Original-To": "slow@diegonmarcos.com"}, Body: msg("s1"), XFF: mesh},
		{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Original-To": "slow@diegonmarcos.com"}, Body: msg("s1"), XFF: mesh},
	}
	return rs
}

func encodeB64(b []byte) string {
	const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var sb strings.Builder
	for i := 0; i < len(b); i += 3 {
		var v uint32
		n := 0
		for j := 0; j < 3; j++ {
			v <<= 8
			if i+j < len(b) {
				v |= uint32(b[i+j])
				n++
			}
		}
		for k := 0; k < 4; k++ {
			if k <= n {
				sb.WriteByte(a[(v>>(18-6*uint(k)))&63])
			} else {
				sb.WriteByte('=')
			}
		}
	}
	return sb.String()
}

// ---- profile connect flow (codes are random, so the flow reads each side's own mailed code) ----

var codeRe = regexp.MustCompile(`SuperApp Connect code: (\d{6})`)

func profileFlow(t *testing.T, label string, n, g *inst, diffs *int) {
	auth := map[string]string{"X-Auth-User": "diego"}
	post := func(i *inst, path, body string, hdr map[string]string) rec {
		h := map[string]string{"Content-Type": "application/json"}
		for k, v := range hdr {
			h[k] = v
		}
		return do(t, i.url, spec{Method: "POST", Path: path, Headers: h, Body: body, XFF: "-"})
	}
	check := func(step string, a, b rec) {
		if !reflect.DeepEqual(a, b) {
			*diffs++
			t.Errorf("[%s] profile %s differs\n  node: %+v\n  go:   %+v", label, step, a, b)
		}
	}
	lastCode := func(i *inst) string {
		ms := i.smtp.snapshot()
		for k := len(ms) - 1; k >= 0; k-- {
			if m := codeRe.FindStringSubmatch(ms[k].Data); m != nil {
				return m[1]
			}
		}
		return ""
	}
	check("start without identity", post(n, "/profile/connect/start", "", nil), post(g, "/profile/connect/start", "", nil))
	check("fetch without identity", post(n, "/profile/connect/fetch", `{"code":"1"}`, nil), post(g, "/profile/connect/fetch", `{"code":"1"}`, nil))
	check("fetch no code issued", post(n, "/profile/connect/fetch", `{"code":"123456"}`, auth), post(g, "/profile/connect/fetch", `{"code":"123456"}`, auth))
	check("start", post(n, "/profile/connect/start", "", auth), post(g, "/profile/connect/start", "", auth))
	check("start again (cooldown)", post(n, "/profile/connect/start", "", auth), post(g, "/profile/connect/start", "", auth))
	cn, cg := lastCode(n), lastCode(g)
	if cn == "" || cg == "" {
		*diffs++
		t.Errorf("[%s] a code was not mailed (node %q go %q)", label, cn, cg)
		return
	}
	bad := "000000"
	if cn == bad || cg == bad {
		bad = "111111"
	}
	check("bad code 1", post(n, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth), post(g, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth))
	check("bad code 2", post(n, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth), post(g, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth))
	check("no code field", post(n, "/profile/connect/fetch", `{}`, auth), post(g, "/profile/connect/fetch", `{}`, auth))
	check("other identity has no code", post(n, "/profile/connect/fetch", `{"code":"`+cn+`"}`, map[string]string{"Remote-User": "someone"}), post(g, "/profile/connect/fetch", `{"code":"`+cg+`"}`, map[string]string{"Remote-User": "someone"}))
	// the third wrong guess burns the code
	check("bad code 3 (too many)", post(n, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth), post(g, "/profile/connect/fetch", `{"code":"`+bad+`"}`, auth))
	check("burnt code", post(n, "/profile/connect/fetch", `{"code":"`+cn+`"}`, auth), post(g, "/profile/connect/fetch", `{"code":"`+cg+`"}`, auth))
	time.Sleep(10 * time.Millisecond)
	// a second identity: issue, then fetch with the right code (padded with spaces: the code is trimmed)
	auth2 := map[string]string{"Remote-User": "other"}
	check("start 2", post(n, "/profile/connect/start", "", auth2), post(g, "/profile/connect/start", "", auth2))
	cn, cg = lastCode(n), lastCode(g)
	check("fetch ok", post(n, "/profile/connect/fetch", `{"code":" `+cn+` "}`, auth2), post(g, "/profile/connect/fetch", `{"code":" `+cg+` "}`, auth2))
	check("fetch single use", post(n, "/profile/connect/fetch", `{"code":"`+cn+`"}`, auth2), post(g, "/profile/connect/fetch", `{"code":"`+cg+`"}`, auth2))
	check("fetch bad json", post(n, "/profile/connect/fetch", `{bad`, auth2).withoutBody(), post(g, "/profile/connect/fetch", `{bad`, auth2).withoutBody())
}

func (r rec) withoutBody() rec {
	r.Body = "<omitted>"
	h := map[string]string{}
	for k, v := range r.Headers {
		h[k] = v
	}
	h["Content-Length"] = ""
	r.Headers = h
	return r
}

// normalise what legitimately differs between two runs of the same service: the one-time code, Date and the
// timestamp-derived Message-ID of the profile mail.
var volatile = regexp.MustCompile(`(?m)(code: |code is )\d{6}|^Date: .*$|profile-connect-\d+@`)

func smtpView(ms []smtpRec) string {
	var out []string
	for _, m := range ms {
		d := strings.ReplaceAll(m.Data, "\r\n", "\n")
		d = volatile.ReplaceAllString(d, "<v>")
		out = append(out, fmt.Sprintf("helo=%s from=%s to=%v data=%q", m.Helo, m.From, m.To, d))
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}

func TestParity(t *testing.T) {
	root, _ := filepath.Abs("../../../..")
	nodeCode := filepath.Join(root, "infra-api_c3-public-api", "src", "code")
	tsx := filepath.Join(nodeCode, "node_modules", ".bin", "tsx")
	if _, err := os.Stat(tsx); err != nil {
		cmd := exec.Command("npm", "ci", "--omit=dev", "--no-audit", "--no-fund")
		cmd.Dir = nodeCode
		if out, err := cmd.CombinedOutput(); err != nil {
			if os.Getenv("PARITY_REQUIRE") == "" {
				t.Skipf("npm ci unavailable: %v", err)
			}
			t.Fatalf("npm ci: %v\n%s", err, out)
		}
	}
	mutate := os.Getenv("PARITY_MUTATE") != ""

	work := t.TempDir()
	bundle := filepath.Join(work, "bundle")
	_ = os.MkdirAll(bundle, 0o755)
	_ = os.WriteFile(filepath.Join(bundle, "profile-secrets.json"), []byte(`{"schema_version":3,"profile":{"name":"Diego","n":1.50},"z":[1,{"a":"é"}]}`), 0o644)
	_ = os.WriteFile(filepath.Join(bundle, "schema.json"), []byte(`{"type":"object","title":"<S>"}`), 0o644)
	superapp := filepath.Join(work, "superapp")
	_ = os.MkdirAll(superapp, 0o755)
	_ = os.WriteFile(filepath.Join(superapp, "build-cloud-superapp-diego.json"), []byte("{\"_meta\":{\"secrets_included\":false},\"wg\":{\"ip\":\"10.0.0.9\"}}\n"), 0o644)

	// Node (reference)
	nodeSMTP, nodeBE := newSMTP(t), newBackend(t)
	nport := freePort(t)
	cmd := exec.Command(tsx, filepath.Join(nodeCode, "api", "index.ts"))
	cmd.Dir = superapp
	cmd.Env = append(os.Environ(), "NODE_ENV=production")
	for k, v := range buildEnv(t, nodeSMTP, nodeBE, bundle, superapp, nport, 60) {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var logb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logb, &logb
	if err := cmd.Start(); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "" {
			t.Skipf("node unavailable: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	node := &inst{url: "http://127.0.0.1:" + nport, smtp: nodeSMTP, backend: nodeBE}
	deadline := time.Now().Add(60 * time.Second)
	for {
		res, err := http.Get(node.url + "/health")
		if err == nil {
			res.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("node service did not start: %s", logb.String())
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Go port
	goSMTP, goBE := newSMTP(t), newBackend(t)
	rate := 60
	if mutate {
		rate = 59
	}
	genv := buildEnv(t, goSMTP, goBE, bundle, superapp, "0", rate)
	cfg, err := c3pub.LoadConfig(func(k string) string { return genv[k] })
	if err != nil {
		t.Fatal(err)
	}
	gs := httptest.NewServer(c3pub.New(cfg))
	t.Cleanup(gs.Close)
	goI := &inst{url: gs.URL, smtp: goSMTP, backend: goBE}

	diffs, total := 0, 0
	reqs := requests()
	for i, rs := range reqs {
		a := do(t, node.url, rs)
		b := do(t, goI.url, rs)
		total++
		if rs.Loose {
			a.Body, b.Body = "", ""
			a.Headers["Content-Length"], b.Headers["Content-Length"] = "", ""
		}
		if !reflect.DeepEqual(a, b) {
			diffs++
			t.Errorf("request %d %s %s differs\n  node: %d %v %q\n  go:   %d %v %q", i, rs.Method, rs.Path, a.Status, a.Headers, trunc(a.Body), b.Status, b.Headers, trunc(b.Body))
		}
	}
	// rate limit: one client address, 62 requests to a rate-limited route; the 61st and 62nd are refused
	for i := 0; i < 62; i++ {
		rs := spec{Path: "/superapp/config/nobody", XFF: "192.0.2.77"}
		a := do(t, node.url, rs)
		b := do(t, goI.url, rs)
		total++
		if !reflect.DeepEqual(a, b) {
			diffs++
			t.Errorf("rate limit request %d differs\n  node: %d %v %q\n  go:   %d %v %q", i, a.Status, a.Headers, trunc(a.Body), b.Status, b.Headers, trunc(b.Body))
			break
		}
	}
	// the allow-listed routes are never counted, even from the exhausted client
	for _, p := range []string{"/health", "/ready"} {
		rs := spec{Path: p, XFF: "192.0.2.77"}
		a, b := do(t, node.url, rs), do(t, goI.url, rs)
		total++
		if !reflect.DeepEqual(a, b) || a.Status != 200 {
			diffs++
			t.Errorf("allow-listed %s from an exhausted client differs\n  node: %+v\n  go:   %+v", p, a, b)
		}
	}
	time.Sleep(2500 * time.Millisecond) // let the slow SMTP session of the pending case finish on both sides
	rs := spec{Method: "POST", Path: "/mail/http-to-smtp", Headers: map[string]string{"Content-Type": "text/plain", "X-Original-To": "slow@diegonmarcos.com"}, Body: fmt.Sprintf("From: Sender <sender@example.org>\r\nTo: Rcpt <rcpt@diegonmarcos.com>\r\nMessage-ID: <s1@example.org>\r\n\r\nbody line\r\n.dot line\r\n"), XFF: "10.0.0.7"}
	a, b := do(t, node.url, rs), do(t, goI.url, rs)
	total++
	if !reflect.DeepEqual(a, b) || a.Status != 200 {
		diffs++
		t.Errorf("a retry after the slow session finished must be answered delivered/deduped without a new send\n  node: %+v\n  go:   %+v", a, b)
	}

	profileFlow(t, "profile", node, goI, &diffs)

	// everything the fakes saw
	if x, y := smtpView(node.smtp.snapshot()), smtpView(goI.smtp.snapshot()); x != y {
		diffs++
		t.Errorf("SMTP-visible behaviour differs\n--- node\n%s\n--- go\n%s", x, y)
	}
	nb, _ := json.Marshal(sortHits(node.backend.snapshot()))
	gb, _ := json.Marshal(sortHits(goI.backend.snapshot()))
	if !bytes.Equal(nb, gb) {
		diffs++
		t.Errorf("backend-visible behaviour differs\n--- node\n%s\n--- go\n%s", nb, gb)
	}

	if diffs > 0 {
		t.Fatalf("%d of %d requests differ", diffs, total)
	}
	t.Logf("parity: %d requests + profile-connect flow + rate limit + fakes' view identical", total)
	fmt.Println("PARITY OK", total)
}

func sortHits(h []hit) []hit {
	sort.Slice(h, func(i, j int) bool { return fmt.Sprint(h[i]) < fmt.Sprint(h[j]) })
	return h
}

func trunc(s string) string {
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}
