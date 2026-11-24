package pyjson

import (
	"strings"
	"testing"
)

func TestRoundTripKeepsOrderAndPythonFormat(t *testing.T) {
	in := `{"z": 1, "a": [1, 2.50, {"k": "é☃😀"}], "m": {}, "e": [], "n": null, "t": true, "f": 1e20, "neg": -0, "x": 0.00001}`
	v, err := Loads([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"z\": 1,\n  \"a\": [\n    1,\n    2.5,\n    {\n      \"k\": \"\\u00e9\\u2603\\ud83d\\ude00\"\n    }\n  ],\n  \"m\": {},\n  \"e\": [],\n  \"n\": null,\n  \"t\": true,\n  \"f\": 1e+20,\n  \"neg\": 0,\n  \"x\": 1e-05\n}"
	if got := Dumps(v, 2); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if got := Dumps(v, -1); !strings.HasPrefix(got, `{"z": 1, "a": [1, 2.5, {"k": `) {
		t.Fatalf("compact form %s", got)
	}
}

func TestDuplicateKeysLastWinsFirstPosition(t *testing.T) {
	v, _ := Loads([]byte(`{"a":1,"b":2,"a":3}`))
	if got := Dumps(v, -1); got != `{"a": 3, "b": 2}` {
		t.Fatal(got)
	}
}

func TestFloatRepr(t *testing.T) {
	for f, want := range map[float64]string{1: "1.0", 0.5: "0.5", 1e16: "1e+16", 123456789012345.0: "123456789012345.0", 1e-4: "0.0001", 1.5e-7: "1.5e-07", -2.25: "-2.25"} {
		if got := FloatRepr(f); got != want {
			t.Errorf("%v -> %s want %s", f, got, want)
		}
	}
}

func TestRejectsTrailingData(t *testing.T) {
	if _, err := Loads([]byte(`{} {}`)); err == nil {
		t.Fatal("extra data must fail like json.loads")
	}
}
