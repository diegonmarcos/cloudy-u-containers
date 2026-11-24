package fleetauth

import (
	"math/big"
	"testing"
)

func TestFlaskJSON(t *testing.T) {
	got := string(FlaskJSON(map[string]any{
		"b": []any{int64(1), "é<>&\u007f", nil, true},
		"a": map[string]any{"z": 1, "y": "\U0001F600"},
		"c": new(big.Int).Lsh(big.NewInt(1), 70),
	}))
	want := `{"a":{"y":"😀","z":1},"b":[1,"é<>&\u007f",null,true],"c":1180591620717411303424}` + "\n"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestPyHelpers(t *testing.T) {
	if f := PyFields("a b\x1fc  d"); len(f) != 4 {
		t.Fatalf("PyFields %q", f)
	}
	if CPTail("ab\U0001F600cd", 3) != "\U0001F600cd" || CPHead("ab\U0001F600cd", 3) != "ab\U0001F600" || CPLen("a\U0001F600") != 2 {
		t.Fatal("code point slicing")
	}
	if !IsASCIIDigits("0123") || IsASCIIDigits("") || IsASCIIDigits("12a") {
		t.Fatal("IsASCIIDigits")
	}
}
