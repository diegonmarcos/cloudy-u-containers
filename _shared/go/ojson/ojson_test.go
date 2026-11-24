package ojson

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTripMatchesJS(t *testing.T) {
	cases := map[string]string{
		`{"b":1,"a":[1,2.5,{"z":null,"y":true}],"c":"x"}`:                        `{"b":1,"a":[1,2.5,{"z":null,"y":true}],"c":"x"}`,
		` { "a" : 1.0 , "b" : 1e3 , "c": 1E-7, "d": 100000000000000000000000 } `: `{"a":1,"b":1000,"c":1e-7,"d":1e+23}`,
		`{"a":1,"a":2,"b":3}`:                                `{"a":2,"b":3}`,
		`{"s":"<a>&\u2014 \u2028 \u007f \u0001 \" \\ /"}`:    "{\"s\":\"<a>&\u2014 \u2028 \u007f \\u0001 \\\" \\\\ /\"}",
		`[0,-0,0.1,123456789012,1.5e300,0.000001,0.0000001]`: `[0,0,0.1,123456789012,1.5e+300,0.000001,1e-7]`,
		`[]`: `[]`, `{}`: `{}`, `"é"`: `"é"`,
	}
	for in, want := range cases {
		v, err := Parse([]byte(in))
		if err != nil {
			t.Errorf("%s: %v", in, err)
			continue
		}
		if got := string(Marshal(v)); got != want {
			t.Errorf("%s:\n got  %s\n want %s", in, got, want)
		}
	}
	for _, bad := range []string{`{"a":}`, `[1,]`, `{"a":1} x`, "\ufeff{}", ``, `{'a':1}`} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%q must not parse", bad)
		}
	}
}

func TestObjOps(t *testing.T) {
	o := NewObj().Set("a", Num(1)).Set("b", "x").Set("a", Num(2))
	c := o.Clone().Set("b", Undefined{})
	o.Delete("a")
	if string(Marshal(o)) != `{"b":"x"}` || string(Marshal(c)) != `{"a":2}` {
		t.Errorf("%s %s", Marshal(o), Marshal(c))
	}
}

func TestInvalidUTF8(t *testing.T) {
	if ReplaceInvalidUTF8([]byte("a\xffb\xc3")) != "a\ufffdb\ufffd" {
		t.Error("each invalid byte becomes U+FFFD")
	}
}

// Every service carries a byte-identical copy of this package in src/code/internal/ojson.
func TestCopiesAreIdentical(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	copies, _ := filepath.Glob(filepath.Join(root, "*", "src", "code", "internal", "ojson"))
	want, err := os.ReadFile("ojson.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range copies {
		got, err := os.ReadFile(filepath.Join(dir, "ojson.go"))
		if err != nil || string(got) != string(want) {
			t.Errorf("%s/ojson.go differs from _shared/go/ojson/ojson.go (copy it, never edit the copy): %v", dir, err)
		}
	}
	t.Logf("%d copies checked", len(copies))
}
