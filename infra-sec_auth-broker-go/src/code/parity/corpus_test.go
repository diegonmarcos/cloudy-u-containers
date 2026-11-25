//go:build parity

package parity

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// docJSON is the synthetic build.json both sides load: one provider of every flow, pointing at the mock upstreams.
func docJSON(mockURL string, mut func(ab map[string]any)) string {
	ab := map[string]any{
		"allowed_emails": []string{"owner@example.org"},
		"allowed_github": []any{map[string]any{"login": "Owner-User", "id": 4242, "email": "owner@example.org"}},
		"cookie_name":    cookieName, "cookie_domain": ".example.org", "cookie_expire_seconds": 43200, "rd_domain": "example.org",
		"cloudflare_access": map[string]any{"enabled": true, "team_domain": "team.cloudflareaccess.example", "certs_url": mockURL + "/cf/certs", "aud": []string{"aud-tag-1", "aud-tag-2"}},
		"email_otp": map[string]any{"code_length": 6, "ttl_seconds": 600, "max_attempts": 3, "send_per_address": 3, "send_window_seconds": 600, "send_per_ip": 10,
			"subject": "Your sign-in code", "resend": map[string]any{"url": mockURL + "/resend", "from": "Sign in <signin@example.org>", "api_key_env": "AB_RESEND_KEY"}},
		"providers": []any{
			map[string]any{"id": "google", "label": "Google", "enabled": true, "provider": "google", "flow": "web", "secret_prefix": "AB_GOOGLE", "port": 4180,
				"prefix": "/oauth2/google", "scope": "openid email", "token_url": mockURL + "/g/token", "userinfo_url": mockURL + "/g/userinfo",
				"auth_url":      "https://accounts.example/o/auth",
				"redirect_uris": []string{"https://auth.example.org/oauth2/google/callback", "https://account.example.org/oauth2/google/callback"}},
			map[string]any{"id": "github", "label": "GitHub", "enabled": true, "provider": "github", "flow": "device", "client_id": "gh-public-client", "port": 4181,
				"prefix": "/oauth2/github", "scope": "read:user", "device_url": mockURL + "/gh/device", "token_url": mockURL + "/gh/token", "user_url": mockURL + "/gh/user",
				"web": map[string]any{"enabled": true, "client_id": "gh-app-client", "secret_prefix": "AB_GHAPP", "scope": "read:user",
					"auth_url": "https://github.example/login/oauth/authorize", "token_url": mockURL + "/gh/token",
					"redirect_uris": []string{"https://auth.example.org/oauth2/github/callback"}}},
			map[string]any{"id": "ghdev", "label": "GitHub <device>", "enabled": true, "provider": "github", "flow": "device", "client_id": "gh-public-client", "secret_prefix": "AB_GHDEV",
				"port": 4184, "prefix": "/oauth2/ghdev", "scope": "read:user", "device_url": mockURL + "/gh/device", "token_url": mockURL + "/gh/token", "user_url": mockURL + "/gh/user"},
			map[string]any{"id": "ghoff", "label": "Off", "enabled": false, "provider": "github", "flow": "device", "port": 4185, "prefix": "/oauth2/ghoff", "scope": "read:user",
				"device_url": mockURL + "/gh/device", "token_url": mockURL + "/gh/token", "user_url": mockURL + "/gh/user"},
			map[string]any{"id": "cloudflare", "label": "Cloudflare One", "enabled": true, "provider": "cloudflare", "flow": "access", "port": 4182, "prefix": "/oauth2/cloudflare",
				"hosts": []string{"auth.example.org", "account.example.org"}, "login_url": "https://auth-cf.example.org/oauth2/cloudflare/callback", "home_url": "https://auth.example.org/"},
			map[string]any{"id": "email", "label": "Email code", "enabled": true, "provider": "email", "flow": "email", "port": 4183, "prefix": "/oauth2/email"},
		},
	}
	if mut != nil {
		mut(ab)
	}
	b, err := json.Marshal(map[string]any{"auth_broker": ab})
	if err != nil {
		panic(err)
	}
	return string(b)
}

func worldFor(t *testing.T, prov, seed string, certs func() string, mut ...func(map[string]any)) world {
	var m func(map[string]any)
	if len(mut) > 0 {
		m = mut[0]
	}
	return world{prov: prov, seed: seed, env: baseEnv(), doc: func(u string) string { return docJSON(u, m) },
		mock: func(t *testing.T) *mock { return newMock(t, certs()) }}
}

func emailLimits(perAddress, perIP int) func(map[string]any) {
	return func(ab map[string]any) {
		eo := ab["email_otp"].(map[string]any)
		eo["send_per_address"], eo["send_per_ip"] = perAddress, perIP
	}
}

func pair(t *testing.T, w world) (py, gs *side) {
	reset()
	return startPy(t, w), startGo(t, w)
}

func finish(t *testing.T, py, gs *side, n int) {
	t.Helper()
	n += compareMocks(t, py, gs)
	if n > 0 {
		t.Fatalf("%d requests differ", n)
	}
}

func setDevice(mode string) func(*side) {
	return func(s *side) { s.mock.mu.Lock(); s.mock.deviceMode = mode; s.mock.mu.Unlock() }
}

// ---- web authorization-code flow (Google, and GitHub's web leg) ----------------------------------------------

func webSteps(prefix, good, stranger string) []step {
	start := func(name, host, q string, want int) step {
		return step{name: name, method: "GET", path: prefix + "/start" + q, host: host, want: want}
	}
	cb := func(name, q, cookie string, want int) step {
		return step{name: name, method: "GET", path: prefix + "/callback" + q, hdr: map[string]string{"Cookie": cookie}, want: want}
	}
	s := []step{
		start("start unknown host", "evil.example.org", "", 400),
		start("start host without redirect", "other.example.org", "", 400),
		start("start host with port", chooserHost+":8443", "", 400),
		start("start upper-case host", "AUTH.EXAMPLE.ORG", "", 302),
		start("start with rd", "", "?rd="+qs2("https://account.example.org/home?a=1&b=2"), 302),
		start("start with foreign rd", "", "?rd="+qs2("https://evil.example.com/"), 302),
		start("start with relative rd", "", "?rd=%2Fapps%2Fx", 302),
		start("start with empty rd", "", "?rd=", 302),
		start("start with double-slash rd", "", "?rd=%2F%2Fevil.example", 302),
		start("start with broken rd", "", "?rd="+qs2("https://[::1/x"), -1),
		start("start page", "", "", 302),
	}
	s[len(s)-1].cap = both(capLoc("state", "state"), capCookie("bind", "_sso_state"))
	s = append(s,
		cb("callback ok", "?state={state}&code="+good, "_sso_state={bind}", 302),
		cb("callback replay", "?state={state}&code="+good, "_sso_state={bind}", 400),
		start("start again", "", "?rd=%2Fafter", 302),
		cb("callback without cookie", "?state={state}&code="+good, "", 400))
	s[len(s)-2].cap = both(capLoc("state", "state"), capCookie("bind", "_sso_state"))
	st := func(name, q, cookie string, want int) {
		s = append(s, start("start for "+name, "", "", 302))
		s[len(s)-1].cap = both(capLoc("state", "state"), capCookie("bind", "_sso_state"))
		s = append(s, cb(name, q, cookie, want))
	}
	st("callback wrong bind", "?state={state}&code="+good, "_sso_state=nope", 400)
	st("callback unknown state", "?state=nope&code="+good, "_sso_state={bind}", 400)
	st("callback no state", "?code="+good, "_sso_state={bind}", 400)
	st("callback provider error", "?state={state}&error=access_denied&code="+good, "_sso_state={bind}", 403)
	st("callback no code", "?state={state}", "_sso_state={bind}", 403)
	st("callback empty code", "?state={state}&code=", "_sso_state={bind}", 403)
	st("callback exchange refused", "?state={state}&code=CODE-bad", "_sso_state={bind}", 502)
	st("callback exchange down", "?state={state}&code=CODE-down", "_sso_state={bind}", 502)
	st("callback exchange html", "?state={state}&code=CODE-html", "_sso_state={bind}", 502)
	st("callback no token", "?state={state}&code=CODE-nothing", "_sso_state={bind}", 502)
	st("callback stranger", "?state={state}&code="+stranger, "_sso_state={bind}", 403)
	st("callback unverified", "?state={state}&code=CODE-unverified", "_sso_state={bind}", 0)
	st("callback two state cookies", "?state={state}&code="+good, "_sso_state=old; _sso_state={bind}", 302)
	st("callback non-ascii bind", "?state={state}&code="+good, "_sso_state=bé", -1)
	s = append(s, start("start to expire", "", "", 302))
	s[len(s)-1].cap = both(capLoc("state", "state"), capCookie("bind", "_sso_state"))
	s = append(s, step{name: "callback after expiry", method: "GET", path: prefix + "/callback?state={state}&code=" + good, hdr: map[string]string{"Cookie": "_sso_state={bind}"}, advance: 601, want: 400})
	s = append(s,
		step{name: "post device on a web provider", method: "POST", path: prefix + "/device", hdr: jsonPost(), body: `{}`, want: 0},
		step{name: "post poll on a web provider", method: "POST", path: prefix + "/poll", hdr: jsonPost(), body: `{"sid":"x"}`, want: 0})
	return s
}

func qs2(v string) string {
	return strings.NewReplacer(":", "%3A", "/", "%2F", "?", "%3F", "&", "%26", "=", "%3D", "[", "%5B").Replace(v)
}

func TestParityGoogle(t *testing.T) {
	w := worldFor(t, "google", "google", func() string { return "{}" })
	py, gs := pair(t, w)
	steps := append(commonSteps("/oauth2/google", true), webSteps("/oauth2/google", "CODE-owner", "CODE-stranger")...)
	steps = append(steps, step{name: "post request on a web provider", method: "POST", path: "/oauth2/google/request", hdr: jsonPost(), body: `{}`, want: 404})
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

// ---- GitHub: device flow, plus the web leg on the same instance ----------------------------------------------

func deviceSteps(prefix string, withSecret bool) []step {
	dev := func(name string, want int, extra ...string) step {
		return step{name: name, method: "POST", path: prefix + "/device", hdr: jsonPost(append([]string{"X-Real-IP", "198.51.100.7"}, extra...)...), body: `{}`, want: want}
	}
	poll := func(name, sid string, want int) step {
		return step{name: name, method: "POST", path: prefix + "/poll", hdr: jsonPost("X-Real-IP", "198.51.100.7"), body: `{"sid":"` + sid + `","rd":"/back"}`, want: want}
	}
	var s []step
	flow := func(tag string) {
		d := dev("device "+tag, 200)
		d.cap = capJSON("sid_"+tag, "sid")
		s = append(s, d)
	}
	// DC-1: pending, then the owner
	flow("1")
	s = append(s, poll("poll too early", "{sid_1}", 200), poll("poll unknown", "nope", 404))
	p := poll("poll pending", "{sid_1}", 200)
	p.advance = 6
	s = append(s, p)
	p = poll("poll owner", "{sid_1}", 200)
	p.advance = 6
	p.cap = capCookie("session", cookieName)
	s = append(s, p, poll("poll after success", "{sid_1}", 404))
	s = append(s, step{name: "auth with the issued cookie", method: "GET", path: prefix + "/auth", hdr: map[string]string{"Cookie": cookieName + "={session}"}, want: 202})
	// DC-2: slow_down then a stranger
	flow("2")
	p = poll("poll slow down", "{sid_2}", 200)
	p.advance = 6
	s = append(s, p)
	p = poll("poll too early after slow down", "{sid_2}", 200)
	p.advance = 6
	s = append(s, p)
	p = poll("poll stranger", "{sid_2}", 200)
	p.advance = 6
	s = append(s, p)
	for _, c := range []struct{ tag, name string }{{"3", "denied"}, {"4", "expired token"}, {"5", "empty answer"}, {"6", "immediate owner"}, {"7", "id as text"}, {"8", "bad id"}, {"9", "no id"}} {
		flow(c.tag)
		p = poll("poll "+c.name, "{sid_"+c.tag+"}", 0)
		p.advance = 6
		s = append(s, p)
	}
	// flow lifetime and provider failures
	flow("10")
	p = poll("poll after the flow expired", "{sid_10}", 200)
	p.advance = 901
	s = append(s, p)
	for _, m := range []string{"fail", "nodc", "html", "nouser", "weird"} {
		d := dev("device provider "+m, 0)
		d.hook = setDevice(m)
		s = append(s, d)
	}
	s = append(s, step{name: "device provider ok again", method: "POST", path: prefix + "/device", hdr: jsonPost("X-Real-IP", "198.51.100.8"), body: `[1]`, hook: setDevice(""), want: 200})
	s = append(s,
		step{name: "poll with a list body", method: "POST", path: prefix + "/poll", hdr: jsonPost(), body: `[1]`, want: -1},
		step{name: "poll with a numeric sid", method: "POST", path: prefix + "/poll", hdr: jsonPost(), body: `{"sid":5}`, want: 404},
		step{name: "poll without body", method: "POST", path: prefix + "/poll", hdr: jsonPost(), want: 404},
		step{name: "device cross-origin", method: "POST", path: prefix + "/device", hdr: jsonPost("Origin", "https://evil.example"), body: `{}`, want: 403})
	// rate limit: ten device codes per client address per window
	for i := 0; i < 11; i++ {
		want := 200
		if i == 10 {
			want = 429
		}
		s = append(s, step{name: fmt.Sprintf("rate limit %d", i), method: "POST", path: prefix + "/device", hdr: jsonPost("X-Real-IP", "203.0.113.9"), body: `{}`, want: want})
	}
	s = append(s, step{name: "rate limit other address", method: "POST", path: prefix + "/device", hdr: jsonPost("X-Real-IP", "203.0.113.10"), body: `{}`, want: 200},
		step{name: "rate limit window passed", method: "POST", path: prefix + "/device", hdr: jsonPost("X-Real-IP", "203.0.113.9"), body: `{}`, advance: 601, want: 200})
	// the session cookie expires with its TTL
	s = append(s, step{name: "auth with the issued cookie, much later", method: "GET", path: prefix + "/auth", hdr: map[string]string{"Cookie": cookieName + "={session}"}, advance: 43200, want: 401})
	_ = withSecret
	return s
}

func TestParityGitHub(t *testing.T) {
	w := worldFor(t, "github", "github", func() string { return "{}" })
	py, gs := pair(t, w)
	steps := commonSteps("/oauth2/github", true)
	steps = append(steps,
		get("start device page", "/oauth2/github/start?flow=device", 200),
		get("start with other flow value", "/oauth2/github/start?flow=web", 302))
	steps = append(steps, deviceSteps("/oauth2/github", false)...)
	steps = append(steps, webSteps("/oauth2/github", "CODE-owner", "CODE-stranger")...)
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

func TestParityGitHubDeviceOnly(t *testing.T) {
	w := worldFor(t, "ghdev", "ghdev", func() string { return "{}" })
	py, gs := pair(t, w)
	steps := commonSteps("/oauth2/ghdev", true)
	steps = append(steps,
		get("start page escapes the label", "/oauth2/ghdev/start", 200),
		get("start page with flow=device", "/oauth2/ghdev/start?flow=device", 200),
		get("callback is not routed", "/oauth2/ghdev/callback?state=x&code=y", 404))
	steps = append(steps, deviceSteps("/oauth2/ghdev", true)...)
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

func TestParityDisabledProvider(t *testing.T) {
	w := worldFor(t, "ghoff", "ghoff", func() string { return "{}" })
	py, gs := pair(t, w)
	steps := commonSteps("/oauth2/ghoff", false)
	steps = append(steps,
		get("start", "/oauth2/ghoff/start", 404),
		post("device", "/oauth2/ghoff/device", `{}`, 404),
		post("poll", "/oauth2/ghoff/poll", `{"sid":"x"}`, 404))
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

// ---- email one-time code ---------------------------------------------------------------------------------------

func TestParityEmail(t *testing.T) {
	w := worldFor(t, "email", "email", func() string { return "{}" }, emailLimits(1000, 1000))
	py, gs := pair(t, w)
	pfx := "/oauth2/email"
	code := func(py *side, vars map[string]string) { vars["code"] = py.mock.lastCode() }
	req := func(name, body string, want int, ip string) step {
		return step{name: name, method: "POST", path: pfx + "/request", hdr: jsonPost("X-Real-IP", ip), body: body, want: want}
	}
	ver := func(name, sid, c string, want int, extra string) step {
		return step{name: name, method: "POST", path: pfx + "/verify", hdr: jsonPost(), body: `{"sid":"` + sid + `","code":"` + c + `"` + extra + `}`, want: want}
	}
	steps := commonSteps(pfx, true)
	steps = append(steps,
		get("start page", pfx+"/start", 200),
		get("callback is not routed", pfx+"/callback", 404),
		post("device is not routed", pfx+"/device", `{}`, 404))
	// listed address: a code is mailed; the answer is the same for everybody
	r := req("request listed", `{"email":"  Owner@Example.ORG "}`, 200, "198.51.100.1")
	r.cap = capJSON("sid", "sid")
	r.after = code
	steps = append(steps, r)
	steps = append(steps,
		ver("verify wrong", "{sid}", "000000", 200, ""),
		ver("verify short", "{sid}", "123", 200, ""),
		ver("verify letters, third failure locks", "{sid}", "12345a", 200, ""),
		ver("verify after lock", "{sid}", "{code}", 200, ""))
	r = req("request again", `{"email":"owner@example.org"}`, 200, "198.51.100.1")
	r.cap = capJSON("sid", "sid")
	r.after = code
	steps = append(steps, r)
	v := ver("verify ok", "{sid}", " {code} ", 200, `,"rd":"https://app.example.org/home"`)
	v.cap = capCookie("session", cookieName)
	steps = append(steps, v,
		ver("verify twice", "{sid}", "{code}", 200, ""),
		step{name: "auth with the issued cookie", method: "GET", path: pfx + "/auth", hdr: map[string]string{"Cookie": cookieName + "={session}"}, want: 202})
	// redirect targets
	for i, rd := range []string{`"/local"`, `"//evil.example"`, `"https://evil.example/"`, `"http://app.example.org/"`, `"https://example.org/x"`, `"https://example.org.evil.com/"`,
		`"https://a.b.example.org:8443/x?y=1"`, `"/a\\b"`, `""`, `null`, `0`, `"javascript:alert(1)"`, `"https://user@evil.example/"`, `"https://EXAMPLE.org/up"`} {
		r = req(fmt.Sprintf("request for rd %d", i), `{"email":"owner@example.org"}`, 200, fmt.Sprintf("192.0.2.%d", i+1))
		r.cap = capJSON("sid", "sid")
		r.after = code
		vv := ver(fmt.Sprintf("verify rd %s", rd), "{sid}", "{code}", 200, `,"rd":`+rd)
		steps = append(steps, r, vv)
	}
	for i, rd := range []string{`5`, `["x"]`, `"https://[::1/x"`} { // Python raises after the code was spent: the connection drops
		r = req(fmt.Sprintf("request for odd rd %d", i), `{"email":"owner@example.org"}`, 200, fmt.Sprintf("192.0.2.%d", i+40))
		r.cap = capJSON("sid", "sid")
		r.after = code
		steps = append(steps, r, ver("verify odd rd "+rd, "{sid}", "{code}", -1, `,"rd":`+rd))
	}
	// everybody else gets the same answer and no mail
	for i, e := range []string{`"stranger@example.org"`, `""`, `null`, `5`, `["owner@example.org"]`, `"` + strings.Repeat("a", 300) + `@example.org"`, `"OWNER@example.org\n"`} {
		steps = append(steps, req(fmt.Sprintf("request other %d", i), `{"email":`+e+`}`, 200, fmt.Sprintf("198.51.100.%d", 20+i)))
	}
	steps = append(steps,
		req("request no body", ``, 200, "198.51.100.40"),
		step{name: "request list body", method: "POST", path: pfx + "/request", hdr: jsonPost(), body: `[1]`, want: -1},
		step{name: "verify list body", method: "POST", path: pfx + "/verify", hdr: jsonPost(), body: `[1]`, want: -1},
		ver("verify unknown sid", "nope", "123456", 200, ""),
		step{name: "verify numeric sid", method: "POST", path: pfx + "/verify", hdr: jsonPost(), body: `{"sid":5,"code":123456}`, want: 200})
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

func TestParityEmailLimits(t *testing.T) {
	w := worldFor(t, "email", "limits", func() string { return "{}" }, emailLimits(3, 10))
	py, gs := pair(t, w)
	pfx := "/oauth2/email"
	code := func(py *side, vars map[string]string) { vars["code"] = py.mock.lastCode() }
	req := func(name, body string, want int, ip string) step {
		return step{name: name, method: "POST", path: pfx + "/request", hdr: jsonPost("X-Real-IP", ip), body: body, want: want}
	}
	ver := func(name string, want int) step {
		return step{name: name, method: "POST", path: pfx + "/verify", hdr: jsonPost(), body: `{"sid":"{sid}","code":"{code}"}`, want: want}
	}
	var steps []step
	// per-address limit: three mails, then silence with identical answers; a throttled sid never verifies
	for i := 0; i < 5; i++ {
		r := req(fmt.Sprintf("address limit %d", i), `{"email":"owner@example.org"}`, 200, fmt.Sprintf("198.51.100.%d", 60+i))
		r.cap = capJSON("sid", "sid")
		r.after = code
		steps = append(steps, r, ver(fmt.Sprintf("verify after address limit %d", i), 200))
	}
	// the window passes: mail flows again
	r := req("address limit window passed", `{"email":"owner@example.org"}`, 200, "198.51.100.70")
	r.advance = 601
	r.cap = capJSON("sid", "sid")
	r.after = code
	steps = append(steps, r, ver("verify after the window", 200))
	// per-ip limit
	for i := 0; i < 11; i++ {
		want := 200
		if i == 10 {
			want = 429
		}
		steps = append(steps, req(fmt.Sprintf("ip limit %d", i), `{"email":"x@example.org"}`, want, "203.0.113.50"))
	}
	// code expiry
	r = req("request to expire", `{"email":"owner@example.org"}`, 200, "198.51.100.80")
	r.cap = capJSON("sid", "sid")
	r.after = code
	ex := ver("verify after the ttl", 200)
	ex.advance = 601
	steps = append(steps, r, ex)
	// the mail API failing does not change the answer
	r = req("request with the mail API down", `{"email":"owner@example.org"}`, 200, "198.51.100.90")
	r.advance = 601
	r.hook = func(s *side) { s.mock.mu.Lock(); s.mock.resendStatus = 500; s.mock.mu.Unlock() }
	steps = append(steps, r)
	finish(t, py, gs, run(t, py, gs, steps, map[string]string{}))
}

// ---- Cloudflare Access ---------------------------------------------------------------------------------------

func TestParityCloudflare(t *testing.T) {
	k1, k2, k3 := genKey(t, "k1"), genKey(t, "k2"), genKey(t, "k3")
	exp, past := t0+3600, t0-10
	claims := func(m map[string]string) string {
		c := map[string]string{"iss": `"https://team.cloudflareaccess.example"`, "aud": `["aud-tag-1"]`, "email": `"owner@example.org"`, "exp": fmt.Sprint(exp)}
		for k, v := range m {
			if v == "-" {
				delete(c, k)
			} else {
				c[k] = v
			}
		}
		var parts []string
		for k, v := range c {
			parts = append(parts, fmt.Sprintf("%q:%s", k, v))
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	rs := `{"alg":"RS256","kid":"k1","typ":"JWT"}`
	good := jwt(k1, rs, claims(nil), "")
	vars := map[string]string{
		"jwt_good":      good,
		"jwt_k2":        jwt(k2, `{"alg":"RS256","kid":"k2"}`, claims(map[string]string{"aud": `"aud-tag-2"`}), ""),
		"jwt_expired":   jwt(k1, rs, claims(map[string]string{"exp": fmt.Sprint(past)}), ""),
		"jwt_nbf30":     jwt(k1, rs, claims(map[string]string{"nbf": fmt.Sprint(t0 + 30)}), ""),
		"jwt_nbf120":    jwt(k1, rs, claims(map[string]string{"nbf": fmt.Sprint(t0 + 120)}), ""),
		"jwt_iss":       jwt(k1, rs, claims(map[string]string{"iss": `"https://evil.example"`}), ""),
		"jwt_aud":       jwt(k1, rs, claims(map[string]string{"aud": `["other"]`}), ""),
		"jwt_noaud":     jwt(k1, rs, claims(map[string]string{"aud": "-"}), ""),
		"jwt_audnull":   jwt(k1, rs, claims(map[string]string{"aud": "null"}), ""),
		"jwt_audnum":    jwt(k1, rs, claims(map[string]string{"aud": "5"}), ""),
		"jwt_audnested": jwt(k1, rs, claims(map[string]string{"aud": `[["aud-tag-1"]]`}), ""),
		"jwt_audboth":   jwt(k1, rs, claims(map[string]string{"aud": `["x","aud-tag-2"]`}), ""),
		"jwt_noemail":   jwt(k1, rs, claims(map[string]string{"email": "-"}), ""),
		"jwt_stranger":  jwt(k1, rs, claims(map[string]string{"email": `"stranger@example.org"`}), ""),
		"jwt_spaced":    jwt(k1, rs, claims(map[string]string{"email": `"  OWNER@Example.Org "`}), ""),
		"jwt_numemail":  jwt(k1, rs, claims(map[string]string{"email": "5"}), ""),
		"jwt_expstr":    jwt(k1, rs, claims(map[string]string{"exp": fmt.Sprintf("%q", fmt.Sprint(exp))}), ""),
		"jwt_expbad":    jwt(k1, rs, claims(map[string]string{"exp": `"soon"`}), ""),
		"jwt_noexp":     jwt(k1, rs, claims(map[string]string{"exp": "-"}), ""),
		"jwt_nbfstr":    jwt(k1, rs, claims(map[string]string{"nbf": `"0"`}), ""),
		"jwt_nbfnull":   jwt(k1, rs, claims(map[string]string{"nbf": "null"}), ""),
		"jwt_hs256":     jwt(k1, `{"alg":"HS256","kid":"k1"}`, claims(nil), "c2ln"),
		"jwt_none":      jwt(k1, `{"alg":"none","kid":"k1"}`, claims(nil), "c2ln"),
		"jwt_nokid":     jwt(k1, `{"alg":"RS256"}`, claims(nil), ""),
		"jwt_kidnum":    jwt(k1, `{"alg":"RS256","kid":5}`, claims(nil), ""),
		"jwt_kidlist":   jwt(k1, `{"alg":"RS256","kid":["k1"]}`, claims(nil), ""),
		"jwt_unknown":   jwt(k1, `{"alg":"RS256","kid":"unknown"}`, claims(nil), ""),
		"jwt_k3":        jwt(k3, `{"alg":"RS256","kid":"k3"}`, claims(nil), ""),
		"jwt_wrongkey":  jwt(k2, rs, claims(nil), ""),
		"jwt_shortsig":  jwt(k1, rs, claims(nil), "c2lnbmF0dXJl"),
		"jwt_badb64":    jwt(k1, rs, claims(nil), "!!!!"),
		"jwt_hdrlist":   jwt(k1, `["RS256"]`, claims(nil), "c2ln"),
		"jwt_payload":   jwt(k1, rs, `[1]`, ""),
		"jwt_notjson":   jwt(k1, rs, `nope`, ""),
		"jwt_long":      good + strings.Repeat("A", 8200),
	}
	parts := strings.Split(good, ".")
	vars["jwt_tamper"] = parts[0] + "." + b64u([]byte(claims(map[string]string{"email": `"owner@example.org","admin":true`}))) + "." + parts[2]
	vars["jwt_two"] = parts[0] + "." + parts[1]
	vars["jwt_four"] = good + ".x"
	w := worldFor(t, "cloudflare", "cloudflare", func() string { return certsDoc(k1, k2) })
	py, gs := pair(t, w)
	pfx := "/oauth2/cloudflare"
	cf := func(name, tok string, want int) step {
		return step{name: name, method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{" + tok + "}"}, want: want}
	}
	steps := commonSteps(pfx, true)
	steps = append(steps,
		cf("cf-auth good", "jwt_good", 202), cf("cf-auth second key, string aud", "jwt_k2", 202), cf("cf-auth expired", "jwt_expired", 401),
		cf("cf-auth nbf in the grace", "jwt_nbf30", 202), cf("cf-auth nbf too far", "jwt_nbf120", 401), cf("cf-auth foreign issuer", "jwt_iss", 401),
		cf("cf-auth foreign audience", "jwt_aud", 401), cf("cf-auth no audience", "jwt_noaud", 401), cf("cf-auth null audience", "jwt_audnull", 401),
		cf("cf-auth numeric audience", "jwt_audnum", 401), cf("cf-auth nested audience", "jwt_audnested", 401), cf("cf-auth one audience of two", "jwt_audboth", 202),
		cf("cf-auth no email (service token)", "jwt_noemail", 401), cf("cf-auth stranger", "jwt_stranger", 401), cf("cf-auth spaced upper-case email", "jwt_spaced", 202),
		cf("cf-auth numeric email", "jwt_numemail", 401), cf("cf-auth exp as text", "jwt_expstr", 202), cf("cf-auth exp unparsable", "jwt_expbad", 401),
		cf("cf-auth no exp", "jwt_noexp", 401), cf("cf-auth nbf as text", "jwt_nbfstr", 202), cf("cf-auth nbf null", "jwt_nbfnull", 401),
		cf("cf-auth HS256", "jwt_hs256", 401), cf("cf-auth alg none", "jwt_none", 401), cf("cf-auth no kid", "jwt_nokid", 401),
		cf("cf-auth numeric kid", "jwt_kidnum", 401), cf("cf-auth list kid", "jwt_kidlist", 401), cf("cf-auth wrong key", "jwt_wrongkey", 401),
		cf("cf-auth short signature", "jwt_shortsig", 401), cf("cf-auth bad base64", "jwt_badb64", 401), cf("cf-auth header is a list", "jwt_hdrlist", 401),
		cf("cf-auth payload is a list", "jwt_payload", 401), cf("cf-auth payload is not json", "jwt_notjson", 401), cf("cf-auth tampered payload", "jwt_tamper", 401),
		cf("cf-auth two parts", "jwt_two", 401), cf("cf-auth four parts", "jwt_four", 401), cf("cf-auth too long", "jwt_long", 401))
	// key discovery: an unknown kid refetches the certs at most once a minute; the cache lives an hour
	steps = append(steps,
		cf("unknown kid: refetch is rate limited", "jwt_unknown", 401),
		step{name: "unknown kid a minute later refetches", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_unknown}"}, advance: 61, want: 401},
		cf("unknown kid straight after", "jwt_unknown", 401),
		step{name: "new key not published yet", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_k3}"}, advance: 61, want: 401},
		step{name: "rotated key is found", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_k3}"}, advance: 61, want: 202,
			hook: func(s *side) { s.mock.mu.Lock(); s.mock.certs = certsDoc(k1, k2, k3); s.mock.mu.Unlock() }},
		step{name: "certs endpoint down keeps the keys", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_good}"}, advance: 4000, want: 202,
			hook: func(s *side) { s.mock.mu.Lock(); s.mock.certsStatus = 500; s.mock.mu.Unlock() }},
		step{name: "empty key set keeps the keys", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_good}"}, advance: 4000, want: 202,
			hook: func(s *side) {
				s.mock.mu.Lock()
				s.mock.certsStatus = 200
				s.mock.certs = `{"keys":[]}`
				s.mock.mu.Unlock()
			}},
		step{name: "certs not json aborts the verification", method: "GET", path: pfx + "/cf-auth", hdr: map[string]string{"Cf-Access-Jwt-Assertion": "{jwt_good}"}, advance: 4000, want: 401,
			hook: func(s *side) { s.mock.mu.Lock(); s.mock.certs = `<html>`; s.mock.mu.Unlock() }})
	// Cloudflare One as a sign-in provider
	start := func(name, host, q string, want int) step {
		return step{name: name, method: "GET", path: pfx + "/start" + q, host: host, want: want}
	}
	cb := func(name, q, tok string, want int) step {
		h := map[string]string{}
		if tok != "" {
			h["Cf-Access-Jwt-Assertion"] = "{" + tok + "}"
		}
		return step{name: name, method: "GET", path: pfx + "/callback" + q, hdr: h, want: want}
	}
	steps = append(steps,
		start("start", "", "", 302), start("start with rd", "", "?rd="+qs2("https://account.example.org/x"), 302),
		start("start relative rd", "account.example.org:8443", "?rd=%2Fhome", 302), start("start foreign rd", "", "?rd="+qs2("https://evil.example/"), 302),
		start("start unknown host", "evil.example", "", 404), start("start broken rd", "", "?rd="+qs2("https://[::1/x"), -1),
		cb("callback good", "?rd="+qs2("https://account.example.org/x"), "jwt_good", 302), cb("callback relative rd", "?rd=%2Fhome", "jwt_good", 302),
		cb("callback no rd", "", "jwt_good", 302), cb("callback foreign rd", "?rd="+qs2("https://evil.example/"), "jwt_good", 302),
		cb("callback no jwt", "", "", 401), cb("callback stranger", "", "jwt_stranger", 401), cb("callback expired", "", "jwt_expired", 401))
	finish(t, py, gs, run(t, py, gs, steps, vars))
}

// ---- startup refusals ----------------------------------------------------------------------------------------

func TestParityConfigRefusals(t *testing.T) {
	bin := requirePython(t)
	type variant struct {
		name, prov string
		mut        func(ab map[string]any)
		env        func(map[string]string)
	}
	setP := func(id string, f func(p map[string]any)) func(ab map[string]any) {
		return func(ab map[string]any) {
			for _, p := range ab["providers"].([]any) {
				if pm := p.(map[string]any); pm["id"] == id {
					f(pm)
				}
			}
		}
	}
	vs := []variant{
		{"ok", "google", nil, nil},
		{"ok disabled without client id", "ghoff", nil, nil},
		{"empty email allowlist", "google", func(ab map[string]any) { ab["allowed_emails"] = []string{} }, nil},
		{"empty github allowlist", "github", func(ab map[string]any) { ab["allowed_github"] = []any{} }, nil},
		{"github needs no email list", "github", func(ab map[string]any) { ab["allowed_emails"] = []string{} }, nil},
		{"short cookie secret", "google", nil, func(e map[string]string) { e["AUTH_BROKER_COOKIE_SECRET"] = "short" }},
		{"no cookie secret", "google", nil, func(e map[string]string) { delete(e, "AUTH_BROKER_COOKIE_SECRET") }},
		{"no client id", "google", nil, func(e map[string]string) { delete(e, "AB_GOOGLE_CLIENT_ID") }},
		{"cloudflare access without team", "google", func(ab map[string]any) { ab["cloudflare_access"].(map[string]any)["team_domain"] = "" }, nil},
		{"cloudflare access without aud", "google", func(ab map[string]any) { ab["cloudflare_access"].(map[string]any)["aud"] = []string{} }, nil},
		{"cloudflare access off, access provider on", "cloudflare", func(ab map[string]any) { ab["cloudflare_access"].(map[string]any)["enabled"] = false }, nil},
		{"access provider without hosts", "cloudflare", setP("cloudflare", func(p map[string]any) { delete(p, "hosts") }), nil},
		{"email provider without otp block", "email", func(ab map[string]any) { delete(ab, "email_otp") }, nil},
		{"unknown provider", "nobody", nil, nil},
		{"web leg without secret stays off", "github", nil, func(e map[string]string) { delete(e, "AB_GHAPP_CLIENT_SECRET") }},
		{"bad ttl", "google", func(ab map[string]any) { ab["cookie_expire_seconds"] = "soon" }, nil},
	}
	for _, v := range vs {
		t.Run(v.name, func(t *testing.T) {
			reset()
			dir := t.TempDir()
			env := baseEnv()
			if v.env != nil {
				v.env(env)
			}
			doc := docJSON("http://127.0.0.1:1", v.mut)
			conf := filepath.Join(dir, "build.json")
			writeFile(t, conf, doc)
			cmd := pyCmd(bin, "check", env, conf, v.prov)
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("ref.py check: %v", err)
			}
			want := strings.TrimSpace(string(out))
			parsed, perr := parseDoc(doc)
			if perr != nil {
				t.Fatal(perr)
			}
			_, gerr := newBroker(parsed, v.prov, env)
			switch {
			case want == "OK":
				if gerr != nil {
					t.Errorf("Python accepts the config, Go refuses: %v", gerr)
				}
			case strings.HasPrefix(want, "EXIT:"):
				if gerr == nil || gerr.Error() != strings.TrimPrefix(want, "EXIT:") {
					t.Errorf("Python exits with %q, Go says %v", want, gerr)
				}
			default:
				if gerr == nil {
					t.Errorf("Python raises (%s), Go accepts the config", want)
				}
			}
		})
	}
}
