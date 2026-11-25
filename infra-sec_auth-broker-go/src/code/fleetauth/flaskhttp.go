package fleetauth

import (
	"context"
	"crypto/subtle"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"
)

// A minimal Flask/Werkzeug look-alike for the Go ports of the Flask auth-plane services: the same routing
// rules (static parts before converters, HEAD/OPTIONS added to GET rules, 404/405/500 error pages, no
// trailing-slash tolerance), the same jsonify bytes and the same request.get_json / request.form semantics.

// Reply is one HTTP answer. Headers keeps order and repeats (Set-Cookie).
type Reply struct {
	Status  int
	Headers [][2]string
	Body    []byte
}

// Add appends a header and returns the reply.
func (r *Reply) Add(k, v string) *Reply {
	r.Headers = append(r.Headers, [2]string{k, v})
	return r
}

// JSONReply is flask.jsonify(v) with a status.
func JSONReply(status int, v any) *Reply {
	return &Reply{Status: status, Headers: [][2]string{{"Content-Type", "application/json"}}, Body: FlaskJSON(v)}
}

// HTMLReply is flask.Response(body, status) with the default text/html mimetype.
func HTMLReply(status int, body string) *Reply {
	return &Reply{Status: status, Headers: [][2]string{{"Content-Type", "text/html; charset=utf-8"}}, Body: []byte(body)}
}

// ContentReply is flask.Response(body, mimetype=ctype).
func ContentReply(status int, body, ctype string) *Reply {
	return &Reply{Status: status, Headers: [][2]string{{"Content-Type", ctype}}, Body: []byte(body)}
}

func httpErrorPage(code int, name, desc string) *Reply {
	body := "<!doctype html>\n<html lang=en>\n<title>" + itoa(code) + " " + name + "</title>\n<h1>" + name + "</h1>\n<p>" + desc + "</p>\n"
	return HTMLReply(code, body)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// NotFoundPage, MethodNotAllowedPage and InternalErrorPage are werkzeug's default error pages.
func NotFoundPage() *Reply {
	return httpErrorPage(404, "Not Found", "The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.")
}

func MethodNotAllowedPage(allow string) *Reply {
	return httpErrorPage(405, "Method Not Allowed", "The method is not allowed for the requested URL.").Add("Allow", allow)
}

func InternalErrorPage() *Reply {
	return httpErrorPage(500, "Internal Server Error", "The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.")
}

// Handler serves one route. args holds the URL converters (<name>, <path:name>).
type Handler func(r *http.Request, args map[string]string) *Reply

type rule struct {
	segs    []string // "<name>" and "<path:name>" are converters
	methods map[string]bool
	h       Handler
}

// Mux is Flask's url map.
type Mux struct {
	rules []*rule
	// After is Flask's after_request, applied to every answer including the error pages.
	After func(*Reply)
	// OnPanic is told about an exception that Flask would turn into a 500.
	OnPanic func(any)
}

// Handle registers a rule for methods (a GET rule also answers HEAD, every rule answers OPTIONS).
func (m *Mux) Handle(pattern string, h Handler, methods ...string) {
	ru := &rule{segs: strings.Split(strings.TrimPrefix(pattern, "/"), "/"), methods: map[string]bool{}, h: h}
	for _, me := range methods {
		ru.methods[me] = true
		if me == "GET" {
			ru.methods["HEAD"] = true
		}
	}
	m.rules = append(m.rules, ru)
	weight := func(r *rule) []int {
		w := make([]int, len(r.segs))
		for i, s := range r.segs {
			switch {
			case strings.HasPrefix(s, "<path:"):
				w[i] = 2
			case strings.HasPrefix(s, "<"):
				w[i] = 1
			}
		}
		return w
	}
	sort.SliceStable(m.rules, func(i, j int) bool {
		a, b := weight(m.rules[i]), weight(m.rules[j])
		for n := 0; n < len(a) && n < len(b); n++ {
			if a[n] != b[n] {
				return a[n] < b[n]
			}
		}
		return false
	})
}

func (ru *rule) match(path string) (map[string]string, bool) {
	if !strings.HasPrefix(path, "/") {
		return nil, false
	}
	parts := strings.Split(path[1:], "/")
	args := map[string]string{}
	for i, s := range ru.segs {
		if strings.HasPrefix(s, "<path:") {
			rest := strings.Join(parts[min(i, len(parts)):], "/")
			// werkzeug's path converter is [^/].*?: a newline is only allowed as the first character
			if i >= len(parts) || rest == "" || parts[i] == "" || strings.Contains(rest[1:], "\n") {
				return nil, false
			}
			args[strings.TrimSuffix(s[len("<path:"):], ">")] = rest
			return args, true
		}
		if i >= len(parts) {
			return nil, false
		}
		if strings.HasPrefix(s, "<") {
			if parts[i] == "" {
				return nil, false
			}
			args[strings.TrimSuffix(s[1:], ">")] = parts[i]
			continue
		}
		if s != parts[i] {
			return nil, false
		}
	}
	return args, len(parts) == len(ru.segs)
}

// Dispatch resolves and runs the request.
func (m *Mux) Dispatch(r *http.Request) (rep *Reply) {
	defer func() {
		if e := recover(); e != nil {
			if m.OnPanic != nil {
				m.OnPanic(e)
			}
			rep = InternalErrorPage()
		}
		if m.After != nil {
			m.After(rep)
		}
	}()
	path := r.URL.Path
	if path == "" {
		path = "/"
	}
	allowed := map[string]bool{}
	for _, ru := range m.rules {
		args, ok := ru.match(path)
		if !ok {
			continue
		}
		if ru.methods[r.Method] {
			return ru.h(r, args)
		}
		for k := range ru.methods {
			allowed[k] = true
		}
	}
	if len(allowed) == 0 {
		return NotFoundPage()
	}
	allowed["OPTIONS"] = true
	names := make([]string, 0, len(allowed))
	for k := range allowed {
		names = append(names, k)
	}
	sort.Strings(names)
	allow := strings.Join(names, ", ")
	if r.Method == "OPTIONS" {
		return HTMLReply(200, "").Add("Allow", allow)
	}
	return MethodNotAllowedPage(allow)
}

// ServeHTTP writes the dispatched reply.
func (m *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rep := m.Dispatch(r)
	h := w.Header()
	for _, kv := range rep.Headers {
		h.Add(kv[0], kv[1])
	}
	h.Set("Content-Length", itoa(len(rep.Body)))
	w.WriteHeader(rep.Status)
	if r.Method != "HEAD" {
		_, _ = w.Write(rep.Body)
	}
}

// Hdr is request.headers.get(name, ""): the first value, decoded latin-1 like gunicorn/werkzeug do.
func Hdr(r *http.Request, name string) string {
	if name == "Host" {
		return Latin1ToStr(r.Host)
	}
	return Latin1ToStr(r.Header.Get(name))
}

// RemoteIP is request.remote_addr.
func RemoteIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func mimetype(r *http.Request) string {
	ct := r.Header.Get("Content-Type")
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.ToLower(strings.TrimSpace(ct))
}

func readBody(r *http.Request) []byte {
	if r.Body == nil {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	return b
}

// JSONBody is `request.get_json(silent=True) or {}`. A body that is not JSON, or not declared as JSON, is
// an empty object. ok=false is a truthy value that is not an object: the Python handler then raises
// AttributeError on .get and Flask answers 500.
func JSONBody(r *http.Request) (obj *Object, ok bool) {
	empty := &Object{M: map[string]Value{}}
	mt := mimetype(r)
	if mt != "application/json" && !(strings.HasPrefix(mt, "application/") && strings.HasSuffix(mt, "+json")) {
		return empty, true
	}
	v, err := ParseJSON(readBody(r))
	if err != nil || !v.Truthy() {
		return empty, true
	}
	if v.K != Obj {
		return nil, false
	}
	return v.O, true
}

// JSONValue is request.get_json(silent=True): the parsed body, or a null Value when the body is not declared as
// JSON or does not parse.
func JSONValue(r *http.Request) Value {
	mt := mimetype(r)
	if mt != "application/json" && !(strings.HasPrefix(mt, "application/") && strings.HasSuffix(mt, "+json")) {
		return Value{}
	}
	v, err := ParseJSON(readBody(r))
	if err != nil {
		return Value{}
	}
	return v
}

// Form is request.form (urlencoded bodies only) as an ordered multi-dict.
type Form struct{ pairs [][2]string }

// Get is MultiDict.get(k, def): the first value.
func (f Form) Get(k, def string) string {
	for _, p := range f.pairs {
		if p[0] == k {
			return p[1]
		}
	}
	return def
}

// Has reports whether k is present.
func (f Form) Has(k string) bool {
	for _, p := range f.pairs {
		if p[0] == k {
			return true
		}
	}
	return false
}

// ParseQueryString is werkzeug's url decoding: split on &, blank values kept, %XX and + decoded, bad
// escapes left as they are, invalid UTF-8 replaced.
func ParseQueryString(s string) Form {
	var f Form
	for _, part := range strings.Split(s, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		f.pairs = append(f.pairs, [2]string{unquotePlus(k), unquotePlus(v)})
	}
	return f
}

func unquotePlus(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			b = append(b, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return strings.ToValidUTF8(string(b), "�")
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c >= 'a':
		return c - 'a' + 10
	case c >= 'A':
		return c - 'A' + 10
	}
	return c - '0'
}

// ParseQS is urllib.parse.parse_qs(s): values are lists in order, empty values and fields without = are dropped.
func ParseQS(s string) (keys []string, vals map[string][]string) {
	vals = map[string][]string{}
	for _, part := range strings.Split(s, "&") {
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok || v == "" {
			continue
		}
		k, v = unquotePlus(k), unquotePlus(v)
		if _, seen := vals[k]; !seen {
			keys = append(keys, k)
		}
		vals[k] = append(vals[k], v)
	}
	return keys, vals
}

// QueryForm is request.args.
func QueryForm(r *http.Request) Form { return ParseQueryString(r.URL.RawQuery) }

// PostForm is request.form: urlencoded and multipart bodies (text fields only; file parts are not form fields).
func PostForm(r *http.Request) Form {
	switch mimetype(r) {
	case "application/x-www-form-urlencoded":
		return ParseQueryString(string(readBody(r)))
	case "multipart/form-data":
		_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || params["boundary"] == "" {
			return Form{}
		}
		mr := multipart.NewReader(strings.NewReader(string(readBody(r))), params["boundary"])
		var f Form
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			if p.FileName() != "" {
				continue
			}
			b, _ := io.ReadAll(p)
			f.pairs = append(f.pairs, [2]string{p.FormName(), strings.ToValidUTF8(string(b), "\uFFFD")})
		}
		return f
	}
	return Form{}
}

// B64StdDecode is base64.b64decode(s) with validate=False: binascii.a2b_base64 in non-strict mode over the
// standard alphabet (bytes outside it are skipped; a dangling quantum is "Incorrect padding").
func B64StdDecode(in []byte) ([]byte, error) {
	out := make([]byte, 0, len(in)*3/4)
	var quadPos, pads int
	var left byte
	for _, c := range in {
		if c == '=' {
			if quadPos >= 2 {
				pads++
				if quadPos+pads >= 4 {
					return out, nil
				}
			}
			continue
		}
		v := b64Table[c]
		if v >= 64 {
			continue
		}
		pads = 0
		switch quadPos {
		case 0:
			quadPos, left = 1, v
		case 1:
			quadPos = 2
			out = append(out, left<<2|v>>4)
			left = v & 0x0f
		case 2:
			quadPos = 3
			out = append(out, left<<4|v>>2)
			left = v & 0x03
		case 3:
			quadPos = 0
			out = append(out, left<<6|v)
			left = 0
		}
	}
	if quadPos != 0 {
		return nil, ErrB64
	}
	return out, nil
}

// URLEncode is urllib.parse.urlencode on ordered pairs (quote_plus, safe="").
func URLEncode(pairs ...[2]string) string {
	var sb strings.Builder
	for i, p := range pairs {
		if i > 0 {
			sb.WriteByte('&')
		}
		quotePlus(&sb, p[0])
		sb.WriteByte('=')
		quotePlus(&sb, p[1])
	}
	return sb.String()
}

func quotePlus(sb *strings.Builder, s string) {
	const hex = "0123456789ABCDEF"
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '.', c == '-', c == '~':
			sb.WriteByte(c)
		case c == ' ':
			sb.WriteByte('+')
		default:
			sb.WriteByte('%')
			sb.WriteByte(hex[c>>4])
			sb.WriteByte(hex[c&15])
		}
	}
}

// CompareDigest is hmac.compare_digest on two str: Python refuses non-ASCII text with a TypeError (a 500 in Flask).
func CompareDigest(a, b string) bool {
	for _, s := range []string{a, b} {
		for _, r := range CodePoints(s) {
			if r > 0x7f {
				panic("TypeError: comparing strings with non-ASCII characters is not supported")
			}
		}
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Healthcheck probes u and returns the process exit code (the distroless images have no curl).
func Healthcheck(u string) int {
	cl := &http.Client{Timeout: 25 * time.Second}
	r, err := cl.Get(u)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		fmt.Fprintln(os.Stderr, "status", r.StatusCode)
		return 1
	}
	return 0
}

// Serve runs h on addr until SIGTERM/SIGINT.
func Serve(addr string, h http.Handler) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(sctx)
	}
}
