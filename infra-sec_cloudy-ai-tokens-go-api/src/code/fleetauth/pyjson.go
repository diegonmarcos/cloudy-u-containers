// Package fleetauth holds the fleet's bearer-validation building blocks (JWKS, JWT, the
// tokens-api engine and the mcp-oauth introspection client) for Go services.
//
// The first consumer is introspect-proxy, a port of a Python (Flask + PyJWT 2.9) service
// whose decisions must not change. Several Python behaviours are therefore reproduced on
// purpose: JSON is parsed with Python's json rules (NaN/Infinity, last duplicate key wins,
// arbitrary-precision ints), values are compared and stringified the way Python does, and
// base64 is decoded leniently like binascii.a2b_base64. This file is that value layer.
package fleetauth

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Kind is the Python type a JSON value decodes to.
type Kind int

const (
	Null Kind = iota
	Bool
	Int
	Float
	Str
	List
	Obj
)

// Value is a decoded JSON value with Python semantics. Strings hold the code points as
// WTF-8 (a lone surrogate from a \ud800 escape is kept, as Python keeps it).
type Value struct {
	K Kind
	B bool
	I *big.Int
	F float64
	S string
	L []Value
	O *Object
}

// Object is a JSON object in insertion order (Python dict order: a duplicate key keeps its
// first position and takes the last value).
type Object struct {
	Keys []string
	M    map[string]Value
}

// Get returns the member and whether it exists.
func (o *Object) Get(k string) (Value, bool) {
	if o == nil {
		return Value{}, false
	}
	v, ok := o.M[k]
	return v, ok
}

func (o *Object) set(k string, v Value) {
	if _, ok := o.M[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.M[k] = v
}

// NewObject builds an object from ordered pairs (used when the proxy sends JSON upstream).
func NewObject(pairs ...any) *Object {
	o := &Object{M: map[string]Value{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		o.set(pairs[i].(string), pairs[i+1].(Value))
	}
	return o
}

func S(s string) Value     { return Value{K: Str, S: s} }
func ObjV(o *Object) Value { return Value{K: Obj, O: o} }

// Get is dict.get(k) on an object value; ok=false when v is not a dict (Python would raise
// AttributeError) — callers decide what that means.
func (v Value) Get(k string, def Value) (Value, bool) {
	if v.K != Obj {
		return Value{}, false
	}
	if m, ok := v.O.Get(k); ok {
		return m, true
	}
	return def, true
}

// Truthy is Python's bool(v).
func (v Value) Truthy() bool {
	switch v.K {
	case Null:
		return false
	case Bool:
		return v.B
	case Int:
		return v.I.Sign() != 0
	case Float:
		return v.F != 0 // NaN is truthy in Python as well
	case Str:
		return v.S != ""
	case List:
		return len(v.L) > 0
	default:
		return len(v.O.Keys) > 0
	}
}

// ErrJSON is any json.loads failure that Python raises as ValueError (JSONDecodeError,
// UnicodeDecodeError). ErrRecursion is the RecursionError of a too-deep document, which is
// not a ValueError and so escapes PyJWT's handlers.
var (
	ErrJSON      = errors.New("json: ValueError")
	ErrRecursion = errors.New("json: RecursionError")
)

// maxDepth approximates where CPython's C scanner hits the default recursion limit (1000)
// from inside a Flask request.
const maxDepth = 975

// intMaxStrDigits is CPython 3.11's default int max_str_digits; a longer literal is a
// ValueError in json.loads.
const intMaxStrDigits = 4300

// ParseJSON is json.loads(bytes): encoding detection, then Python's grammar.
func ParseJSON(b []byte) (Value, error) {
	s, err := decodeJSONBytes(b)
	if err != nil {
		return Value{}, ErrJSON
	}
	p := &parser{s: s}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return Value{}, err
	}
	p.ws()
	if p.i != len(p.s) {
		return Value{}, ErrJSON
	}
	return v, nil
}

// decodeJSONBytes mirrors json.detect_encoding + bytes.decode(enc, "surrogatepass") and
// returns the text as WTF-8.
func decodeJSONBytes(b []byte) (string, error) {
	switch {
	case bytes.HasPrefix(b, []byte{0, 0, 0xfe, 0xff}):
		return decodeUTF32(b[4:], true)
	case bytes.HasPrefix(b, []byte{0xff, 0xfe, 0, 0}):
		return decodeUTF32(b[4:], false)
	case bytes.HasPrefix(b, []byte{0xfe, 0xff}):
		return decodeUTF16(b[2:], true)
	case bytes.HasPrefix(b, []byte{0xff, 0xfe}):
		return decodeUTF16(b[2:], false)
	case bytes.HasPrefix(b, []byte{0xef, 0xbb, 0xbf}):
		return decodeUTF8Surrogatepass(b[3:])
	}
	if len(b) >= 4 {
		if b[0] == 0 {
			if b[1] != 0 {
				return decodeUTF16(b, true)
			}
			return decodeUTF32(b, true)
		}
		if b[1] == 0 {
			if b[2] != 0 || b[3] != 0 {
				return decodeUTF16(b, false)
			}
			return decodeUTF32(b, false)
		}
	} else if len(b) == 2 {
		if b[0] == 0 {
			return decodeUTF16(b, true)
		}
		if b[1] == 0 {
			return decodeUTF16(b, false)
		}
	}
	return decodeUTF8Surrogatepass(b)
}

func decodeUTF8Surrogatepass(b []byte) (string, error) {
	if utf8.Valid(b) {
		return string(b), nil
	}
	var sb strings.Builder
	for i := 0; i < len(b); {
		r, n := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && n == 1 {
			// surrogatepass: ED A0..BF 80..BF is an encoded surrogate, kept as is.
			if i+2 < len(b) && b[i] == 0xed && b[i+1] >= 0xa0 && b[i+1] <= 0xbf && b[i+2] >= 0x80 && b[i+2] <= 0xbf {
				sb.Write(b[i : i+3])
				i += 3
				continue
			}
			return "", ErrJSON
		}
		sb.Write(b[i : i+n])
		i += n
	}
	return sb.String(), nil
}

func decodeUTF16(b []byte, be bool) (string, error) {
	if len(b)%2 != 0 {
		return "", ErrJSON
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		if be {
			u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
		} else {
			u[i] = uint16(b[2*i+1])<<8 | uint16(b[2*i])
		}
	}
	var sb strings.Builder
	for i := 0; i < len(u); i++ {
		c := u[i]
		if c >= 0xd800 && c < 0xdc00 && i+1 < len(u) && u[i+1] >= 0xdc00 && u[i+1] < 0xe000 {
			sb.WriteRune(utf16.DecodeRune(rune(c), rune(u[i+1])))
			i++
			continue
		}
		writeCodePoint(&sb, rune(c))
	}
	return sb.String(), nil
}

func decodeUTF32(b []byte, be bool) (string, error) {
	if len(b)%4 != 0 {
		return "", ErrJSON
	}
	var sb strings.Builder
	for i := 0; i < len(b); i += 4 {
		var c uint32
		if be {
			c = uint32(b[i])<<24 | uint32(b[i+1])<<16 | uint32(b[i+2])<<8 | uint32(b[i+3])
		} else {
			c = uint32(b[i+3])<<24 | uint32(b[i+2])<<16 | uint32(b[i+1])<<8 | uint32(b[i])
		}
		if c > 0x10ffff {
			return "", ErrJSON
		}
		writeCodePoint(&sb, rune(c))
	}
	return sb.String(), nil
}

// writeCodePoint writes any code point, surrogates included (WTF-8).
func writeCodePoint(sb *strings.Builder, r rune) {
	if r >= 0xd800 && r <= 0xdfff {
		sb.WriteByte(0xed)
		sb.WriteByte(byte(0xa0 | (r>>6)&0x1f))
		sb.WriteByte(byte(0x80 | r&0x3f))
		return
	}
	sb.WriteRune(r)
}

// CodePoints decodes a WTF-8 string into code points (surrogates included).
func CodePoints(s string) []rune {
	out := make([]rune, 0, len(s))
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n == 1 && i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 {
			out = append(out, rune(0xd800|(rune(s[i+1])&0x1f)<<6|rune(s[i+2])&0x3f))
			i += 3
			continue
		}
		out = append(out, r)
		i += n
	}
	return out
}

type parser struct {
	s string
	i int
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) lit(w string) bool {
	if strings.HasPrefix(p.s[p.i:], w) {
		p.i += len(w)
		return true
	}
	return false
}

func (p *parser) value(depth int) (Value, error) {
	if p.i >= len(p.s) {
		return Value{}, ErrJSON
	}
	switch c := p.s[p.i]; {
	case c == '"':
		s, err := p.str()
		return Value{K: Str, S: s}, err
	case c == '{':
		if depth >= maxDepth {
			return Value{}, ErrRecursion
		}
		return p.object(depth + 1)
	case c == '[':
		if depth >= maxDepth {
			return Value{}, ErrRecursion
		}
		return p.array(depth + 1)
	case c == 'n' && p.lit("null"):
		return Value{K: Null}, nil
	case c == 't' && p.lit("true"):
		return Value{K: Bool, B: true}, nil
	case c == 'f' && p.lit("false"):
		return Value{K: Bool, B: false}, nil
	case c == 'N' && p.lit("NaN"):
		return Value{K: Float, F: math.NaN()}, nil
	case c == 'I' && p.lit("Infinity"):
		return Value{K: Float, F: math.Inf(1)}, nil
	case c == '-' || (c >= '0' && c <= '9'):
		if c == '-' && p.lit("-Infinity") {
			return Value{K: Float, F: math.Inf(-1)}, nil
		}
		return p.number()
	}
	return Value{}, ErrJSON
}

func (p *parser) number() (Value, error) {
	st := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) || p.s[p.i] < '0' || p.s[p.i] > '9' {
		return Value{}, ErrJSON
	}
	if p.s[p.i] == '0' {
		p.i++
	} else {
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	}
	isFloat := false
	if p.i+1 < len(p.s) && p.s[p.i] == '.' && p.s[p.i+1] >= '0' && p.s[p.i+1] <= '9' {
		isFloat = true
		p.i++
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		j := p.i + 1
		if j < len(p.s) && (p.s[j] == '+' || p.s[j] == '-') {
			j++
		}
		if j < len(p.s) && p.s[j] >= '0' && p.s[j] <= '9' {
			for j < len(p.s) && p.s[j] >= '0' && p.s[j] <= '9' {
				j++
			}
			isFloat = true
			p.i = j
		}
	}
	lit := p.s[st:p.i]
	if isFloat {
		f, err := strconv.ParseFloat(lit, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return Value{}, ErrJSON
		}
		return Value{K: Float, F: f}, nil
	}
	if len(strings.TrimPrefix(lit, "-")) > intMaxStrDigits {
		return Value{}, ErrJSON
	}
	n, _ := new(big.Int).SetString(lit, 10)
	return Value{K: Int, I: n}, nil
}

func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var sb strings.Builder
	for {
		if p.i >= len(p.s) {
			return "", ErrJSON
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return sb.String(), nil
		case c < 0x20:
			return "", ErrJSON // strict=True: control characters are not allowed
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return "", ErrJSON
			}
			e := p.s[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				sb.WriteByte(e)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r, ok := p.hex4()
				if !ok {
					return "", ErrJSON
				}
				if r >= 0xd800 && r <= 0xdbff && strings.HasPrefix(p.s[p.i:], "\\u") {
					save := p.i
					p.i += 2
					if r2, ok := p.hex4(); ok && r2 >= 0xdc00 && r2 <= 0xdfff {
						sb.WriteRune(utf16.DecodeRune(r, r2))
						continue
					}
					p.i = save
				}
				writeCodePoint(&sb, r)
			default:
				return "", ErrJSON
			}
		default:
			sb.WriteByte(c)
			p.i++
		}
	}
}

func (p *parser) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	n, err := strconv.ParseUint(p.s[p.i:p.i+4], 16, 32)
	if err != nil || strings.ContainsAny(p.s[p.i:p.i+4], "+-xX_") {
		return 0, false
	}
	p.i += 4
	return rune(n), true
}

func (p *parser) object(depth int) (Value, error) {
	p.i++
	o := &Object{M: map[string]Value{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return Value{K: Obj, O: o}, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return Value{}, ErrJSON
		}
		k, err := p.str()
		if err != nil {
			return Value{}, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return Value{}, ErrJSON
		}
		p.i++
		p.ws()
		v, err := p.value(depth)
		if err != nil {
			return Value{}, err
		}
		o.set(k, v)
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, ErrJSON
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == '}' {
			p.i++
			return Value{K: Obj, O: o}, nil
		}
		return Value{}, ErrJSON
	}
}

func (p *parser) array(depth int) (Value, error) {
	p.i++
	var l []Value
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return Value{K: List, L: []Value{}}, nil
	}
	for {
		p.ws()
		v, err := p.value(depth)
		if err != nil {
			return Value{}, err
		}
		l = append(l, v)
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, ErrJSON
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == ']' {
			p.i++
			return Value{K: List, L: l}, nil
		}
		return Value{}, ErrJSON
	}
}

// ── Python semantics on values ─────────────────────────────────────────────

// Equal is Python ==.
func Equal(a, b Value) bool {
	if isNum(a) && isNum(b) {
		return numCmp(a, b) == 0
	}
	if a.K != b.K {
		return false
	}
	switch a.K {
	case Null:
		return true
	case Str:
		return a.S == b.S
	case List:
		if len(a.L) != len(b.L) {
			return false
		}
		for i := range a.L {
			if !Equal(a.L[i], b.L[i]) {
				return false
			}
		}
		return true
	case Obj:
		if len(a.O.Keys) != len(b.O.Keys) {
			return false
		}
		for _, k := range a.O.Keys {
			bv, ok := b.O.Get(k)
			if !ok || !Equal(a.O.M[k], bv) {
				return false
			}
		}
		return true
	}
	return false
}

func isNum(v Value) bool { return v.K == Int || v.K == Float || v.K == Bool }

func numBig(v Value) *big.Float {
	switch v.K {
	case Bool:
		if v.B {
			return big.NewFloat(1)
		}
		return big.NewFloat(0)
	case Int:
		return new(big.Float).SetInt(v.I)
	}
	return big.NewFloat(v.F)
}

// numCmp compares two numeric values exactly; NaN compares unequal to everything (returns 2).
func numCmp(a, b Value) int {
	if (a.K == Float && math.IsNaN(a.F)) || (b.K == Float && math.IsNaN(b.F)) {
		return 2
	}
	return numBig(a).Cmp(numBig(b))
}

// IntErr tells which Python exception int(v) raises.
type IntErr int

const (
	IntOK       IntErr = iota
	IntValueErr        // ValueError (bad literal, NaN)
	IntOtherErr        // TypeError / OverflowError
)

// PyInt is int(v) for a JSON value.
func PyInt(v Value) (*big.Int, IntErr) {
	switch v.K {
	case Bool:
		if v.B {
			return big.NewInt(1), IntOK
		}
		return big.NewInt(0), IntOK
	case Int:
		return v.I, IntOK
	case Float:
		if math.IsNaN(v.F) {
			return nil, IntValueErr
		}
		if math.IsInf(v.F, 0) {
			return nil, IntOtherErr
		}
		i, _ := new(big.Float).SetFloat64(math.Trunc(v.F)).Int(nil)
		return i, IntOK
	case Str:
		return pyIntFromStr(v.S)
	}
	return nil, IntOtherErr
}

func pyIntFromStr(s string) (*big.Int, IntErr) {
	s = PyStrip(s)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	if s == "" || s[0] == '_' || s[len(s)-1] == '_' || strings.Contains(s, "__") {
		return nil, IntValueErr
	}
	digits := strings.ReplaceAll(s, "_", "")
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return nil, IntValueErr
		}
	}
	if len(digits) > intMaxStrDigits {
		return nil, IntValueErr
	}
	n, _ := new(big.Int).SetString(digits, 10)
	if neg {
		n.Neg(n)
	}
	return n, IntOK
}

// IntCmpFloat compares an int with a float exactly (Python int/float comparison).
func IntCmpFloat(i *big.Int, f float64) int {
	return new(big.Float).SetInt(i).Cmp(big.NewFloat(f))
}

// pySpace is str.isspace() for one code point.
func pySpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', 0x1c, 0x1d, 0x1e, 0x1f, ' ', 0x85, 0xa0, 0x1680,
		0x2028, 0x2029, 0x202f, 0x205f, 0x3000:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// PyStrip is str.strip() with no argument.
func PyStrip(s string) string {
	return strings.TrimFunc(s, pySpace)
}

// Latin1ToStr decodes raw header bytes the way gunicorn does (latin-1: byte = code point).
func Latin1ToStr(b string) string {
	var sb strings.Builder
	for i := 0; i < len(b); i++ {
		sb.WriteRune(rune(b[i]))
	}
	return sb.String()
}

// StrToLatin1 encodes a string to latin-1 bytes; ok=false when a code point is > 0xFF.
func StrToLatin1(s string) (string, bool) {
	var sb strings.Builder
	for _, r := range CodePoints(s) {
		if r > 0xff {
			return "", false
		}
		sb.WriteByte(byte(r))
	}
	return sb.String(), true
}

// PyStr is str(v).
func PyStr(v Value) string {
	if v.K == Str {
		return v.S
	}
	return PyRepr(v)
}

// PyRepr is repr(v).
func PyRepr(v Value) string {
	switch v.K {
	case Null:
		return "None"
	case Bool:
		if v.B {
			return "True"
		}
		return "False"
	case Int:
		return v.I.String()
	case Float:
		return pyFloatRepr(v.F, false)
	case Str:
		return pyStrRepr(v.S)
	case List:
		parts := make([]string, len(v.L))
		for i, e := range v.L {
			parts[i] = PyRepr(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	}
	parts := make([]string, len(v.O.Keys))
	for i, k := range v.O.Keys {
		parts[i] = pyStrRepr(k) + ": " + PyRepr(v.O.M[k])
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

// pyFloatRepr is float.__repr__ (json=false) or json.dumps' float form (json=true).
func pyFloatRepr(f float64, json bool) string {
	switch {
	case math.IsNaN(f):
		if json {
			return "NaN"
		}
		return "nan"
	case math.IsInf(f, 1):
		if json {
			return "Infinity"
		}
		return "inf"
	case math.IsInf(f, -1):
		if json {
			return "-Infinity"
		}
		return "-inf"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX, shortest round-trip digits
	sign := ""
	if e[0] == '-' {
		sign, e = "-", e[1:]
	}
	mant, expS, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expS)
	digits := strings.Replace(mant, ".", "", 1)
	decpt := exp + 1
	if decpt <= -4 || decpt > 16 {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		es := "+"
		if exp < 0 {
			es, exp = "-", -exp
		}
		return fmt.Sprintf("%s%se%s%02d", sign, m, es, exp)
	}
	var out string
	switch {
	case decpt <= 0:
		out = "0." + strings.Repeat("0", -decpt) + digits
	case decpt >= len(digits):
		out = digits + strings.Repeat("0", decpt-len(digits)) + ".0"
	default:
		out = digits[:decpt] + "." + digits[decpt:]
	}
	return sign + out
}

func pyStrRepr(s string) string {
	cps := CodePoints(s)
	quote := '\''
	hasSingle, hasDouble := false, false
	for _, r := range cps {
		if r == '\'' {
			hasSingle = true
		} else if r == '"' {
			hasDouble = true
		}
	}
	if hasSingle && !hasDouble {
		quote = '"'
	}
	var sb strings.Builder
	sb.WriteRune(quote)
	for _, r := range cps {
		switch {
		case r == quote || r == '\\':
			sb.WriteByte('\\')
			sb.WriteRune(r)
		case r == '\t':
			sb.WriteString(`\t`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r < ' ' || r == 0x7f:
			fmt.Fprintf(&sb, `\x%02x`, r)
		case r < 0x7f:
			sb.WriteRune(r)
		case r < 0xd800 || r > 0xdfff:
			if unicode.IsPrint(r) {
				sb.WriteRune(r)
			} else if r <= 0xff {
				fmt.Fprintf(&sb, `\x%02x`, r)
			} else if r <= 0xffff {
				fmt.Fprintf(&sb, `\u%04x`, r)
			} else {
				fmt.Fprintf(&sb, `\U%08x`, r)
			}
		default:
			fmt.Fprintf(&sb, `\u%04x`, r)
		}
	}
	sb.WriteRune(quote)
	return sb.String()
}

// DumpJSON is json.dumps(v) with Python's defaults (ensure_ascii, ", " and ": " separators).
func DumpJSON(v Value) string {
	var sb strings.Builder
	dump(&sb, v)
	return sb.String()
}

func dump(sb *strings.Builder, v Value) {
	switch v.K {
	case Null:
		sb.WriteString("null")
	case Bool:
		if v.B {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case Int:
		sb.WriteString(v.I.String())
	case Float:
		sb.WriteString(pyFloatRepr(v.F, true))
	case Str:
		dumpStr(sb, v.S)
	case List:
		sb.WriteByte('[')
		for i, e := range v.L {
			if i > 0 {
				sb.WriteString(", ")
			}
			dump(sb, e)
		}
		sb.WriteByte(']')
	case Obj:
		sb.WriteByte('{')
		for i, k := range v.O.Keys {
			if i > 0 {
				sb.WriteString(", ")
			}
			dumpStr(sb, k)
			sb.WriteString(": ")
			dump(sb, v.O.M[k])
		}
		sb.WriteByte('}')
	}
}

func dumpStr(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range CodePoints(s) {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			switch {
			case r < 0x20 || (r > 0x7e && r <= 0xffff):
				fmt.Fprintf(sb, `\u%04x`, r)
			case r > 0xffff:
				r1, r2 := utf16.EncodeRune(r)
				fmt.Fprintf(sb, `\u%04x\u%04x`, r1, r2)
			default:
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}
