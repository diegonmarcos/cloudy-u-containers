package broker

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	"auth-broker/fleetauth"
)

const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"

type hdr = [2]string

// send is BaseHTTPRequestHandler.send of the original. body is a []byte/string or a JSON object.
func (b *Broker) send(w http.ResponseWriter, code int, body any, ctype string, extra ...hdr) {
	var raw []byte
	switch x := body.(type) {
	case *fleetauth.Object:
		raw = []byte(fleetauth.DumpJSON(fleetauth.ObjV(x)))
	case string:
		raw = []byte(x)
	case []byte:
		raw = x
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Length", strconv.Itoa(len(raw)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	for _, kv := range extra {
		h.Add(kv[0], kv[1])
	}
	w.WriteHeader(code)
	_, _ = w.Write(raw)
}

func (b *Broker) json(w http.ResponseWriter, code int, o *fleetauth.Object, extra ...hdr) {
	b.send(w, code, o, "application/json", extra...)
}

func (b *Broker) text(w http.ResponseWriter, code int, extra ...hdr) {
	b.send(w, code, []byte{}, "text/plain", extra...)
}

func (b *Broker) html(w http.ResponseWriter, code int, body string, extra ...hdr) {
	b.send(w, code, body, "text/html; charset=utf-8", extra...)
}

func ip(r *http.Request) string {
	if v := fleetauth.Latin1ToStr(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

// Handler is the http.Handler. Whatever would be an uncaught exception in the original (the connection is dropped
// without an answer) aborts the connection here.
func (b *Broker) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if e := recover(); e != nil {
				if e != http.ErrAbortHandler {
					b.out(fmt.Sprintf("Exception in request handler: %v", e))
				}
				panic(http.ErrAbortHandler)
			}
		}()
		switch r.Method {
		case http.MethodGet:
			b.doGet(w, r)
		case http.MethodPost:
			b.doPost(w, r)
		default:
			b.unsupported(w, r)
		}
	})
}

// unsupported is http.server's send_error(501, "Unsupported method (%r)").
func (b *Broker) unsupported(w http.ResponseWriter, r *http.Request) {
	body := "<!DOCTYPE HTML>\n<html lang=\"en\">\n    <head>\n        <meta charset=\"utf-8\">\n        <title>Error response</title>\n    </head>\n    <body>\n" +
		"        <h1>Error response</h1>\n        <p>Error code: 501</p>\n        <p>Message: Unsupported method (" + pyReprStr(r.Method) + ").</p>\n" +
		"        <p>Error code explanation: 501 - Server does not support this operation.</p>\n    </body>\n</html>\n"
	h := w.Header()
	h.Set("Connection", "close")
	h.Set("Content-Type", "text/html;charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(501)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, body)
	}
}

func pyReprStr(s string) string { return fleetauth.PyRepr(fleetauth.S(s)) }

func notFound(b *Broker, w http.ResponseWriter) { b.json(w, 404, obj("error", "not_found")) }

func (b *Broker) doGet(w http.ResponseWriter, r *http.Request) {
	u, err := fleetauth.PyURLSplit(r.RequestURI)
	if err != nil {
		abort()
	}
	if !strings.HasPrefix(u.Path, b.prefix+"/") {
		notFound(b, w)
		return
	}
	op := u.Path[len(b.prefix):]
	if op == "/health" {
		b.json(w, 200, obj("enabled", b.enabled, "provider", b.id))
		return
	}
	if op == "/auth" {
		if e, ok := b.sessionEmail(fleetauth.Latin1ToStr(r.Header.Get("Cookie"))); ok {
			b.text(w, 202, hdr{"X-Auth-Request-Email", e})
		} else {
			b.text(w, 401)
		}
		return
	}
	if op == "/cf-auth" {
		if e := b.cfEmail(fleetauth.Latin1ToStr(r.Header.Get("Cf-Access-Jwt-Assertion"))); e != "" {
			b.text(w, 202, hdr{"X-Auth-Request-Email", e})
		} else {
			b.text(w, 401)
		}
		return
	}
	_, qs := fleetauth.ParseQS(u.Query)
	first := func(k string) fleetauth.Value {
		if v := qs[k]; len(v) > 0 {
			return fleetauth.S(v[0])
		}
		return fleetauth.S("")
	}
	host := fleetauth.Hdr(r, "Host")
	if b.flow == "access" && (op == "/start" || op == "/callback") {
		rd := first("rd")
		if op == "/start" {
			if loc := b.accessStart(host, rd); loc != "" {
				b.text(w, 302, hdr{"Location", loc})
			} else {
				b.html(w, 404, "<p>Sign-in is not available.</p>")
			}
			return
		}
		loc, cookie, ok := b.accessCallback(fleetauth.Latin1ToStr(r.Header.Get("Cf-Access-Jwt-Assertion")), rd)
		if !ok {
			b.html(w, 401, "<p>Cloudflare One sign-in was not verified.</p>")
			return
		}
		b.text(w, 302, hdr{"Location", loc}, hdr{"Set-Cookie", cookie})
		return
	}
	deviceForced := op == "/start" && first("flow").S == "device" && b.flow == "device"
	if b.webOn && (op == "/start" || op == "/callback") && !deviceForced {
		if op == "/start" {
			code, loc, ck := b.webStart(host, first("rd"))
			if code != 302 {
				b.html(w, code, "<p>Sign-in is not available.</p>")
				return
			}
			b.text(w, 302, hdr{"Location", loc}, hdr{"Set-Cookie", ck})
			return
		}
		code, out, cks := b.webCallback(u.Query, fleetauth.Latin1ToStr(r.Header.Get("Cookie")))
		var extra []hdr
		for _, c := range cks {
			extra = append(extra, hdr{"Set-Cookie", c})
		}
		if code == 302 {
			b.text(w, 302, append([]hdr{{"Location", out}}, extra...)...)
			return
		}
		b.html(w, code, "<p>"+pyEscape(out)+"</p><p><a href=\""+b.prefix+"/start\">Try again</a></p>", extra...)
		return
	}
	if op == "/start" && b.flow == "email" {
		if !b.emailOn {
			b.html(w, 404, "<p>This sign-in method is not enabled.</p>")
			return
		}
		b.html(w, 200, strings.ReplaceAll(emailPage, "__PREFIX__", b.prefix), hdr{"Content-Security-Policy", csp})
		return
	}
	if op == "/start" {
		if !b.enabled {
			b.html(w, 404, "<p>This sign-in method is not enabled.</p>")
			return
		}
		page := strings.ReplaceAll(strings.ReplaceAll(devicePage, "__LABEL__", b.p.str("label", b.id)), "__PREFIX__", b.prefix)
		b.html(w, 200, page, hdr{"Content-Security-Policy", csp})
		return
	}
	notFound(b, w)
}

// pyEscape is html.escape(s) with the default quote=True: & < > " '.
func pyEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;").Replace(s)
}

func (b *Broker) sameOrigin(r *http.Request) bool {
	// State-changing calls come only from our own sign-in page: custom header + no foreign Origin.
	if fleetauth.Hdr(r, "X-Requested-With") != "sso" {
		return false
	}
	o := fleetauth.Hdr(r, "Origin")
	if o == "" {
		return true
	}
	u, err := fleetauth.PyURLSplit(o)
	if err != nil {
		abort()
	}
	host := fleetauth.Hdr(r, "Host")
	return host != "" && u.Netloc == host
}

func (b *Broker) doPost(w http.ResponseWriter, r *http.Request) {
	u, err := fleetauth.PyURLSplit(r.RequestURI)
	if err != nil {
		abort()
	}
	if !strings.HasPrefix(u.Path, b.prefix+"/") || !b.sameOrigin(r) {
		b.json(w, 403, obj("error", "forbidden"))
		return
	}
	op := u.Path[len(b.prefix):]
	body, ok := b.readJSON(r)
	if !ok {
		b.json(w, 400, obj("error", "bad_request"))
		return
	}
	// body.get(...) on something that is not a JSON object is an AttributeError in the original
	bget := func(k string) fleetauth.Value {
		if body.K != fleetauth.Obj {
			abort()
		}
		return getOr(body, k, fleetauth.S(""))
	}
	if b.flow == "email" {
		switch op {
		case "/request":
			code, d := b.otpRequest(bget("email"), ip(r))
			b.json(w, code, d)
		case "/verify":
			code, d, cookie := b.otpVerify(bget("sid"), bget("code"))
			b.finish(w, code, d, cookie, bget)
		default:
			notFound(b, w)
		}
		return
	}
	if b.flow == "web" || b.flow == "access" {
		notFound(b, w)
		return
	}
	switch op {
	case "/device":
		code, d := b.newDevice(ip(r))
		b.json(w, code, d)
	case "/poll":
		if !b.enabled {
			b.json(w, 404, obj("status", "disabled"))
			return
		}
		sid := fleetauth.PyStr(bget("sid"))
		code, d, cookie := b.poll(sid)
		b.finish(w, code, d, cookie, bget)
	default:
		notFound(b, w)
	}
}

// finish adds the safe redirect target and the cookie to a successful sign-in answer.
func (b *Broker) finish(w http.ResponseWriter, code int, d *fleetauth.Object, cookie string, bget func(string) fleetauth.Value) {
	if cookie == "" {
		b.json(w, code, d)
		return
	}
	rd := b.safeRD(bget("rd"))
	d.Keys = append(d.Keys, "rd")
	d.M["rd"] = fleetauth.S(rd)
	b.json(w, code, d, hdr{"Set-Cookie", cookie})
}

// readJSON is `json.loads(self.rfile.read(min(int(Content-Length or 0), 4096)) or b"{}")`.
func (b *Broker) readJSON(r *http.Request) (fleetauth.Value, bool) {
	cl := fleetauth.Latin1ToStr(r.Header.Get("Content-Length"))
	n := int64(0)
	if cl != "" {
		i, e := fleetauth.PyInt(fleetauth.S(cl))
		if e != fleetauth.IntOK || !i.IsInt64() {
			return fleetauth.Value{}, false
		}
		n = i.Int64()
	}
	if n > 4096 {
		n = 4096
	}
	var raw []byte
	if n > 0 {
		raw, _ = io.ReadAll(io.LimitReader(r.Body, n))
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	v, err := fleetauth.ParseJSON(raw)
	if err != nil {
		return fleetauth.Value{}, false
	}
	return v, true
}
