package gitproxy

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type route struct {
	Method   string
	Declared string
	Local    string
	Auth     string
	re       *regexp.Regexp
	params   []string
	handler  handler
}

func toRegex(local string) *regexp.Regexp {
	segs := strings.Split(local, "/")
	for i, s := range segs {
		if strings.HasPrefix(s, ":") {
			segs[i] = "([^/]+)"
		} else {
			segs[i] = regexp.QuoteMeta(s)
		}
	}
	return regexp.MustCompile("^" + strings.Join(segs, "/") + "$")
}

func paramNames(local string) []string {
	var out []string
	for _, s := range strings.Split(local, "/") {
		if strings.HasPrefix(s, ":") {
			out = append(out, s[1:])
		}
	}
	return out
}

// buildTable derives the dispatch table FROM the declared contract and refuses to build when the two sides
// disagree in either direction (#371): a declared endpoint with no handler, or a handler nobody declared.
func buildTable(rt *Runtime, handlers map[string]handler) ([]route, error) {
	declared := map[string]bool{}
	for _, e := range rt.Endpoints {
		declared[e.Path] = true
	}
	for k := range handlers {
		if !declared[k] {
			return nil, fmt.Errorf("router: handler for %q is not declared in build.json runtime.endpoints", k)
		}
	}
	var out []route
	for _, e := range rt.Endpoints {
		h := handlers[e.Path]
		if h == nil {
			return nil, fmt.Errorf("router: build.json declares %q but no handler is registered", e.Method+" "+e.Path)
		}
		local := LocalPath(e.Path, rt.BasePath)
		out = append(out, route{Method: e.Method, Declared: e.Path, Local: local, Auth: e.Auth, re: toRegex(local), params: paramNames(local), handler: h})
	}
	return out, nil
}

// match: nil,nil = no such path; (nil, allowed) = path exists, wrong method; (route, params) otherwise.
func match(table []route, method, path string) (*route, map[string]string, []string, error) {
	var byPath []*route
	for i := range table {
		if table[i].re.MatchString(path) {
			byPath = append(byPath, &table[i])
		}
	}
	if len(byPath) == 0 {
		return nil, nil, nil, nil
	}
	var exact *route
	for _, r := range byPath {
		if r.Method == method {
			exact = r
			break
		}
	}
	if exact == nil {
		var allowed []string
		for _, r := range byPath {
			allowed = append(allowed, r.Method)
		}
		return nil, nil, allowed, nil
	}
	m := exact.re.FindStringSubmatch(path)
	params := map[string]string{}
	for i, name := range exact.params {
		v, err := decodeURIComponent(m[i+1])
		if err != nil {
			return nil, nil, nil, err
		}
		params[name] = v
	}
	return exact, params, nil, nil
}

// decodeURIComponent mirrors JS: %XX only (no '+' handling), malformed escapes and invalid UTF-8 throw "URI malformed".
func decodeURIComponent(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	v, err := url.PathUnescape(s)
	if err != nil {
		return "", fmt.Errorf("URI malformed")
	}
	if !validUTF8(v) {
		return "", fmt.Errorf("URI malformed")
	}
	return v, nil
}
