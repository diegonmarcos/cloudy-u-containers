package cmeapi

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"encoding/base64"

	"cloudme-api/internal/ojson"
)

// Redacted replaces any secret found in an outbound body.
const Redacted = "[REDACTED]"

// RedactSecrets replaces every known secret (>= 8 chars, longest first) in a string.
func RedactSecrets(out string, secrets []string) string {
	var list []string
	for _, s := range secrets {
		if len(s) >= 8 {
			list = append(list, s)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	for _, s := range list {
		out = strings.ReplaceAll(out, s, Redacted)
	}
	return out
}

// gateErr is a refusal that carries an HTTP status and a code; bad_path has Status 0 (the handler maps it to 400).
type gateErr struct {
	Status int
	Code   string
	Msg    string
}

func (e *gateErr) Error() string { return e.Msg }

func fail(status int, code, msg string) *gateErr { return &gateErr{status, code, msg} }

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}

// posixNormalize mirrors path.posix.normalize for a relative path (a leading "/" is refused before this runs).
func posixNormalize(p string) string {
	trailing := strings.HasSuffix(p, "/")
	var parts []string
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
		case "..":
			if len(parts) > 0 && parts[len(parts)-1] != ".." {
				parts = parts[:len(parts)-1]
			} else {
				parts = append(parts, "..")
			}
		default:
			parts = append(parts, seg)
		}
	}
	out := strings.Join(parts, "/")
	if out == "" {
		out = "."
	}
	if trailing {
		out += "/"
	}
	return out
}

func badPath(msg string) error { return &gateErr{Status: 0, Code: "bad_path", Msg: msg} }

// CleanPath validates a caller-supplied repo-relative path: no absolute path, traversal, NUL or backslash.
func CleanPath(p *string) (string, error) {
	if p == nil || *p == "" || utf16Len(*p) > 300 {
		return "", badPath("path is required (max 300 chars)")
	}
	s := *p
	if strings.ContainsRune(s, 0) || strings.Contains(s, `\`) {
		return "", badPath("path contains forbidden characters")
	}
	if strings.HasPrefix(s, "/") {
		return "", badPath("path must be relative")
	}
	n := posixNormalize(s)
	segs := strings.Split(n, "/")
	has := false
	for _, x := range segs {
		if x == ".." {
			has = true
		}
	}
	if n == ".." || strings.HasPrefix(n, "../") || has || n == "." || strings.HasSuffix(n, "/") {
		return "", badPath("path escapes the repository")
	}
	return n, nil
}

// nodeExtname mirrors path.extname.
func nodeExtname(p string) string {
	base := path.Base(p)
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}

// Gate is the file gate in front of the mirror.
type Gate struct {
	allowed     []string
	maxBytes    int64
	denyPath    *regexp.Regexp
	denyContent *regexp.Regexp
}

func MakeGate(rt *Runtime) (*Gate, error) {
	dp, err := CompileJSRegexp(rt.Files.DenyPath, "i")
	if err != nil {
		return nil, err
	}
	dc, err := CompileJSRegexp(rt.Files.DenyContent, "im")
	if err != nil {
		return nil, err
	}
	return &Gate{rt.Files.AllowedExt, int64(rt.Files.MaxBytes), dp, dc}, nil
}

func (g *Gate) extAllowed(rel string) bool {
	e := strings.ToLower(nodeExtname(rel))
	for _, a := range g.allowed {
		if a == e {
			return true
		}
	}
	return false
}

func (g *Gate) CheckPath(rel string) error {
	if !g.extAllowed(rel) {
		return fail(403, "path_denied", "file type is not served")
	}
	if g.denyPath.MatchString(rel) {
		return fail(403, "path_denied", "path is not served")
	}
	return nil
}

func (g *Gate) CheckSize(size int64) error {
	if size > g.maxBytes {
		return fail(413, "too_large", fmt.Sprintf("file exceeds %d bytes", g.maxBytes))
	}
	return nil
}

func (g *Gate) CheckContent(text string) error {
	if g.denyContent.MatchString(text) {
		return fail(403, "secret_filtered", "file looks like it holds a secret and is never served")
	}
	return nil
}

type repoState struct {
	Commit   *string
	SyncedAt *string
	OK       bool
}

// StoreOpts configures the mirror.
type StoreOpts struct {
	RT       *Runtime
	DataDir  string
	KeyDir   string
	Env      func(string) string
	URLFor   func(r repoDecl) string
	Personal bool
}

// Store is the read-only mirror of the declared private repos.
type Store struct {
	o      StoreOpts
	gate   *Gate
	mu     sync.Mutex
	state  map[string]repoState
	keys   map[string]string
	Secret []string
	khPath string
}

func NewStore(o StoreOpts) (*Store, error) {
	g, err := MakeGate(o.RT)
	if err != nil {
		return nil, err
	}
	s := &Store{o: o, gate: g, state: map[string]repoState{}, keys: map[string]string{}}
	if err := os.MkdirAll(o.KeyDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		return nil, err
	}
	s.khPath = filepath.Join(o.KeyDir, "known_hosts")
	if err := os.WriteFile(s.khPath, []byte(o.RT.Repos.KnownHosts+"\n"), 0o600); err != nil {
		return nil, err
	}
	for _, r := range o.RT.Repos.List {
		s.state[r.Name] = repoState{}
		b64 := strings.TrimSpace(o.Env(r.KeyEnv))
		if b64 == "" {
			continue
		}
		raw, _ := base64.StdEncoding.DecodeString(b64)
		pem := ojson.ReplaceInvalidUTF8(raw)
		s.Secret = append(s.Secret, b64, pem)
		for _, l := range strings.Split(pem, "\n") {
			if len(l) >= 16 {
				s.Secret = append(s.Secret, l)
			}
		}
		p := filepath.Join(o.KeyDir, r.Name+".key")
		body := pem
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			return nil, err
		}
		s.keys[r.Name] = p
	}
	return s, nil
}

func (s *Store) HasKey(name string) bool { _, ok := s.keys[name]; return ok }

func (s *Store) byName(n string) (repoDecl, bool) {
	for _, r := range s.o.RT.Repos.List {
		if r.Name == n {
			return r, true
		}
	}
	return repoDecl{}, false
}

func (s *Store) runGit(ctx context.Context, dir string, env []string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = env
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// Sync clones (shallow) or fast-forwards one repo. A failure keeps the last good checkout and only flags the repo; the
// message is logged redacted and NEVER sent to a client.
func (s *Store) Sync(repo repoDecl) bool {
	dir := filepath.Join(s.o.DataDir, repo.Name)
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + s.o.KeyDir, "GIT_TERMINAL_PROMPT=0"}
	if kp, ok := s.keys[repo.Name]; ok {
		env = append(env, "GIT_SSH_COMMAND="+strings.Join([]string{"ssh", "-F", "/dev/null", "-i", kp, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
			"-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + s.khPath}, " "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.o.RT.Repos.GitTimeoutMS)*time.Millisecond)
	defer cancel()
	var stderr string
	err := func() error {
		if _, serr := os.Stat(filepath.Join(dir, ".git")); serr != nil {
			_ = os.RemoveAll(dir)
			_, se, e := s.runGit(ctx, s.o.DataDir, env, "clone", "--quiet", "--depth", "1", "--single-branch", "--branch", repo.Branch, s.o.URLFor(repo), dir)
			stderr = se
			return e
		}
		if _, se, e := s.runGit(ctx, dir, env, "fetch", "--quiet", "--depth", "1", "origin", repo.Branch); e != nil {
			stderr = se
			return e
		}
		_, se, e := s.runGit(ctx, dir, env, "reset", "--quiet", "--hard", "FETCH_HEAD")
		stderr = se
		return e
	}()
	if err == nil {
		var out string
		out, stderr, err = s.runGit(ctx, dir, env, "rev-parse", "HEAD")
		if err == nil {
			c := strings.TrimSpace(out)
			now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
			s.mu.Lock()
			s.state[repo.Name] = repoState{Commit: &c, SyncedAt: &now, OK: true}
			s.mu.Unlock()
			return true
		}
	}
	s.mu.Lock()
	st := s.state[repo.Name]
	st.OK = false
	s.state[repo.Name] = st
	s.mu.Unlock()
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = err.Error()
	}
	first, _, _ := strings.Cut(msg, "\n")
	fmt.Fprintf(os.Stderr, "sync %s failed: %s\n", repo.Name, RedactSecrets(first, s.Secret))
	return false
}

// SyncAll syncs every declared repo in parallel.
func (s *Store) SyncAll() {
	var wg sync.WaitGroup
	for _, r := range s.o.RT.Repos.List {
		wg.Add(1)
		go func(r repoDecl) { defer wg.Done(); s.Sync(r) }(r)
	}
	wg.Wait()
}

// Repos is the per-repo status list, in declaration order.
func (s *Store) Repos() []struct {
	Name, Branch string
	State        repoState
} {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []struct {
		Name, Branch string
		State        repoState
	}
	for _, r := range s.o.RT.Repos.List {
		out = append(out, struct {
			Name, Branch string
			State        repoState
		}{r.Name, r.Branch, s.state[r.Name]})
	}
	return out
}

// Read serves one file of a declared repo through the gate. personal: the ONE declared personal file (runtime.autocomplete)
// skips the deny_path / deny_content secret filters (it is secrets by nature); every other check stays.
func (s *Store) Read(repoName string, relRaw *string, personal bool) (string, string, error) {
	repo, found := s.byName(repoName)
	if !found {
		return "", "", fail(403, "repo_not_declared", "repo is not declared")
	}
	_ = repo
	rel, err := CleanPath(relRaw)
	if err != nil {
		return "", "", err
	}
	// the personal file is served by its own route only, never through the generic file or dataset routes
	if ac := s.o.RT.Autocomplete; !personal && ac != nil && ac.Repo == repoName && ac.Path == rel {
		return "", "", fail(403, "path_denied", "path is not served")
	}
	if personal {
		if !s.gate.extAllowed(rel) {
			return "", "", fail(403, "path_denied", "file type is not served")
		}
	} else if err := s.gate.CheckPath(rel); err != nil {
		return "", "", err
	}
	s.mu.Lock()
	st := s.state[repoName]
	s.mu.Unlock()
	dir := filepath.Join(s.o.DataDir, repoName)
	if _, serr := os.Stat(dir); st.Commit == nil || serr != nil {
		return "", "", fail(503, "not_synced", "repo has not synced yet")
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", "", fail(503, "not_synced", "repo has not synced yet")
	}
	abs := filepath.Join(root, rel)
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", "", fail(404, "not_found", "no such file")
	}
	// A symlink inside the repo must not lead out of it, and .git is never readable.
	if real != root && !strings.HasPrefix(real, root+string(filepath.Separator)) {
		return "", "", fail(403, "path_denied", "path is not served")
	}
	for _, seg := range strings.Split(real[len(root):], string(filepath.Separator)) {
		if seg == ".git" {
			return "", "", fail(403, "path_denied", "path is not served")
		}
	}
	ls, err := os.Lstat(real)
	if err != nil || !ls.Mode().IsRegular() {
		return "", "", fail(404, "not_found", "no such file")
	}
	if err := s.gate.CheckSize(ls.Size()); err != nil {
		return "", "", err
	}
	b, err := os.ReadFile(real)
	if err != nil {
		return "", "", fail(404, "not_found", "no such file")
	}
	text := ojson.ReplaceInvalidUTF8(b)
	if !personal {
		if err := s.gate.CheckContent(text); err != nil {
			return "", "", err
		}
	}
	return text, *st.Commit, nil
}
