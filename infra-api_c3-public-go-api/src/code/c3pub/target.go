package c3pub

import (
	"fmt"
	"math"
	"strings"
)

// DeclaredTargets are the names build.json#mail.targets declares (one SoT, pinned by TestDeclaredTargetsMatchBuildJson).
var DeclaredTargets = []string{"maddy", "maddy-direct", "stalwart"}

// TargetPick is the outcome of pickTarget.
type TargetPick struct {
	OK    bool
	Name  string
	Host  string
	Port  int
	Code  int
	Error string
}

// jsTrim mirrors String.prototype.trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}

// PickTarget (#1811): which store one /mail/http-to-smtp request delivers to. No header -> the primary (maddy:25); a named
// target must be declared AND resolved: unknown -> 400, declared-but-unresolved -> 503.
func PickTarget(header string, primary MailTarget, targets map[string]MailTarget, declared []string) TargetPick {
	name := strings.ToLower(jsTrim(header))
	if name == "" {
		return TargetPick{OK: true, Name: "maddy", Host: primary.Host, Port: int(primary.Port)}
	}
	if t, ok := targets[name]; ok && t.Host != "" && t.Port == math.Trunc(t.Port) {
		return TargetPick{OK: true, Name: name, Host: t.Host, Port: int(t.Port)}
	}
	for _, d := range declared {
		if d == name {
			return TargetPick{Code: 503, Error: fmt.Sprintf("mail target '%s' is declared but not resolved on this host", name)}
		}
	}
	return TargetPick{Code: 400, Error: fmt.Sprintf("unknown mail target '%s'", name)}
}
