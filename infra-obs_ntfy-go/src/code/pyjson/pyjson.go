// Package pyjson reproduces the parts of Python's json module the ntfy sidecars rely on for byte-identical output:
// insertion-ordered objects (json.loads keeps file order, a Go map does not), json.dumps with ensure_ascii=True,
// default separators (", " / ": ") or indent=N, and Python's float repr.
package pyjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// OMap is a JSON object that remembers key order (duplicate keys: last value wins, first position kept, as in Python).
type OMap struct {
	Keys []string
	Vals map[string]any
}

// NewOMap returns an empty ordered object.
func NewOMap() *OMap { return &OMap{Vals: map[string]any{}} }

// Set stores a value, appending the key when new.
func (m *OMap) Set(k string, v any) {
	if _, ok := m.Vals[k]; !ok {
		m.Keys = append(m.Keys, k)
	}
	m.Vals[k] = v
}

// Get returns the value for k.
func (m *OMap) Get(k string) (any, bool) {
	v, ok := m.Vals[k]
	return v, ok
}

// Loads parses JSON into *OMap / []any / string / json.Number / bool / nil.
func Loads(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("extra data after JSON value")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			m := NewOMap()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("non-string key")
				}
				v, err := readValue(dec)
				if err != nil {
					return nil, err
				}
				m.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return m, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := readValue(dec)
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
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

// Dumps renders like json.dumps(v, indent=indent) with ensure_ascii. indent < 0 means the default compact form.
func Dumps(v any, indent int) string {
	var sb strings.Builder
	write(&sb, v, indent, 0)
	return sb.String()
}

func write(sb *strings.Builder, v any, indent, level int) {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case string:
		writeString(sb, t)
	case json.Number:
		sb.WriteString(numberRepr(string(t)))
	case int:
		sb.WriteString(strconv.Itoa(t))
	case int64:
		sb.WriteString(strconv.FormatInt(t, 10))
	case float64:
		sb.WriteString(FloatRepr(t))
	case []any:
		if len(t) == 0 {
			sb.WriteString("[]")
			return
		}
		sb.WriteString("[")
		for i, e := range t {
			sepItem(sb, i, indent, level+1)
			write(sb, e, indent, level+1)
		}
		closeBlock(sb, indent, level)
		sb.WriteString("]")
	case []string:
		a := make([]any, len(t))
		for i, s := range t {
			a[i] = s
		}
		write(sb, a, indent, level)
	case *OMap:
		if len(t.Keys) == 0 {
			sb.WriteString("{}")
			return
		}
		sb.WriteString("{")
		for i, k := range t.Keys {
			sepItem(sb, i, indent, level+1)
			writeString(sb, k)
			sb.WriteString(": ")
			write(sb, t.Vals[k], indent, level+1)
		}
		closeBlock(sb, indent, level)
		sb.WriteString("}")
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		om := NewOMap()
		for _, k := range keys {
			om.Set(k, t[k])
		}
		write(sb, om, indent, level)
	default:
		sb.WriteString("null")
	}
}

func sepItem(sb *strings.Builder, i, indent, level int) {
	if indent < 0 {
		if i > 0 {
			sb.WriteString(", ")
		}
		return
	}
	if i > 0 {
		sb.WriteString(",")
	}
	sb.WriteString("\n")
	sb.WriteString(strings.Repeat(" ", indent*level))
}

func closeBlock(sb *strings.Builder, indent, level int) {
	if indent < 0 {
		return
	}
	sb.WriteString("\n")
	sb.WriteString(strings.Repeat(" ", indent*level))
}

func writeString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
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
			case r < 0x20:
				fmt.Fprintf(sb, `\u%04x`, r)
			case r < 0x7f || r == 0x7f:
				sb.WriteRune(r)
			case r >= 0x10000:
				r -= 0x10000
				fmt.Fprintf(sb, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
			default:
				fmt.Fprintf(sb, `\u%04x`, r)
			}
		}
	}
	sb.WriteByte('"')
}

// numberRepr normalises a JSON number literal the way json.loads + json.dumps would.
func numberRepr(s string) string {
	if strings.ContainsAny(s, ".eE") {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return s
		}
		return FloatRepr(f)
	}
	if s == "-0" {
		return "0"
	}
	return s
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
	}
	if f == 0 {
		if math.Signbit(f) {
			return "-0.0"
		}
		return "0.0"
	}
	abs := math.Abs(f)
	if abs >= 1e-4 && abs < 1e16 {
		s := strconv.FormatFloat(f, 'f', -1, 64)
		if !strings.Contains(s, ".") {
			s += ".0"
		}
		return s
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // 1e+16, 1.5e-05
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	digits := strings.TrimLeft(exp[1:], "0")
	for len(digits) < 2 {
		digits = "0" + digits
	}
	return mant + "e" + string(sign) + digits
}
