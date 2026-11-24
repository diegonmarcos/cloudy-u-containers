// Package gitproxy is the Go port of infra-api_cloudy-drive-git-proxy-api (ticket #1882): the Authelia-fronted
// read path to GitHub. Same routes, same refusal bodies, same credential discipline; the shared authz package
// does the security-critical decisions.
package gitproxy

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// runtime.json is the `runtime` block of build.json, byte-for-byte what GET /git/endpoints serves. It is embedded
// (go:embed cannot reach build.json one level up); TestRuntimeMatchesBuildJson pins it to build.json and to the
// Node service's declaration so there is still ONE declaration and no drifting duplicate (#371).
//
//go:embed runtime.json
var runtimeJSON []byte

// Endpoint is one declared route.
type Endpoint struct {
	Method      string `json:"method"`
	Path        string `json:"path"`
	Auth        string `json:"auth"`
	Description string `json:"description"`
}

// Runtime is the validated runtime block.
type Runtime struct {
	BasePath     string          `json:"base_path"`
	Endpoints    []Endpoint      `json:"-"`
	RawEndpoints json.RawMessage `json:"endpoints"`
	Upstream     struct {
		APIBase   string `json:"api_base"`
		GitBase   string `json:"git_base"`
		TimeoutMS int    `json:"timeout_ms"`
	} `json:"upstream"`
	Authelia struct {
		JWKSURL            string `json:"jwks_url"`
		Issuer             string `json:"issuer"`
		RequiredScope      string `json:"required_scope"`
		JWKSCacheTTLS      int    `json:"jwks_cache_ttl_s"`
		JWKSFetchTimeoutMS int    `json:"jwks_fetch_timeout_ms"`
		Session            *struct {
			VerifyURL string   `json:"verify_url"`
			PublicURL string   `json:"public_url"`
			Users     []string `json:"users"`
			TimeoutMS int      `json:"timeout_ms"`
		} `json:"session"`
	} `json:"authelia"`
	Mesh *struct {
		Cidrs []string `json:"cidrs"`
	} `json:"mesh"`
	Feeds *struct {
		Repos      []string `json:"repos"`
		CacheTTLS  float64  `json:"cache_ttl_s"`
		MaxPerPage float64  `json:"max_per_page"`
	} `json:"feeds"`
}

var repoEntry = regexp.MustCompile(`^[^/]+/[^/]+$`)
var originRe = regexp.MustCompile(`^https://[^/]+$`)

// LoadRuntime parses and validates a runtime block exactly like contract.mjs loadRuntime: a malformed contract
// refuses to start instead of serving an empty or wrong one.
func LoadRuntime(data []byte) (*Runtime, error) {
	var rt Runtime
	if err := json.Unmarshal(data, &rt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(rt.RawEndpoints, &rt.Endpoints); err != nil || len(rt.Endpoints) == 0 {
		return nil, errors.New("build.json runtime.endpoints is missing or empty")
	}
	if !strings.HasPrefix(rt.BasePath, "/") {
		return nil, errors.New("build.json runtime.base_path must be an absolute path")
	}
	for _, e := range rt.Endpoints {
		if e.Method == "" || e.Path == "" || e.Auth == "" {
			return nil, fmt.Errorf("build.json runtime.endpoints entry missing method/path/auth: %+v", e)
		}
		if !strings.HasPrefix(e.Path, rt.BasePath) {
			return nil, fmt.Errorf("endpoint %s does not sit under base_path %s", e.Path, rt.BasePath)
		}
	}
	f := rt.Feeds
	if f == nil || len(f.Repos) == 0 {
		return nil, errors.New(`build.json runtime.feeds.repos must be a non-empty list of "owner/repo"`)
	}
	for _, r := range f.Repos {
		if !repoEntry.MatchString(r) {
			return nil, errors.New(`build.json runtime.feeds.repos must be a non-empty list of "owner/repo"`)
		}
	}
	if !(f.CacheTTLS > 0) || f.MaxPerPage != float64(int(f.MaxPerPage)) || f.MaxPerPage < 1 || f.MaxPerPage > 100 {
		return nil, errors.New("build.json runtime.feeds needs cache_ttl_s > 0 and max_per_page in 1..100")
	}
	s := rt.Authelia.Session
	if s == nil || !strings.HasPrefix(s.VerifyURL, "https://") || !originRe.MatchString(s.PublicURL) || len(s.Users) == 0 || !(s.TimeoutMS > 0) {
		return nil, errors.New("build.json runtime.authelia.session needs verify_url, public_url (origin), users[] and timeout_ms")
	}
	if !originRe.MatchString(rt.Upstream.GitBase) {
		return nil, errors.New("build.json runtime.upstream.git_base must be an https origin")
	}
	return &rt, nil
}

// LocalPath turns a declared path into the path the server matches on (Caddy strips the base path).
func LocalPath(declared, base string) string {
	s := declared[len(base):]
	if s == "" {
		return "/"
	}
	return s
}
