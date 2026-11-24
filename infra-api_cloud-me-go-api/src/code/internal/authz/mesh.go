package authz

import (
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

var v4mapped = regexp.MustCompile(`(?i)^::ffff:(\d+\.\d+\.\d+\.\d+)$`)

// parseAddr returns the 16-byte form and whether it is IPv4. Malformed input fails (never matches).
func parseAddr(s string, v6 bool) ([16]byte, bool) {
	var out [16]byte
	if v6 {
		if strings.Contains(s, ".") { // dotted tails are not accepted (the Node original returns null)
			return out, false
		}
		s = strings.ToLower(s)
		if i := strings.IndexByte(s, '%'); i >= 0 {
			s = s[:i]
		}
		ip := net.ParseIP(s)
		if ip == nil {
			return out, false
		}
		copy(out[:], ip.To16())
		return out, true
	}
	p := strings.Split(s, ".")
	if len(p) != 4 {
		return out, false
	}
	for i, x := range p {
		n, err := strconv.Atoi(x)
		if err != nil || n < 0 || n > 255 || x == "" || x[0] == '+' || x[0] == '-' {
			return out, false
		}
		out[i] = byte(n)
	}
	return out, true
}

func prefixMatch(a, n [16]byte, bits, width int) bool {
	for i := 0; i < width/8; i++ {
		rem := bits - i*8
		switch {
		case rem >= 8:
			if a[i] != n[i] {
				return false
			}
		case rem > 0:
			mask := byte(0xFF << (8 - rem))
			if a[i]&mask != n[i]&mask {
				return false
			}
		}
	}
	return true
}

// InCIDR reports whether addr lies in cidr. Malformed addresses or CIDRs never match. IPv4-mapped IPv6
// (::ffff:a.b.c.d) is treated as the IPv4 address. A CIDR without a prefix length is a host route. (The
// Node original accepts a few degenerate spellings such as "10.0.0.0/" as /0; they are refused here, which
// can only narrow the mesh gate, never widen it.)
func InCIDR(addr, cidr string) bool {
	a := strings.TrimSpace(addr)
	if m := v4mapped.FindStringSubmatch(a); m != nil {
		a = m[1]
	}
	net_, bitsRaw, hasBits := strings.Cut(strings.TrimSpace(cidr), "/")
	if strings.Contains(net_, ":") != strings.Contains(a, ":") {
		return false
	}
	v6 := strings.Contains(a, ":")
	width, def := 32, 32
	if v6 {
		width, def = 128, 128
	}
	bits := def
	if hasBits {
		n, err := strconv.Atoi(bitsRaw)
		if err != nil || bitsRaw == "" || bitsRaw[0] == '+' || bitsRaw[0] == '-' {
			return false
		}
		bits = n
	}
	if bits < 0 || bits > width {
		return false
	}
	x, ok1 := parseAddr(a, v6)
	n, ok2 := parseAddr(net_, v6)
	if !ok1 || !ok2 {
		return false
	}
	if bits == 0 {
		return true
	}
	return prefixMatch(x, n, bits, width)
}

// IsDirectMesh is true when the request is a direct wg0 dial, never one relayed by a proxy: any of the
// forwarding headers disqualifies it, whatever the source address.
func IsDirectMesh(remoteAddr string, h http.Header, cidrs []string) bool {
	for _, k := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Real-Ip", "Forwarded", "Via"} {
		if h.Get(k) != "" {
			return false
		}
	}
	for _, c := range cidrs {
		if InCIDR(remoteAddr, c) {
			return true
		}
	}
	return false
}

// RemoteIP strips the port from an http.Request.RemoteAddr.
func RemoteIP(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}
