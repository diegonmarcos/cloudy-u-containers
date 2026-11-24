package mcpoauth

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"unicode/utf8"

	"mcp-oauth/fleetauth"
)

var errValue = errors.New("ValueError")

type splitURL struct {
	scheme, netloc, path, fragment string
}

const schemeChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-."

var versionedHost = regexp.MustCompile(`^v[a-fA-F0-9]+\..+$`)

// pyURLSplit is urllib.parse.urlsplit (CPython 3.11.4+) for what redirect validation reads: scheme, netloc,
// fragment. A malformed bracketed host is the ValueError Python raises.
func pyURLSplit(raw string) (splitURL, error) {
	url := strings.TrimLeftFunc(raw, func(r rune) bool { return r <= 0x20 })
	for _, b := range []string{"\t", "\r", "\n"} {
		url = strings.ReplaceAll(url, b, "")
	}
	var u splitURL
	if i := strings.IndexByte(url, ':'); i > 0 {
		c := url[0]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			ok := true
			for _, ch := range url[:i] {
				if ch >= utf8.RuneSelf || !strings.ContainsRune(schemeChars, ch) {
					ok = false
					break
				}
			}
			if ok {
				u.scheme, url = strings.ToLower(url[:i]), url[i+1:]
			}
		}
	}
	if strings.HasPrefix(url, "//") {
		delim := len(url)
		for _, c := range "/?#" {
			if w := strings.IndexRune(url[2:], c); w >= 0 && w+2 < delim {
				delim = w + 2
			}
		}
		u.netloc, url = url[2:delim], url[delim:]
		open, closeB := strings.Contains(u.netloc, "["), strings.Contains(u.netloc, "]")
		if open != closeB {
			return u, errValue
		}
		if open {
			host, _, _ := strings.Cut(u.netloc[strings.Index(u.netloc, "[")+1:], "]")
			if strings.HasPrefix(host, "v") {
				if !versionedHost.MatchString(host) {
					return u, errValue
				}
			} else if ip, err := netip.ParseAddr(host); err != nil || ip.Is4() {
				return u, errValue
			}
		}
	}
	if i := strings.IndexByte(url, '#'); i >= 0 {
		u.fragment = url[i+1:]
		url = url[:i]
	}
	if i := strings.IndexByte(url, '?'); i >= 0 {
		url = url[:i]
	}
	u.path = url
	return u, nil
}

// hostinfo is SplitResult._hostinfo: the host (original case) and the port text ("" for none).
func (u splitURL) hostinfo() (host, port string) {
	info := u.netloc
	if i := strings.LastIndex(info, "@"); i >= 0 {
		info = info[i+1:]
	}
	if _, after, ok := strings.Cut(info, "["); ok {
		h, rest, _ := strings.Cut(after, "]")
		_, p, _ := strings.Cut(rest, ":")
		return h, p
	}
	h, p, _ := strings.Cut(info, ":")
	return h, p
}

// hostname is SplitResult.hostname ("" when absent).
func (u splitURL) hostname() string {
	h, _ := u.hostinfo()
	if h == "" {
		return ""
	}
	name, sep, zone := strings.Cut(h, "%")
	if sep == "" {
		return strings.ToLower(name)
	}
	return strings.ToLower(name) + sep + zone
}

// portOK is SplitResult.port not raising: digits only, 0..65535.
func (u splitURL) portOK() bool {
	_, p := u.hostinfo()
	if p == "" {
		return true
	}
	if !fleetauth.IsASCIIDigits(p) {
		return false
	}
	n := 0
	for _, c := range p {
		n = n*10 + int(c-'0')
		if n > 65535 {
			return false
		}
	}
	return true
}
