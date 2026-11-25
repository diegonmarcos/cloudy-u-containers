package fleetauth

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ErrURLValue is the ValueError urllib.parse raises for a malformed URL.
var ErrURLValue = errors.New("ValueError")

// SplitURL is urllib.parse.SplitResult (path and query are not percent-decoded).
type SplitURL struct {
	Scheme, Netloc, Path, Query, Fragment string
}

const schemeChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-."

var versionedHost = regexp.MustCompile(`^v[a-fA-F0-9]+\..+$`)

// PyURLSplit is urllib.parse.urlsplit (CPython 3.11.4+). A malformed bracketed host is the ValueError Python raises.
func PyURLSplit(raw string) (SplitURL, error) {
	url := strings.TrimLeftFunc(raw, func(r rune) bool { return r <= 0x20 })
	for _, b := range []string{"\t", "\r", "\n"} {
		url = strings.ReplaceAll(url, b, "")
	}
	var u SplitURL
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
				u.Scheme, url = strings.ToLower(url[:i]), url[i+1:]
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
		u.Netloc, url = url[2:delim], url[delim:]
		open, closeB := strings.Contains(u.Netloc, "["), strings.Contains(u.Netloc, "]")
		if open != closeB {
			return u, ErrURLValue
		}
		if open {
			host, _, _ := strings.Cut(u.Netloc[strings.Index(u.Netloc, "[")+1:], "]")
			if strings.HasPrefix(host, "v") {
				if !versionedHost.MatchString(host) {
					return u, ErrURLValue
				}
			} else if ip, err := netip.ParseAddr(host); err != nil || ip.Is4() {
				return u, ErrURLValue
			}
		}
	}
	if i := strings.IndexByte(url, '#'); i >= 0 {
		u.Fragment = url[i+1:]
		url = url[:i]
	}
	if i := strings.IndexByte(url, '?'); i >= 0 {
		u.Query = url[i+1:]
		url = url[:i]
	}
	u.Path = url
	return u, nil
}

// hostinfo is SplitResult._hostinfo: the host (original case) and the port text ("" for none).
func (u SplitURL) hostinfo() (host, port string) {
	info := u.Netloc
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

// Hostname is SplitResult.hostname ("" when absent).
func (u SplitURL) Hostname() string {
	h, _ := u.hostinfo()
	if h == "" {
		return ""
	}
	name, zone, found := strings.Cut(h, "%")
	if !found {
		return strings.ToLower(name)
	}
	return strings.ToLower(name) + "%" + zone
}

// PortOK is SplitResult.port not raising: digits only, 0..65535.
func (u SplitURL) PortOK() bool {
	_, p := u.hostinfo()
	if p == "" {
		return true
	}
	if !IsASCIIDigits(p) {
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
