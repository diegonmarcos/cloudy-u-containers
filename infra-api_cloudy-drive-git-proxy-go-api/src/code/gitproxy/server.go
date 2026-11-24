package gitproxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"gitproxy-api/internal/authz"
)

// Config is everything the process reads from its environment (build.json is the declaration; the env vars
// override only so a tester can point the outbound dependencies at local stubs, same as the Node service).
type Config struct {
	Runtime      *Runtime
	JWKSURL      string
	Issuer       string
	VerifyURL    string
	APIBase      string
	GitBase      string
	MeshCIDRs    []string
	UpstreamTO   time.Duration
	GitHubToken  string
	AllowNoToken bool // shadow stage: the vault entry for this service name does not exist yet
	HTTPClient   *http.Client
}

type handler func(w http.ResponseWriter, r *http.Request, c *reqCtx)

type reqCtx struct {
	params map[string]string
	query  url.Values
}

// Server is the HTTP handler.
type Server struct {
	cfg      Config
	rt       *Runtime
	table    []route
	bearer   *authz.BearerVerifier
	session  *authz.SessionVerifier
	secrets  []string
	client   *http.Client // follows redirects (fetch's default)
	feedMu   sync.Mutex
	feeds    map[string]*feedEntry
	relMu    sync.Mutex
	releases map[string]*relEntry
}

type feedEntry struct {
	at       time.Time
	ready    chan struct{}
	items    []any
	cachedAt string
	err      error
}

type assetMeta struct {
	ID string
}

type relEntry struct {
	at     time.Time
	ready  chan struct{}
	assets map[string]assetMeta
	err    error
}

// upstreamError carries the GitHub status that made a call fail (JS: err.upstreamStatus).
type upstreamError struct {
	status int
	msg    string
}

func (e *upstreamError) Error() string { return e.msg }

var errTimeout = errors.New("upstream_timeout")

// New builds the server; it fails exactly when the Node service would refuse to start.
func New(cfg Config) (*Server, error) {
	if cfg.GitHubToken == "" && !cfg.AllowNoToken {
		return nil, errors.New("FATAL: GITHUB_TOKEN is not set (expected from the sops-decrypted env_file)")
	}
	rt := cfg.Runtime
	s := &Server{cfg: cfg, rt: rt, feeds: map[string]*feedEntry{}, releases: map[string]*relEntry{}}
	s.client = cfg.HTTPClient
	if s.client == nil {
		s.client = &http.Client{}
	}
	s.bearer = &authz.BearerVerifier{
		JWKSURL: cfg.JWKSURL, Issuer: cfg.Issuer,
		CacheTTL:     time.Duration(rt.Authelia.JWKSCacheTTLS) * time.Second,
		FetchTimeout: time.Duration(rt.Authelia.JWKSFetchTimeoutMS) * time.Millisecond,
	}
	s.session = &authz.SessionVerifier{
		VerifyURL: cfg.VerifyURL, PublicURL: rt.Authelia.Session.PublicURL, BasePath: rt.BasePath,
		Timeout: time.Duration(rt.Authelia.Session.TimeoutMS) * time.Millisecond,
	}
	if cfg.GitHubToken != "" {
		s.secrets = []string{cfg.GitHubToken, base64Std("x-access-token:" + cfg.GitHubToken)}
	}
	handlers := map[string]handler{
		"/git/health": func(w http.ResponseWriter, _ *http.Request, _ *reqCtx) {
			s.sendJSON(w, 200, struct {
				Status  string `json:"status"`
				Service string `json:"service"`
			}{"ok", "git-proxy-api"})
		},
		"/git/endpoints": func(w http.ResponseWriter, _ *http.Request, _ *reqCtx) {
			s.sendJSON(w, 200, struct {
				BasePath  string          `json:"base_path"`
				Endpoints json.RawMessage `json:"endpoints"`
			}{rt.BasePath, rt.RawEndpoints})
		},
		"/git/repos":                        s.listRepos,
		"/git/repos/:owner/:repo/tarball":   s.tarball,
		"/git/clone/:owner/:repo/info/refs": s.cloneRefs,
		"/git/clone/:owner/:repo/git-upload-pack": func(w http.ResponseWriter, r *http.Request, c *reqCtx) {
			s.proxyGit(w, r, c.params, "git-upload-pack")
		},
		"/git/repos/:owner/:repo/commits":              s.feedHandler("commits"),
		"/git/repos/:owner/:repo/runs":                 s.feedHandler("runs"),
		"/git/releases/:owner/:repo/:tag/assets/:name": s.releaseAsset,
	}
	t, err := buildTable(rt, handlers)
	if err != nil {
		return nil, err
	}
	s.table = t
	return s, nil
}

// Routes is the number of served routes (startup log).
func (s *Server) Routes() int { return len(s.table) }

func base64Std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// ---- responses: one writer for every JSON body, so redaction cannot be forgotten on a path added later ----

func (s *Server) sendJSON(w http.ResponseWriter, status int, obj any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(obj)
	body := RedactSecrets(strings.TrimSuffix(buf.String(), "\n"), s.secrets)
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", fmt.Sprint(len(body)))
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func (s *Server) sendError(w http.ResponseWriter, status int, code, msg string) {
	s.sendJSON(w, status, errBody{msg, code})
}

// ---- upstream ----

// ghFetch: JSON calls carry the whole-call deadline, like AbortSignal.timeout in the Node service.
func (s *Server) ghFetch(ctx context.Context, u, accept string) (*http.Response, context.CancelFunc, error) {
	if s.cfg.GitHubToken == "" {
		return nil, func() {}, &upstreamError{status: 503, msg: "no GITHUB_TOKEN configured (shadow stage)"}
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.UpstreamTO)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	req.Header = UpstreamHeaders(s.cfg.GitHubToken)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := s.client.Do(req)
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	return res, cancel, nil
}

func isTimeout(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errTimeout)
}

func notFoundOr502(st int) (int, string) {
	if st == 404 {
		return 404, "not_found"
	}
	return 502, "upstream_error"
}

func (s *Server) listRepos(w http.ResponseWriter, r *http.Request, _ *reqCtx) {
	out := []repoOut{}
	for page := 1; page <= 10; page++ {
		res, cancel, err := s.ghFetch(r.Context(), ReposURL(s.cfg.APIBase, page), "")
		if err != nil {
			s.fail(w, err)
			return
		}
		body, rerr := io.ReadAll(res.Body)
		res.Body.Close()
		cancel()
		if res.StatusCode < 200 || res.StatusCode > 299 {
			s.sendError(w, 502, "upstream_error", fmt.Sprintf("GitHub returned %d listing repositories", res.StatusCode))
			return
		}
		if rerr != nil {
			s.fail(w, rerr)
			return
		}
		var batch []raw
		if err := json.Unmarshal(body, &batch); err != nil {
			s.sendError(w, 502, "upstream_error", "GitHub returned a non-list for repositories")
			return
		}
		for _, b := range batch {
			out = append(out, ProjectRepo(b))
		}
		if len(batch) < 100 {
			break
		}
	}
	s.sendJSON(w, 200, struct {
		Repos []repoOut `json:"repos"`
		Count int       `json:"count"`
	}{out, len(out)})
}

func (s *Server) tarball(w http.ResponseWriter, r *http.Request, c *reqCtx) {
	owner, repo := c.params["owner"], c.params["repo"]
	ref := c.query.Get("ref")
	if !ValidName(owner) || !ValidName(repo) {
		s.sendError(w, 400, "bad_repo", "owner and repo must be valid GitHub names")
		return
	}
	if !ValidRef(ref) {
		s.sendError(w, 400, "bad_ref", "ref is not a valid git ref")
		return
	}
	// The deadline covers GitHub's HEADERS only; a tarball may stream for minutes.
	res, cancel, err := s.ghStream(r.Context(), TarballURL(s.cfg.APIBase, owner, repo, ref), "application/vnd.github+json")
	if err != nil {
		s.fail(w, err)
		return
	}
	defer cancel()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		st, code := notFoundOr502(res.StatusCode)
		s.sendError(w, st, code, fmt.Sprintf("GitHub returned %d for the tarball", res.StatusCode))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/gzip")
	h.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.tar.gz"`, repo))
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = io.Copy(w, res.Body) // straight through; nothing is staged on disk
}

// ghStream is ghFetch with a deadline on the response HEADERS only; the body streams unbounded.
func (s *Server) ghStream(ctx context.Context, u, accept string) (*http.Response, context.CancelFunc, error) {
	if s.cfg.GitHubToken == "" {
		return nil, func() {}, &upstreamError{status: 503, msg: "no GITHUB_TOKEN configured (shadow stage)"}
	}
	ctx, cancel := context.WithCancel(ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	req.Header = UpstreamHeaders(s.cfg.GitHubToken)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	return s.doHeadersDeadline(ctx, cancel, req)
}

func (s *Server) doHeadersDeadline(ctx context.Context, cancel context.CancelFunc, req *http.Request) (*http.Response, context.CancelFunc, error) {
	timer := time.AfterFunc(s.cfg.UpstreamTO, func() { cancel() })
	res, err := s.client.Do(req)
	stopped := timer.Stop()
	if err != nil {
		cancel()
		if !stopped {
			return nil, func() {}, errTimeout
		}
		return nil, func() {}, err
	}
	if !stopped {
		res.Body.Close()
		cancel()
		return nil, func() {}, errTimeout
	}
	return res, cancel, nil
}

func (s *Server) cloneRefs(w http.ResponseWriter, r *http.Request, c *reqCtx) {
	if c.query.Get("service") != "git-upload-pack" {
		s.sendError(w, 403, "service_not_allowed", "only git-upload-pack (clone/fetch) is proxied")
		return
	}
	s.proxyGit(w, r, c.params, "info/refs?service=git-upload-pack")
}

var dotGit = regexp.MustCompile(`\.git$`)

func (s *Server) proxyGit(w http.ResponseWriter, r *http.Request, params map[string]string, suffix string) {
	owner := params["owner"]
	name := dotGit.ReplaceAllString(params["repo"], "")
	if !ValidName(owner) || !ValidName(name) {
		s.sendError(w, 400, "bad_repo", "owner and repo must be valid GitHub names")
		return
	}
	if s.cfg.GitHubToken == "" {
		s.fail(w, &upstreamError{status: 503, msg: "no GITHUB_TOKEN configured (shadow stage)"})
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var body io.Reader
	if r.Method == http.MethodPost {
		body = r.Body
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, GitURL(s.cfg.GitBase, owner, name, suffix), body)
	if err != nil {
		s.fail(w, err)
		return
	}
	req.Header = GitUpstreamHeaders(s.cfg.GitHubToken, r.Header)
	res, cancel2, err := s.doHeadersDeadline(ctx, cancel, req)
	if err != nil {
		s.fail(w, err)
		return
	}
	defer cancel2()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		st, code := notFoundOr502(res.StatusCode)
		s.sendError(w, st, code, fmt.Sprintf("GitHub returned %d for %s/%s", res.StatusCode, owner, name))
		return
	}
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

// ---- feeds (commits / runs of a declared repo): in-flight promise cache ----

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func (s *Server) cachedFeed(ctx context.Context, owner, repo, kind string) (*feedEntry, error) {
	key := strings.ToLower(owner+"/"+repo) + ":" + kind
	ttl := time.Duration(s.rt.Feeds.CacheTTLS * float64(time.Second))
	s.feedMu.Lock()
	if e, ok := s.feeds[key]; ok && time.Since(e.at) < ttl {
		s.feedMu.Unlock()
		<-e.ready
		return e, e.err
	}
	e := &feedEntry{at: time.Now(), ready: make(chan struct{})}
	s.feeds[key] = e
	s.feedMu.Unlock()

	// Detached from the first caller's context: concurrent misses share this ONE upstream call.
	go func() {
		defer close(e.ready)
		e.items, e.err = s.fetchFeed(context.Background(), owner, repo, kind)
		e.cachedAt = isoNow()
		if e.err != nil { // failures are evicted, never cached: the next caller retries
			s.feedMu.Lock()
			if s.feeds[key] == e {
				delete(s.feeds, key)
			}
			s.feedMu.Unlock()
		}
	}()
	<-e.ready
	return e, e.err
}

func (s *Server) fetchFeed(ctx context.Context, owner, repo, kind string) ([]any, error) {
	res, cancel, err := s.ghFetch(ctx, FeedURL(s.cfg.APIBase, owner, repo, kind, int(s.rt.Feeds.MaxPerPage)), "")
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &upstreamError{status: res.StatusCode, msg: fmt.Sprintf("GitHub returned %d for %s", res.StatusCode, kind)}
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var list []raw
	if kind == "commits" {
		if json.Unmarshal(body, &list) != nil {
			return nil, fmt.Errorf("GitHub returned a non-list for %s", kind)
		}
	} else {
		var doc struct {
			Runs []raw `json:"workflow_runs"`
		}
		if json.Unmarshal(body, &doc) != nil || doc.Runs == nil {
			return nil, fmt.Errorf("GitHub returned a non-list for %s", kind)
		}
		list = doc.Runs
	}
	items := make([]any, 0, len(list))
	for _, it := range list {
		if kind == "commits" {
			items = append(items, ProjectCommit(it))
		} else {
			items = append(items, ProjectRun(it))
		}
	}
	return items, nil
}

func (s *Server) feedHandler(kind string) handler {
	return func(w http.ResponseWriter, r *http.Request, c *reqCtx) {
		owner, repo := c.params["owner"], c.params["repo"]
		if !ValidName(owner) || !ValidName(repo) {
			s.sendError(w, 400, "bad_repo", "owner and repo must be valid GitHub names")
			return
		}
		// Checked BEFORE anything is dialled: an undeclared repo costs no quota.
		if !RepoDeclared(s.rt.Feeds.Repos, owner, repo) {
			s.sendError(w, 403, "repo_not_declared", fmt.Sprintf("%s/%s is not in runtime.feeds.repos", owner, repo))
			return
		}
		e, err := s.cachedFeed(r.Context(), owner, repo, kind)
		if err != nil {
			var ue *upstreamError
			if !errors.As(err, &ue) || ue.status == 503 && s.cfg.GitHubToken == "" {
				s.fail(w, err)
				return
			}
			st, code := notFoundOr502(ue.status)
			s.sendError(w, st, code, ue.msg)
			return
		}
		n := ClampPerPage(c.query.Get("per_page"), int(s.rt.Feeds.MaxPerPage))
		items := e.items
		if n < len(items) {
			items = items[:n]
		}
		repoName := owner + "/" + repo
		if kind == "commits" {
			s.sendJSON(w, 200, struct {
				Repo     string `json:"repo"`
				Commits  []any  `json:"commits"`
				CachedAt string `json:"cached_at"`
			}{repoName, items, e.cachedAt})
		} else {
			s.sendJSON(w, 200, struct {
				Repo     string `json:"repo"`
				Runs     []any  `json:"runs"`
				CachedAt string `json:"cached_at"`
			}{repoName, items, e.cachedAt})
		}
	}
}

// RuntimeBlock returns the embedded, validated runtime declaration.
func RuntimeBlock() (*Runtime, error) { return LoadRuntime(runtimeJSON) }

// ConfigFromEnv applies the same env overrides as the Node service's index.mjs.
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	rt, err := RuntimeBlock()
	if err != nil {
		return Config{}, err
	}
	or := func(k, d string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return d
	}
	cfg := Config{
		Runtime:     rt,
		JWKSURL:     or("JWKS_URL", rt.Authelia.JWKSURL),
		Issuer:      or("ISSUER", rt.Authelia.Issuer),
		VerifyURL:   or("AUTHELIA_VERIFY_URL", rt.Authelia.Session.VerifyURL),
		APIBase:     or("GITHUB_API_BASE", rt.Upstream.APIBase),
		GitBase:     or("GITHUB_GIT_BASE", rt.Upstream.GitBase),
		GitHubToken: getenv("GITHUB_TOKEN"),
		// Shadow stage: this service name has no vault entry yet (the secret mapping is part of the switch-over),
		// so the container may start without a credential; upstream routes then answer 502 upstream_error.
		AllowNoToken: getenv("ALLOW_NO_TOKEN") == "1",
	}
	meshDefault := ""
	if rt.Mesh != nil {
		meshDefault = strings.Join(rt.Mesh.Cidrs, " ")
	}
	cfg.MeshCIDRs = strings.FieldsFunc(or("MESH_CIDRS", meshDefault), func(r rune) bool { return r == ' ' || r == ',' || r == '\t' || r == '\n' })
	to := rt.Upstream.TimeoutMS
	if v := getenv("UPSTREAM_TIMEOUT_MS"); v != "" {
		if n, ok := jsParseInt(v); ok && n > 0 {
			to = n
		}
	}
	cfg.UpstreamTO = time.Duration(to) * time.Millisecond
	return cfg, nil
}
