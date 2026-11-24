// Package gate is the Go port of _shared/jev-gate/jev_gate.py (#1879): the Jev pre-flight gate.
// Behaviour parity with the Python module is the contract; the comments name the Python function each
// piece mirrors. Dynamic JSON (the config, hook events, journal lines) is carried as pyjson values so key
// order, int/float and json.dumps formatting match byte for byte.
package gate

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"jev-gate/pyjson"
)

// Config is the parsed jev-gate.json.
type Config = *pyjson.OMap

// PyErr is an error that carries the Python exception class name the journal prints
// ("exception:" + type(e).__name__, and decide()'s meta.error).
type PyErr struct{ Name, Msg string }

func (e *PyErr) Error() string { return e.Name + ": " + e.Msg }

func perr(name, format string, a ...any) error { return &PyErr{name, fmt.Sprintf(format, a...)} }

// ErrName is type(e).__name__.
func ErrName(err error) string {
	if p, ok := err.(*PyErr); ok {
		return p.Name
	}
	return "Exception"
}

//go:embed jev-gate.json
var embeddedConfig []byte

// LoadConfig reads the config: path, else $JEV_GATE_CONFIG, else jev-gate.json beside the binary, else the
// copy embedded in the binary (a drift test keeps it byte-identical to _shared/jev-gate/jev-gate.json).
func LoadConfig(path string) (Config, error) {
	if path == "" {
		path = os.Getenv("JEV_GATE_CONFIG")
	}
	var b []byte
	var err error
	if path != "" {
		b, err = os.ReadFile(path)
	} else {
		exe, _ := os.Executable()
		if b, err = os.ReadFile(filepath.Join(filepath.Dir(exe), "jev-gate.json")); err != nil {
			b, err = embeddedConfig, nil
		}
	}
	if err != nil {
		return nil, err
	}
	v, err := pyjson.Parse(b)
	if err != nil {
		return nil, err
	}
	m := pyjson.AsMap(v)
	if m == nil {
		return nil, perr("TypeError", "config is not an object")
	}
	return m, nil
}

// ---- small helpers over the dynamic config ----

func get(m *pyjson.OMap, keys ...string) any { return pyjson.Path(m, keys...) }

func str(v any) string { s, _ := v.(string); return s }

func num(v any) float64 { f, _ := pyjson.AsNum(v); return f }

func intOf(v any) int { f, _ := pyjson.AsNum(v); return int(f) }

// useCfg is use_cfg: the use's block when enabled, else nil.
func useCfg(cfg Config, use string) *pyjson.OMap {
	u := pyjson.AsMap(get(cfg, "uses", use))
	if u == nil || !pyjson.Truthy(u.M["enabled"]) {
		return nil
	}
	return u
}

// runeSlice is s[:n] on code points.
func runeSlice(s string, n int) string {
	if n < 0 {
		n = 0
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func shaShort(s string) string { return sha256hex(s)[:16] }

// expandUser is os.path.expanduser.
func expandUser(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home := os.Getenv("HOME")
		if home == "" {
			if u, err := user.Current(); err == nil {
				home = u.HomeDir
			}
		}
		if home == "" {
			return p
		}
		home = strings.TrimRight(home, "/")
		return home + p[1:]
	}
	return p
}

var envRe = regexp.MustCompile(`\$\{(\w+)(?::-([^}]*))?\}`)

// expand is _expand: ${VAR} / ${VAR:-default} and a leading ~. strict: an unset VAR without default -> ok=false.
func expand(s string, strict bool) (string, bool) {
	missing := false
	out := envRe.ReplaceAllStringFunc(s, func(m string) string {
		sm := envRe.FindStringSubmatch(m)
		if v := os.Getenv(sm[1]); v != "" {
			return v
		}
		if !strings.Contains(m, ":-") {
			missing = true
		}
		return sm[2]
	})
	out = expandUser(out)
	if strict && missing {
		return "", false
	}
	return out, true
}

// ---- Python regex -> Go regex ----

const pySpace = `\t\n\v\f\r \x1c-\x1f\x85\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}`

var reCache sync.Map

// pyRE compiles a Python `re` pattern with the dialect differences that matter here: \s / \S are the
// Unicode whitespace set, [\s\S] is "any character", and $ is the end of the text.
func pyRE(p string) (*regexp.Regexp, error) {
	if c, ok := reCache.Load(p); ok {
		return c.(*regexp.Regexp), nil
	}
	var b strings.Builder
	inClass := false
	rs := []rune(p)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\\' && i+1 < len(rs):
			n := rs[i+1]
			i++
			switch {
			case n == 's' && inClass:
				b.WriteString(pySpace)
			case n == 's':
				b.WriteString("[" + pySpace + "]")
			case n == 'S' && !inClass:
				b.WriteString("[^" + pySpace + "]")
			default:
				b.WriteRune('\\')
				b.WriteRune(n)
			}
		case c == '[' && !inClass:
			inClass = true
			b.WriteRune(c)
			if i+1 < len(rs) && rs[i+1] == '^' {
				b.WriteRune('^')
				i++
			}
			if i+1 < len(rs) && rs[i+1] == ']' {
				b.WriteString(`\]`)
				i++
			}
		case c == ']' && inClass:
			inClass = false
			b.WriteRune(c)
		case c == '$' && !inClass:
			b.WriteString(`\z`)
		default:
			b.WriteRune(c)
		}
	}
	src := strings.ReplaceAll(b.String(), "["+pySpace+"][^"+pySpace+"]", "(?s:.)")
	src = strings.ReplaceAll(src, "[^"+pySpace+"]["+pySpace+"]", "(?s:.)")
	re, err := regexp.Compile(src)
	if err != nil {
		return nil, err
	}
	reCache.Store(p, re)
	return re, nil
}

// mustRE panics are not acceptable on a hook path; a bad pattern is "no opinion" upstream.
func searchRE(p, s string) (bool, error) {
	re, err := pyRE(p)
	if err != nil {
		return false, perr("error", "%v", err)
	}
	return re.MatchString(s), nil
}

var backrefRe = regexp.MustCompile(`\\(\d)`)

// subRE is re.sub(p, repl, s) with Python's \1 templates.
func subRE(p, repl, s string) (string, error) {
	re, err := pyRE(p)
	if err != nil {
		return s, perr("error", "%v", err)
	}
	r := strings.ReplaceAll(repl, "$", "$$")
	r = backrefRe.ReplaceAllString(r, "$$"+"{$1}")
	return re.ReplaceAllString(s, r), nil
}

// splitRE is re.split(p, s) for a pattern without capture groups.
func splitRE(p, s string) ([]string, error) {
	re, err := pyRE(p)
	if err != nil {
		return nil, perr("error", "%v", err)
	}
	return re.Split(s, -1), nil
}

// pyStr is str(v) for a parsed JSON value.
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return pyjson.FloatRepr(x)
	}
	return pyjson.DumpsDefault(v)
}

// pyEq is Python's == over parsed JSON values (bool is a number there).
func pyEq(a, b any) bool {
	fa, aok := numLike(a)
	fb, bok := numLike(b)
	if aok || bok {
		return aok && bok && fa == fb
	}
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !pyEq(x[i], y[i]) {
				return false
			}
		}
		return true
	case *pyjson.OMap:
		y, ok := b.(*pyjson.OMap)
		if !ok || x.Len() != y.Len() {
			return false
		}
		for _, k := range x.Keys {
			v, ok := y.M[k]
			if !ok || !pyEq(x.M[k], v) {
				return false
			}
		}
		return true
	}
	return false
}

func numLike(v any) (float64, bool) {
	switch x := v.(type) {
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return pyjson.AsNum(v)
}

// isProb is _prob: a real number (not a bool) in [0, 1].
func isProb(v any) bool {
	f, ok := pyjson.AsNum(v)
	return ok && f >= 0 && f <= 1
}

func nowSec() float64 { return float64(time.Now().UnixNano()) / 1e9 }
