package fleetauth

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// FlaskJSON renders v the way flask.jsonify does in production (Flask 3.0 DefaultJSONProvider):
// object keys sorted, compact separators, ensure_ascii, one trailing newline. v may be nil, bool,
// int, int64, *big.Int, float64, string, []string, []any, map[string]any, Value, *Object or []Value.
func FlaskJSON(v any) []byte {
	var sb strings.Builder
	flask(&sb, v)
	sb.WriteByte('\n')
	return []byte(sb.String())
}

func flask(sb *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if x {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case int:
		fmt.Fprintf(sb, "%d", x)
	case int64:
		fmt.Fprintf(sb, "%d", x)
	case *big.Int:
		sb.WriteString(x.String())
	case float64:
		sb.WriteString(pyFloatRepr(x, true))
	case string:
		dumpStr(sb, x)
	case []string:
		sb.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			dumpStr(sb, e)
		}
		sb.WriteByte(']')
	case []any:
		sb.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			flask(sb, e)
		}
		sb.WriteByte(']')
	case []Value:
		sb.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			flask(sb, e)
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sortKeys(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			dumpStr(sb, k)
			sb.WriteByte(':')
			flask(sb, x[k])
		}
		sb.WriteByte('}')
	case *Object:
		flask(sb, ObjV(x))
	case Value:
		switch x.K {
		case Null:
			sb.WriteString("null")
		case Bool:
			flask(sb, x.B)
		case Int:
			sb.WriteString(x.I.String())
		case Float:
			sb.WriteString(pyFloatRepr(x.F, true))
		case Str:
			dumpStr(sb, x.S)
		case List:
			flask(sb, x.L)
		case Obj:
			keys := append([]string(nil), x.O.Keys...)
			sortKeys(keys)
			sb.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					sb.WriteByte(',')
				}
				dumpStr(sb, k)
				sb.WriteByte(':')
				flask(sb, x.O.M[k])
			}
			sb.WriteByte('}')
		}
	default:
		panic(fmt.Sprintf("fleetauth.FlaskJSON: unsupported %T", v))
	}
}

// sortKeys orders keys by code point, like Python's sorted() on str.
func sortKeys(keys []string) {
	sort.Slice(keys, func(i, j int) bool {
		a, b := CodePoints(keys[i]), CodePoints(keys[j])
		for n := 0; n < len(a) && n < len(b); n++ {
			if a[n] != b[n] {
				return a[n] < b[n]
			}
		}
		return len(a) < len(b)
	})
}

// PyFields is str.split() with no argument (Python whitespace, empty fields dropped).
func PyFields(s string) []string {
	return strings.FieldsFunc(s, pySpace)
}

// CPLen is len(s) in code points.
func CPLen(s string) int { return len(CodePoints(s)) }

// CPHead is s[:n] in code points.
func CPHead(s string, n int) string {
	cp := CodePoints(s)
	if len(cp) <= n {
		return s
	}
	return cpString(cp[:n])
}

// CPTail is s[-n:] in code points.
func CPTail(s string, n int) string {
	cp := CodePoints(s)
	if len(cp) <= n {
		return s
	}
	return cpString(cp[len(cp)-n:])
}

func cpString(cp []rune) string {
	var sb strings.Builder
	for _, r := range cp {
		writeCodePoint(&sb, r)
	}
	return sb.String()
}

// HasSurrogate reports whether s holds a lone surrogate code point (Python str.encode() raises on it).
func HasSurrogate(s string) bool {
	for _, r := range CodePoints(s) {
		if r >= 0xd800 && r <= 0xdfff {
			return true
		}
	}
	return false
}

// IsASCIIDigits is str.isdigit() restricted to what the callers need: every code point is an ASCII digit.
// (Python isdigit also accepts other Unicode digits; callers that compare length afterwards are unaffected
// because such a code never matches a code made of ASCII digits.)
func IsASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
