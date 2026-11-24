// Package ojson parses JSON keeping object key order and writes it back the way JavaScript's JSON.stringify
// does (no HTML escaping, U+2028/2029 raw, JS number formatting, duplicate keys last-wins at the first position).
// The Node services build responses with JSON.parse/JSON.stringify and spread, so byte-identical bodies need an
// order-preserving round trip, which encoding/json maps cannot give. Canonical copy: _shared/go/ojson; each service
// carries a byte-identical copy in src/code/internal/ojson (guarded by TestCopiesAreIdentical).
package ojson

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Obj is an insertion-ordered JSON object.
type Obj struct {
	Keys []string
	Vals map[string]any
}

// NewObj returns an empty object.
func NewObj() *Obj { return &Obj{Vals: map[string]any{}} }

// Set adds or replaces a key (an existing key keeps its position, like a JS object).
func (o *Obj) Set(k string, v any) *Obj {
	if _, ok := o.Vals[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.Vals[k] = v
	return o
}

// Get returns the value of a key.
func (o *Obj) Get(k string) (any, bool) { v, ok := o.Vals[k]; return v, ok }

// Delete removes a key.
func (o *Obj) Delete(k string) {
	if _, ok := o.Vals[k]; !ok {
		return
	}
	delete(o.Vals, k)
	for i, kk := range o.Keys {
		if kk == k {
			o.Keys = append(o.Keys[:i:i], o.Keys[i+1:]...)
			break
		}
	}
}

// Clone copies the object shallowly (the JS spread).
func (o *Obj) Clone() *Obj {
	c := NewObj()
	for _, k := range o.Keys {
		c.Set(k, o.Vals[k])
	}
	return c
}

// Num is a JSON number kept as float64, like JS.
type Num float64

// Parse decodes one JSON value; trailing non-space input is an error (JSON.parse).
func Parse(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing data")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch tt := t.(type) {
	case json.Delim:
		switch tt {
		case '{':
			o := NewObj()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k := kt.(string)
				v, err := parseValue(dec)
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
			arr := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, errors.New("unexpected delimiter")
	case json.Number:
		f, err := strconv.ParseFloat(string(tt), 64)
		if err != nil && !math.IsInf(f, 0) {
			return nil, err
		}
		return Num(f), nil
	default:
		return t, nil // string, bool, nil
	}
}

// Marshal writes v the way JSON.stringify does. Accepted: *Obj, []any, string, Num, float64, int, bool, nil,
// and Undefined (the member is omitted from an object).
func Marshal(v any) []byte {
	var b bytes.Buffer
	write(&b, v)
	return b.Bytes()
}

// Undefined marks an object member that JSON.stringify would drop.
type Undefined struct{}

func write(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(b, t)
	case Num:
		b.WriteString(FormatNumber(float64(t)))
	case float64:
		b.WriteString(FormatNumber(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case []any:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if _, u := e.(Undefined); u {
				b.WriteString("null")
				continue
			}
			write(b, e)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, e)
		}
		b.WriteByte(']')
	case *Obj:
		b.WriteByte('{')
		first := true
		for _, k := range t.Keys {
			val := t.Vals[k]
			if _, u := val.(Undefined); u {
				continue
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			writeString(b, k)
			b.WriteByte(':')
			write(b, val)
		}
		b.WriteByte('}')
	default:
		panic("ojson: unsupported type")
	}
}

const hexd = "0123456789abcdef"

func writeString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if c < 0x20 {
					b.WriteString(`\u00`)
					b.WriteByte(hexd[c>>4])
					b.WriteByte(hexd[c&0xF])
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteString(`\ufffd`) // JS strings are UTF-16; an invalid byte has already become U+FFFD upstream
			i++
			continue
		}
		b.WriteString(s[i : i+size])
		i += size
	}
	b.WriteByte('"')
}

// FormatNumber is Number.prototype.toString for finite doubles (ECMAScript Number::toString); NaN/Inf are null in JSON.
func FormatNumber(x float64) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return "null"
	}
	if x == 0 {
		return "0"
	}
	neg := x < 0
	if neg {
		x = -x
	}
	e := strconv.FormatFloat(x, 'e', -1, 64) // d[.ddd]e±XX
	mant, expS, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp10, _ := strconv.Atoi(expS)
	k := len(digits)
	n := exp10 + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		sign := "+"
		m := n - 1
		if m < 0 {
			sign = "-"
			m = -m
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(m)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(m)
		}
	}
	if neg {
		return "-" + out
	}
	return out
}

// ReplaceInvalidUTF8 mimics Buffer.toString('utf8') / readFileSync(.., 'utf8'): every invalid byte becomes U+FFFD.
func ReplaceInvalidUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size == 1 {
			sb.WriteRune(utf8.RuneError)
		} else {
			sb.Write(b[i : i+size])
		}
		i += size
	}
	return sb.String()
}
