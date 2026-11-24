package cmeapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"cloudme-api/internal/authz"
	"cloudme-api/internal/ojson"
)

// Config is everything the process reads from its environment.
type Config struct {
	Runtime     *Runtime
	JWKSURL     string
	Issuer      string
	VerifyURL   string
	DataDir     string
	KeyDir      string
	URLOverride string // tester only: local bare repos instead of GitHub
	Env         func(string) string
	AllowNoKeys bool // shadow stage: the vault entry for this service name does not exist yet
}

type handler func(w http.ResponseWriter, r *http.Request, c *reqCtx)

type reqCtx struct {
	params map[string]string
	query  url.Values
}

// Server is the HTTP handler.
type Server struct {
	cfg     Config
	rt      *Runtime
	table   []route
	store   *Store
	bearer  *authz.BearerVerifier
	session *authz.SessionVerifier
}

func New(cfg Config) (*Server, error) {
	rt := cfg.Runtime
	st, err := NewStore(StoreOpts{
		RT: rt, DataDir: cfg.DataDir, KeyDir: cfg.KeyDir, Env: cfg.Env,
		URLFor: func(r repoDecl) string {
			if cfg.URLOverride != "" {
				return cfg.URLOverride + "/" + r.Name
			}
			return r.SSH
		},
	})
	if err != nil {
		return nil, err
	}
	// Keys are checked at startup: a service that could sync nothing refuses to come up so the deploy-liveness gate catches it.
	if cfg.URLOverride == "" && !cfg.AllowNoKeys {
		var missing []string
		for _, r := range rt.Repos.List {
			if !st.HasKey(r.Name) {
				missing = append(missing, r.KeyEnv)
			}
		}
		if len(missing) > 0 {
			return nil, fmt.Errorf("FATAL: deploy key env not set: %s (expected from the sops-decrypted env_file)", strings.Join(missing, ", "))
		}
	}
	s := &Server{cfg: cfg, rt: rt, store: st}
	s.bearer = &authz.BearerVerifier{
		JWKSURL: cfg.JWKSURL, Issuer: cfg.Issuer,
		CacheTTL:     time.Duration(rt.Authelia.JWKSCacheTTLS) * time.Second,
		FetchTimeout: time.Duration(rt.Authelia.JWKSFetchTimeoutMS) * time.Millisecond,
	}
	s.session = &authz.SessionVerifier{
		VerifyURL: cfg.VerifyURL, PublicURL: rt.Authelia.Session.PublicURL, BasePath: rt.BasePath,
		Timeout: time.Duration(rt.Authelia.Session.TimeoutMS) * time.Millisecond,
	}
	handlers := map[string]handler{
		"/me/health":           s.health,
		"/me/endpoints":        s.endpoints,
		"/me/repos":            s.repos,
		"/me/config/:name":     s.config,
		"/me/autocomplete":     s.autocomplete,
		"/me/repos/:repo/file": s.file,
	}
	t, err := buildTable(rt, handlers)
	if err != nil {
		return nil, err
	}
	s.table = t
	return s, nil
}

func (s *Server) Routes() int   { return len(s.table) }
func (s *Server) Store() *Store { return s.store }

// StartSync runs one sync round now and then every sync_interval_s.
func (s *Server) StartSync(ctx context.Context) {
	tick := func() { s.store.SyncAll() }
	go func() {
		tick()
		t := time.NewTicker(time.Duration(s.rt.Repos.SyncIntervalS * float64(time.Second)))
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				tick()
			}
		}
	}()
}

// ---- CORS: echo ONLY a declared origin (exact, or https://<label>.<origin_suffix>); never a wildcard ----

var originHost = regexp.MustCompile(`^https://([a-z0-9-]+(?:\.[a-z0-9-]+)*)$`)

func (s *Server) corsOrigin(origin string) string {
	if origin == "" {
		return ""
	}
	for _, o := range s.rt.Cors.Origins {
		if o == origin {
			return origin
		}
	}
	if s.rt.Cors.OriginSuffix != nil && *s.rt.Cors.OriginSuffix != "" {
		sfx := *s.rt.Cors.OriginSuffix
		if m := originHost.FindStringSubmatch(origin); m != nil && strings.HasSuffix(m[1], sfx) && len(m[1]) > len(sfx) {
			return origin
		}
	}
	return ""
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	if o := s.corsOrigin(r.Header.Get("Origin")); o != "" {
		w.Header().Set("Access-Control-Allow-Origin", o)
	}
	w.Header().Set("Vary", "Origin")
}

// ---- responses: one writer for every JSON body, so redaction cannot be forgotten ----

func (s *Server) sendJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	body := RedactSecrets(string(ojson.Marshal(v)), s.store.Secret)
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", fmt.Sprint(len(body)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if r != nil {
		s.cors(w, r)
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func (s *Server) sendError(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	s.sendJSON(w, r, status, ojson.NewObj().Set("error", msg).Set("code", code))
}

// fromError: a gate refusal carries {status, code}; anything else is ours (500, rethrown to the pipeline).
func (s *Server) fromError(w http.ResponseWriter, r *http.Request, err error) {
	var ge *gateErr
	if errors.As(err, &ge) {
		if ge.Code == "bad_path" {
			s.sendError(w, r, 400, "bad_path", ge.Msg)
			return
		}
		s.sendError(w, r, ge.Status, ge.Code, ge.Msg)
		return
	}
	s.sendError(w, r, 500, "internal_error", err.Error())
}

// ---- handlers ----

func (s *Server) health(w http.ResponseWriter, r *http.Request, _ *reqCtx) {
	s.sendJSON(w, r, 200, ojson.NewObj().Set("status", "ok").Set("service", "cloud-me-api"))
}

// endpoints: the declared contract minus the transport fields (ssh URL, key env names) and the filter regexes.
func (s *Server) endpoints(w http.ResponseWriter, r *http.Request, _ *reqCtx) {
	out := s.rt.tree.Clone()
	reposAny, _ := out.Get("repos")
	repos := reposAny.(*ojson.Obj).Clone()
	var list []any
	for _, e := range s.rt.Repos.List {
		list = append(list, ojson.NewObj().Set("name", e.Name).Set("branch", e.Branch))
	}
	repos.Set("list", list)
	repos.Delete("known_hosts")
	out.Set("repos", repos)
	ext := make([]any, 0, len(s.rt.Files.AllowedExt))
	for _, e := range s.rt.Files.AllowedExt {
		ext = append(ext, e)
	}
	out.Set("files", ojson.NewObj().Set("allowed_ext", ext).Set("max_bytes", ojson.Num(s.rt.Files.MaxBytes)))
	s.sendJSON(w, r, 200, out)
}

func (s *Server) repos(w http.ResponseWriter, r *http.Request, _ *reqCtx) {
	list := []any{}
	for _, x := range s.store.Repos() {
		o := ojson.NewObj().Set("name", x.Name).Set("branch", x.Branch)
		if x.State.Commit != nil {
			o.Set("commit", *x.State.Commit)
		} else {
			o.Set("commit", nil)
		}
		if x.State.SyncedAt != nil {
			o.Set("synced_at", *x.State.SyncedAt)
		} else {
			o.Set("synced_at", nil)
		}
		o.Set("ok", x.State.OK)
		list = append(list, o)
	}
	s.sendJSON(w, r, 200, ojson.NewObj().Set("repos", list))
}

func (s *Server) config(w http.ResponseWriter, r *http.Request, c *reqCtx) {
	name := c.params["name"]
	raw, found := s.rt.Datasets[name]
	var probe map[string]any
	isObj := found && jsonIsObject(raw) && (func() bool { return jsonUnmarshal(raw, &probe) == nil })()
	if strings.HasPrefix(name, "_") || !found || !isObj {
		s.sendError(w, r, 404, "not_found", "no such dataset")
		return
	}
	var ds dataset
	_ = jsonUnmarshal(raw, &ds)
	if ds.Builtin != nil {
		b, err := dataFS.ReadFile(*ds.Builtin)
		if err != nil {
			s.fromError(w, r, err)
			return
		}
		v, err := ojson.Parse([]byte(ojson.ReplaceInvalidUTF8(b)))
		if err != nil {
			s.fromError(w, r, err)
			return
		}
		w.Header().Set("X-Source-Commit", "builtin")
		s.sendJSON(w, r, 200, v)
		return
	}
	p := ds.Path
	text, commit, err := s.store.Read(ds.Repo, &p, false)
	if err != nil {
		s.fromError(w, r, err)
		return
	}
	v, perr := ojson.Parse([]byte(text))
	if perr != nil {
		s.sendError(w, r, 502, "bad_dataset", "dataset is not valid JSON")
		return
	}
	w.Header().Set("X-Source-Commit", commit[:min(12, len(commit))])
	s.sendJSON(w, r, 200, v)
}

// autocomplete (#1103): the owner's Autocomplete rows. Personal data: no-store, never cached by an intermediary.
func (s *Server) autocomplete(w http.ResponseWriter, r *http.Request, _ *reqCtx) {
	ac := s.rt.Autocomplete
	p := ac.Path
	text, commit, err := s.store.Read(ac.Repo, &p, true)
	if err != nil {
		var ge *gateErr
		// nothing entered yet is a state, not an error: the same document, empty
		if errors.As(err, &ge) && ge.Code == "not_found" {
			s.sendJSON(w, r, 200, EmptyAutocomplete())
			return
		}
		s.fromError(w, r, err)
		return
	}
	doc := NormalizeAutocomplete(text)
	if doc == nil {
		s.sendError(w, r, 502, "bad_dataset", "the autocomplete file is not a JSON object")
		return
	}
	w.Header().Set("X-Source-Commit", commit[:min(12, len(commit))])
	s.sendJSON(w, r, 200, doc)
}

func (s *Server) file(w http.ResponseWriter, r *http.Request, c *reqCtx) {
	var p *string
	if q, ok := c.query["path"]; ok {
		p = &q[0]
	}
	text, commit, err := s.store.Read(c.params["repo"], p, false)
	if err != nil {
		s.fromError(w, r, err)
		return
	}
	body := RedactSecrets(text, s.store.Secret)
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Length", fmt.Sprint(len(body)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Source-Commit", commit[:min(12, len(commit))])
	s.cors(w, r)
	w.WriteHeader(200)
	_, _ = io.WriteString(w, body)
}

var trailingSlashes = regexp.MustCompile(`(.)/+$`)

// ServeHTTP is the request pipeline: preflight, match, auth, handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Caddy's /me/* handle strips the base path; the mesh site and the private tier pass it through. Both reach the same local routes.
	path := trailingSlashes.ReplaceAllString(pathname(r), "$1")
	if strings.HasPrefix(path, s.rt.BasePath+"/") {
		path = path[len(s.rt.BasePath):]
	}

	// Preflight carries no credential by design: answered before auth, only for a declared origin, headers only.
	if r.Method == http.MethodOptions {
		o := s.corsOrigin(r.Header.Get("Origin"))
		if o == "" {
			s.sendError(w, r, 403, "origin_not_allowed", "origin is not declared")
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", o)
		h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		h.Set("Vary", "Origin")
		w.WriteHeader(204)
		return
	}

	route, params, allowed, err := match(s.table, r.Method, path)
	if err != nil {
		s.sendError(w, r, 500, "internal_error", err.Error())
		return
	}
	if route == nil && allowed == nil {
		s.sendError(w, r, 404, "no_such_route", "No route for "+r.Method+" "+path)
		return
	}
	if route == nil {
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		s.sendError(w, r, 405, "method_not_allowed", path+" accepts "+strings.Join(allowed, ", "))
		return
	}
	if route.Auth != "none" {
		// A presented bearer is authoritative; only a request with no Authorization header at all is judged on its session.
		authH := strings.Join(r.Header.Values("Authorization"), ", ")
		cookie := strings.Join(r.Header.Values("Cookie"), "; ")
		var d authz.Decision
		if authH != "" || cookie == "" {
			d = authz.DecideAuth(authH, s.bearer.Verify, s.rt.Authelia.RequiredScope)
		} else {
			d = authz.DecideSession(cookie, func(c string) (string, error) {
				return s.session.Verify(c, r.Method, path)
			}, s.rt.Authelia.Session.Users)
		}
		if !d.OK {
			s.sendJSON(w, r, d.Status, ojson.NewObj().Set("error", d.Error).Set("code", d.Code))
			return
		}
	}
	route.handler(w, r, &reqCtx{params: params, query: r.URL.Query()})
}

// ---- config ----

func RuntimeBlock() (*Runtime, error) { return LoadRuntime(runtimeJSON) }

// runtimeFor returns the embedded runtime, or the `runtime` block of the build.json at BUILD_JSON_PATH (tester only,
// like the Node service's BUILD_JSON_PATH; nothing in production sets it).
func runtimeFor(getenv func(string) string) (*Runtime, error) {
	p := getenv("BUILD_JSON_PATH")
	if p == "" {
		return RuntimeBlock()
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Runtime json.RawMessage `json:"runtime"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	return LoadRuntime(doc.Runtime)
}

func ConfigFromEnv(getenv func(string) string) (Config, error) {
	rt, err := runtimeFor(getenv)
	if err != nil {
		return Config{}, err
	}
	or := func(k, d string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return d
	}
	return Config{
		Runtime:     rt,
		JWKSURL:     or("JWKS_URL", rt.Authelia.JWKSURL),
		Issuer:      or("ISSUER", rt.Authelia.Issuer),
		VerifyURL:   or("AUTHELIA_VERIFY_URL", rt.Authelia.Session.VerifyURL),
		DataDir:     or("CME_DATA_DIR", "/data"),
		KeyDir:      or("CME_KEY_DIR", "/run/keys"),
		URLOverride: getenv("CME_URL_OVERRIDE_DIR"),
		Env:         getenv,
		// Shadow stage: the vault entry for this service name does not exist yet (the key mapping is part of the switch-over).
		AllowNoKeys: getenv("ALLOW_NO_KEYS") == "1",
	}, nil
}

func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }

func jsonIsObject(raw []byte) bool {
	for _, c := range raw {
		if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
			continue
		}
		return c == '{'
	}
	return false
}
