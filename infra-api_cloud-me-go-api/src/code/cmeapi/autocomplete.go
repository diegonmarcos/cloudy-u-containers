package cmeapi

import (
	"unicode/utf16"

	"cloudme-api/internal/ojson"
)

// The Autocomplete document Cloud Account syncs into Cloud Keyboard (#1103): only the four pages, only string label/value,
// blanks dropped, capped. Wire shape: {"v":1,"ids":[{"label","value"}],"addresses":[...],"urls":[...],"secrets":[...]}.
var acPages = []string{"ids", "addresses", "urls", "secrets"}

const (
	acMaxPerPage = 500
	acMaxField   = 4096
)

// jsSlice mirrors String.prototype.slice(0, n) on UTF-16 code units.
func jsSlice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// NormalizeAutocomplete returns nil when the text is not a JSON object.
func NormalizeAutocomplete(text string) *ojson.Obj {
	v, err := ojson.Parse([]byte(text))
	if err != nil {
		return nil
	}
	src, ok := v.(*ojson.Obj)
	if !ok {
		return nil
	}
	out := ojson.NewObj().Set("v", ojson.Num(1))
	for _, page := range acPages {
		rows := []any{}
		if raw, has := src.Get(page); has {
			if arr, isArr := raw.([]any); isArr {
				if len(arr) > acMaxPerPage {
					arr = arr[:acMaxPerPage]
				}
				for _, r := range arr {
					o, isObj := r.(*ojson.Obj)
					if !isObj {
						continue
					}
					val, isStr := o.Vals["value"].(string)
					if !isStr || jsTrim(val) == "" {
						continue
					}
					label := ""
					if l, isS := o.Vals["label"].(string); isS {
						label = jsSlice(jsTrim(l), 200)
					}
					rows = append(rows, ojson.NewObj().Set("label", label).Set("value", jsSlice(val, acMaxField)))
				}
			}
		}
		out.Set(page, rows)
	}
	return out
}

// EmptyAutocomplete is the document for "nothing entered yet": a state, not an error.
func EmptyAutocomplete() *ojson.Obj {
	o := ojson.NewObj().Set("v", ojson.Num(1))
	for _, p := range acPages {
		o.Set(p, []any{})
	}
	return o
}
