package cmeapi

import (
	"net/http"
	"strings"
)

// pathname approximates WHATWG URL pathname: the raw (still percent-encoded) path with dot segments resolved.
func pathname(r *http.Request) string {
	p := r.URL.EscapedPath()
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	var out []string
	for i, sg := range segs {
		low := strings.ToLower(sg)
		last := i == len(segs)-1
		switch low {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, sg)
		}
	}
	if len(out) == 0 || out[0] != "" {
		out = append([]string{""}, out...)
	}
	return strings.Join(out, "/")
}
