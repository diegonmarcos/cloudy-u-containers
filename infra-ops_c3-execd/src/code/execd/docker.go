package execd

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Docker talks to the local engine over its unix socket, in-process (no docker CLI and no
// CLI plugin subprocesses). Only the paths in dockerRules are reachable: the read calls
// the fleet tools make and start/stop/restart of a named container (docker.ts controlContainer).
type Docker struct {
	Socket string
	cl     *http.Client
}

func NewDocker(socket string) *Docker {
	return &Docker{Socket: socket, cl: &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
	}}}
}

type dockerRule struct {
	method string
	path   *regexp.Regexp
}

const ctr = `[a-zA-Z0-9][a-zA-Z0-9_.-]*`

var dockerRules = []dockerRule{
	{"GET", regexp.MustCompile(`^/(v1\.\d+/)?_ping$`)},
	{"GET", regexp.MustCompile(`^/(v1\.\d+/)?(version|info)$`)},
	{"GET", regexp.MustCompile(`^/(v1\.\d+/)?(containers|images)/json$`)},
	{"GET", regexp.MustCompile(`^/(v1\.\d+/)?containers/` + ctr + `/(json|logs|top|stats)$`)},
	{"POST", regexp.MustCompile(`^/(v1\.\d+/)?containers/` + ctr + `/(start|stop|restart)$`)},
}

// DockerRequest is one engine API call. Query is the raw query string without '?'.
type DockerRequest struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Query     string `json:"query"`
	TimeoutMS int    `json:"timeout_ms"`
}

// DockerResponse carries the engine's status and body.
type DockerResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// CheckDocker applies the allowlist: method+path must match a rule; ".." and encoded
// separators are refused before matching.
func CheckDocker(method, path string) error {
	if strings.Contains(path, "..") || strings.ContainsAny(path, "%?#\x00") {
		return fmt.Errorf("docker path not allowed: %q", path)
	}
	for _, r := range dockerRules {
		if r.method == method && r.path.MatchString(path) {
			return nil
		}
	}
	return fmt.Errorf("docker call not allowed: %s %s", method, path)
}

func (d *Docker) Do(ctx context.Context, r DockerRequest) (DockerResponse, error) {
	if err := CheckDocker(r.Method, r.Path); err != nil {
		return DockerResponse{}, err
	}
	timeout := DefaultTimeout
	if r.TimeoutMS > 0 {
		timeout = time.Duration(r.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	u := "http://docker" + r.Path
	if r.Query != "" {
		u += "?" + r.Query
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, u, nil)
	if err != nil {
		return DockerResponse{}, err
	}
	resp, err := d.cl.Do(req)
	if err != nil {
		return DockerResponse{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, MaxBuffer))
	return DockerResponse{Status: resp.StatusCode, Body: string(b)}, err
}
