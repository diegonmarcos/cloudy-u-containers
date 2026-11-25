//go:build parity

package parity

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// mock stands in for every upstream the broker talks to: GitHub (device flow, token, user), Google (token, userinfo),
// Cloudflare Access (certs) and Resend. It records every call, so the two implementations can be compared on what
// they asked, not only on what they answered.
type mock struct {
	srv *httptest.Server
	mu  sync.Mutex
	log []string

	devN         int
	polls        map[string]int
	certs        string
	certsStatus  int
	resendStatus int
	deviceMode   string
	codes        []string
}

func (m *mock) logf(format string, a ...any) {
	m.mu.Lock()
	m.log = append(m.log, fmt.Sprintf(format, a...))
	m.mu.Unlock()
}

func (m *mock) lastCode() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.codes) == 0 {
		return ""
	}
	return m.codes[len(m.codes)-1]
}

func (m *mock) logText() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(m.log, "\n")
}

func bearerOf(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func writeJSON(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	io.WriteString(w, body)
}

func newMock(t *testing.T, certs string) *mock {
	m := &mock{polls: map[string]int{}, certs: certs, certsStatus: 200, resendStatus: 200}
	mux := http.NewServeMux()
	mux.HandleFunc("/gh/device", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		m.mu.Lock()
		m.devN++
		n, mode := m.devN, m.deviceMode
		m.mu.Unlock()
		m.logf("device method=%s client_id=%s scope=%s accept=%s ua=%s ct=%s", r.Method, r.PostForm.Get("client_id"), r.PostForm.Get("scope"),
			r.Header.Get("Accept"), r.Header.Get("User-Agent"), r.Header.Get("Content-Type"))
		switch mode {
		case "fail":
			writeJSON(w, 500, `{"error":"boom"}`)
		case "nodc":
			writeJSON(w, 200, `{"error":"incorrect_client_credentials"}`)
		case "nouser":
			writeJSON(w, 200, fmt.Sprintf(`{"device_code":"DC-%d","verification_uri":"https://github.example/login/device"}`, n))
		case "html":
			w.WriteHeader(200)
			io.WriteString(w, "<html>not json</html>")
		case "weird":
			writeJSON(w, 200, fmt.Sprintf(`{"device_code":"DC-%d","user_code":"UC-%d","verification_url":"https://github.example/alt","interval":"7","expires_in":"60"}`, n, n))
		default:
			writeJSON(w, 200, fmt.Sprintf(`{"device_code":"DC-%d","user_code":"UC-%d","verification_uri":"https://github.example/login/device","interval":5,"expires_in":900}`, n, n))
		}
	})
	script := map[string][]string{
		"DC-1": {"authorization_pending", "ok:AT-owner"},
		"DC-2": {"slow_down", "ok:AT-stranger"},
		"DC-3": {"access_denied"},
		"DC-4": {"expired_token"},
		"DC-5": {"empty"},
		"DC-6": {"ok:AT-owner"},
		"DC-7": {"ok:AT-idstr"},
		"DC-8": {"ok:AT-badid"},
		"DC-9": {"ok:AT-nobody"},
	}
	mux.HandleFunc("/gh/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f := r.PostForm
		if code := f.Get("code"); code != "" { // web authorization-code leg
			m.logf("gh-code-exchange code=%s verifier=%s redirect=%s client_id=%s secret=%v grant=%s", code, f.Get("code_verifier"), f.Get("redirect_uri"), f.Get("client_id"), f.Get("client_secret") != "", f.Get("grant_type"))
			switch code {
			case "CODE-owner":
				writeJSON(w, 200, `{"access_token":"AT-owner","token_type":"bearer"}`)
			case "CODE-stranger":
				writeJSON(w, 200, `{"access_token":"AT-stranger"}`)
			case "CODE-bad":
				writeJSON(w, 400, `{"error":"bad_verification_code"}`)
			case "CODE-html":
				w.WriteHeader(502)
				io.WriteString(w, "<html>bad gateway</html>")
			default:
				writeJSON(w, 200, `{}`)
			}
			return
		}
		dc := f.Get("device_code")
		m.mu.Lock()
		m.polls[dc]++
		k := m.polls[dc]
		m.mu.Unlock()
		m.logf("token dc=%s poll=%d client_id=%s secret=%v grant=%s", dc, k, f.Get("client_id"), f.Get("client_secret") != "", f.Get("grant_type"))
		sc := script[dc]
		step := "ok:AT-owner"
		if len(sc) > 0 {
			step = sc[len(sc)-1]
			if k-1 < len(sc) {
				step = sc[k-1]
			}
		}
		switch {
		case step == "empty":
			writeJSON(w, 200, `{}`)
		case strings.HasPrefix(step, "ok:"):
			writeJSON(w, 200, fmt.Sprintf(`{"access_token":%q,"token_type":"bearer"}`, strings.TrimPrefix(step, "ok:")))
		default:
			writeJSON(w, 200, fmt.Sprintf(`{"error":%q}`, step))
		}
	})
	mux.HandleFunc("/gh/user", func(w http.ResponseWriter, r *http.Request) {
		at := bearerOf(r)
		m.logf("gh-user auth=%s accept=%s ua=%s", at, r.Header.Get("Accept"), r.Header.Get("User-Agent"))
		switch at {
		case "AT-owner":
			writeJSON(w, 200, `{"id":4242,"login":"Owner-User"}`)
		case "AT-stranger":
			writeJSON(w, 200, `{"id":7,"login":"someone"}`)
		case "AT-idstr":
			writeJSON(w, 200, `{"id":"4242","login":"owner-user"}`)
		case "AT-badid":
			writeJSON(w, 200, `{"id":"abc","login":"owner-user"}`)
		case "AT-nobody":
			writeJSON(w, 200, `{"login":"owner-user"}`)
		default:
			writeJSON(w, 401, `{"message":"Bad credentials"}`)
		}
	})
	mux.HandleFunc("/g/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f := r.PostForm
		m.logf("g-token code=%s verifier=%s redirect=%s client_id=%s secret=%s grant=%s ct=%s", f.Get("code"), f.Get("code_verifier"), f.Get("redirect_uri"), f.Get("client_id"), f.Get("client_secret"), f.Get("grant_type"), r.Header.Get("Content-Type"))
		switch f.Get("code") {
		case "CODE-owner":
			writeJSON(w, 200, `{"access_token":"AT-g-owner","expires_in":3599}`)
		case "CODE-stranger":
			writeJSON(w, 200, `{"access_token":"AT-g-stranger"}`)
		case "CODE-unverified":
			writeJSON(w, 200, `{"access_token":"AT-g-unv"}`)
		case "CODE-bad":
			writeJSON(w, 400, `{"error":"invalid_grant"}`)
		case "CODE-down":
			writeJSON(w, 503, `{"error":"unavailable"}`)
		default:
			writeJSON(w, 200, `{"id_token":"x"}`)
		}
	})
	mux.HandleFunc("/g/userinfo", func(w http.ResponseWriter, r *http.Request) {
		at := bearerOf(r)
		m.logf("g-userinfo auth=%s", at)
		switch at {
		case "AT-g-owner":
			writeJSON(w, 200, `{"email":" Owner@Example.org ","email_verified":true}`)
		case "AT-g-stranger":
			writeJSON(w, 200, `{"email":"stranger@example.org","email_verified":true}`)
		case "AT-g-unv":
			writeJSON(w, 200, `{"email":"owner@example.org","email_verified":"true"}`)
		default:
			writeJSON(w, 401, `{}`)
		}
	})
	mux.HandleFunc("/cf/certs", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		doc, code := m.certs, m.certsStatus
		m.mu.Unlock()
		m.logf("certs method=%s", r.Method)
		writeJSON(w, code, doc)
	})
	mux.HandleFunc("/resend", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		m.logf("resend method=%s auth=%s ct=%s ua=%s body=%s", r.Method, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.Header.Get("User-Agent"), b)
		var d struct{ Text string }
		_ = json.Unmarshal(b, &d)
		if i := strings.Index(d.Text, "code is "); i >= 0 {
			m.mu.Lock()
			m.codes = append(m.codes, d.Text[i+8:i+8+strings.IndexByte(d.Text[i+8:], '.')])
			m.mu.Unlock()
		}
		m.mu.Lock()
		code := m.resendStatus
		m.mu.Unlock()
		writeJSON(w, code, `{"id":"synthetic"}`)
	})
	m.srv = httptest.NewServer(mux)
	t.Cleanup(m.srv.Close)
	return m
}

// ---- synthetic Cloudflare Access keys and tokens -------------------------------------------------------------

type rsaKey struct {
	kid  string
	priv *rsa.PrivateKey
}

func genKey(t *testing.T, kid string) rsaKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return rsaKey{kid, k}
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func certsDoc(keys ...rsaKey) string {
	var parts []string
	for _, k := range keys {
		e := big256(k.priv.E)
		parts = append(parts, fmt.Sprintf(`{"kid":%q,"kty":"RSA","alg":"RS256","use":"sig","e":%q,"n":%q}`, k.kid, b64u(e), b64u(k.priv.N.Bytes())))
	}
	return `{"keys":[` + strings.Join(parts, ",") + `],"public_cert":{"kid":"x"}}`
}

func big256(e int) []byte {
	var b []byte
	for ; e > 0; e >>= 8 {
		b = append([]byte{byte(e & 0xff)}, b...)
	}
	return b
}

// jwt signs header.payload with RS256 unless sig is given.
func jwt(k rsaKey, header, payload string, sig string) string {
	h, p := b64u([]byte(header)), b64u([]byte(payload))
	if sig != "" {
		return h + "." + p + "." + sig
	}
	d := sha256.Sum256([]byte(h + "." + p))
	s, err := rsa.SignPKCS1v15(rand.Reader, k.priv, crypto.SHA256, d[:])
	if err != nil {
		panic(err)
	}
	return h + "." + p + "." + b64u(s)
}

func qs(k, v string) string { return url.QueryEscape(k) + "=" + url.QueryEscape(v) }
