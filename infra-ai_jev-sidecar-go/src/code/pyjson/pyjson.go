// Package pyjson is JSON with Python's json module semantics where the gate's output depends on them:
// dict key order is kept (OMap), ints and floats stay distinct, and Dumps writes exactly what
// json.dumps writes (", " and ": " separators, ensure_ascii, float repr, sort_keys).
package pyjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// OMap is an insertion-ordered string-keyed map (a Python dict).
type OMap struct {
	Keys []string
	M    map[string]any
}

// NewMap returns an empty OMap.
func NewMap() *OMap { return &OMap{M: map[string]any{}} }

// Set inserts or replaces; a replaced key keeps its position (dict semantics).
func (o *OMap) Set(k string, v any) {
	if _, ok := o.M[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.M[k] = v
}

// Get returns the value and whether it is present.
func (o *OMap) Get(k string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.M[k]
	return v, ok
}

// Delete removes a key.
func (o *OMap) Delete(k string) {
	if _, ok := o.M[k]; !ok {
		return
	}
	delete(o.M, k)
	for i, x := range o.Keys {
		if x == k {
			o.Keys = append(o.Keys[:i:i], o.Keys[i+1:]...)
			break
		}
	}
}

// Len is the number of keys.
func (o *OMap) Len() int {
	if o == nil {
		return 0
	}
	return len(o.Keys)
}

// Copy is a shallow copy.
func (o *OMap) Copy() *OMap {
	c := NewMap()
	if o != nil {
		for _, k := range o.Keys {
			c.Set(k, o.M[k])
		}
	}
	return c
}

// Obj builds an OMap from alternating key, value arguments.
func Obj(kv ...any) *OMap {
	o := NewMap()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// Parse decodes one JSON document (Python json.loads: trailing data is an error).
func Parse(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := read(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("extra data")
	}
	return v, nil
}

func read(dec *json.Decoder) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := NewMap()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := read(dec)
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			a := []any{}
			for dec.More() {
				v, err := read(dec)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return a, nil
		}
		return nil, errors.New("unexpected delimiter")
	case json.Number:
		s := x.String()
		if strings.ContainsAny(s, ".eE") {
			f, err := strconv.ParseFloat(s, 64)
			if err != nil && !math.IsInf(f, 0) {
				return nil, err
			}
			return f, nil
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n, nil
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f, nil
	default:
		return t, nil // string, bool, nil
	}
}

// Opts of Dumps.
type Opts struct {
	EnsureASCII bool // json.dumps default is True
	SortKeys    bool
}

// Dumps renders like Python's json.dumps(v, ensure_ascii=..., sort_keys=...).
func Dumps(v any, o Opts) string {
	var b strings.Builder
	dump(&b, v, o)
	return b.String()
}

// DumpsDefault is json.dumps(v).
func DumpsDefault(v any) string { return Dumps(v, Opts{EnsureASCII: true}) }

func dump(b *strings.Builder, v any, o Opts) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case float64:
		b.WriteString(FloatRepr(x))
	case string:
		quote(b, x, o.EnsureASCII)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteString(", ")
			}
			dump(b, e, o)
		}
		b.WriteByte(']')
	case []string:
		a := make([]any, len(x))
		for i, s := range x {
			a[i] = s
		}
		dump(b, a, o)
	case *OMap:
		b.WriteByte('{')
		keys := x.Keys
		if o.SortKeys {
			keys = append([]string(nil), keys...)
			sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		}
		for i, k := range keys {
			if i > 0 {
				b.WriteString(", ")
			}
			quote(b, k, o.EnsureASCII)
			b.WriteString(": ")
			dump(b, x.M[k], o)
		}
		b.WriteByte('}')
	case map[string]any:
		m := NewMap()
		ks := make([]string, 0, len(x))
		for k := range x {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			m.Set(k, x[k])
		}
		dump(b, m, o)
	default:
		panic(fmt.Sprintf("pyjson: cannot dump %T", v))
	}
}

// lessUTF16 orders strings by UTF-16 code units like Python's str comparison on code points does for
// the BMP (code point order); Python compares code points, so compare runes.
func lessUTF16(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ra[i] != rb[i] {
			return ra[i] < rb[i]
		}
	}
	return len(ra) < len(rb)
}

func quote(b *strings.Builder, s string, ascii bool) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			// invalid UTF-8 cannot come from a Python str; keep it visible
			fmt.Fprintf(b, "\\u%04x", s[i])
			i++
			continue
		}
		i += size
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(b, "\\u%04x", r)
			case ascii && (r > 0x7e):
				if r >= 0x10000 {
					r -= 0x10000
					fmt.Fprintf(b, "\\u%04x\\u%04x", 0xd800+(r>>10), 0xdc00+(r&0x3ff))
				} else {
					fmt.Fprintf(b, "\\u%04x", r)
				}
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// FloatRepr is Python's repr(float).
func FloatRepr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		if math.Signbit(f) {
			return "-0.0"
		}
		return "0.0"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde+XX
	neg := strings.HasPrefix(e, "-")
	e = strings.TrimPrefix(e, "-")
	mant, expS, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expS)
	digits := strings.Replace(mant, ".", "", 1)
	var out string
	if exp < -4 || exp >= 16 {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		sign := "+"
		if exp < 0 {
			sign = "-"
			exp = -exp
		}
		out = fmt.Sprintf("%se%s%02d", m, sign, exp)
	} else if exp >= 0 {
		if len(digits) <= exp+1 {
			out = digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
		} else {
			out = digits[:exp+1] + "." + digits[exp+1:]
		}
	} else {
		out = "0." + strings.Repeat("0", -exp-1) + digits
	}
	if neg {
		out = "-" + out
	}
	return out
}

// ---- typed accessors over parsed values ----

// AsMap returns the object or nil.
func AsMap(v any) *OMap { m, _ := v.(*OMap); return m }

// AsList returns the array or nil.
func AsList(v any) []any { l, _ := v.([]any); return l }

// AsString returns the string and whether v is one.
func AsString(v any) (string, bool) { s, ok := v.(string); return s, ok }

// AsNum returns a number (int or float, not bool) as float64.
func AsNum(v any) (float64, bool) {
	switch x := v.(type) {
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// Truthy is Python truthiness.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case int64:
		return x != 0
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case *OMap:
		return x.Len() > 0
	}
	return true
}

// Path walks nested objects: Path(v, "a", "b") is v["a"]["b"], nil when any step is missing or not an object.
func Path(v any, keys ...string) any {
	for _, k := range keys {
		m := AsMap(v)
		if m == nil {
			return nil
		}
		v = m.M[k]
	}
	return v
}
