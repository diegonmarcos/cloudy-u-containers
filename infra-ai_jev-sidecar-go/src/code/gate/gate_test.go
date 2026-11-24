package gate

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"jev-gate/pyjson"
)

func TestEmbeddedConfigIsTheSharedDeclaration(t *testing.T) {
	want, err := os.ReadFile("../../../../_shared/jev-gate/jev-gate.json")
	if err != nil {
		t.Fatalf("shared declaration unreadable: %v", err)
	}
	if !bytes.Equal(want, embeddedConfig) {
		t.Fatal("src/code/gate/jev-gate.json drifted from _shared/jev-gate/jev-gate.json: copy it over")
	}
}

func TestPyJSONMatchesPythonFormatting(t *testing.T) {
	v, err := pyjson.Parse([]byte(`{"b": 1, "a": [1.0, 2.50, 1e-7, 1e16, 123456789012345678, true, null, "é\u0001\"\\ \ud83d\ude00"], "c": {"z": 0.1, "y": -0.0}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := pyjson.DumpsDefault(v)
	want := `{"b": 1, "a": [1.0, 2.5, 1e-07, 1e+16, 123456789012345678, true, null, "\u00e9\u0001\"\\ \ud83d\ude00"], "c": {"z": 0.1, "y": -0.0}}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if s := pyjson.Dumps(v, pyjson.Opts{SortKeys: true}); !strings.HasPrefix(s, `{"a": [1.0`) {
		t.Fatalf("sort_keys: %s", s)
	}
	if s := pyjson.Dumps("é😀\x7f", pyjson.Opts{}); s != "\"é😀\x7f\"" {
		t.Fatalf("ensure_ascii=False: %q", s)
	}
	if s := pyjson.DumpsDefault("\x7f"); s != `"\u007f"` {
		t.Fatalf("0x7f: %s", s)
	}
}

func TestFloatRepr(t *testing.T) {
	for in, want := range map[float64]string{0.5: "0.5", 100: "100.0", 1e22: "1e+22", 1.5e-5: "1.5e-05", 0.0001: "0.0001", 123456.789: "123456.789", 1e15: "1000000000000000.0", 1e16: "1e+16", -2.25: "-2.25"} {
		if got := pyjson.FloatRepr(in); got != want {
			t.Errorf("FloatRepr(%v) = %s want %s", in, got, want)
		}
	}
}

func TestShlexSplit(t *testing.T) {
	got, err := shlexSplit(`cat "a b/c.txt" 'd e' f\ g -x "q\"r" '' h`)
	want := []string{"cat", "a b/c.txt", "d e", "f g", "-x", `q"r`, "", "h"}
	if err != nil || strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q err %v", got, err)
	}
	if _, err := shlexSplit(`echo "unterminated`); err == nil {
		t.Fatal("unterminated quote must fail")
	}
	if _, err := shlexSplit(`echo trailing\`); err == nil {
		t.Fatal("trailing backslash must fail")
	}
}

func TestPythonRegexDialect(t *testing.T) {
	hit, err := searchRE(`^rm\s+(-\S*[rRf]\S*\s+)+`, "rm\u00a0-rf /")
	if err != nil || !hit {
		t.Fatalf("\\s must match NBSP like Python's re: %v %v", hit, err)
	}
	out, err := subRE(`(?i)(authorization\s*:\s*(bearer|basic|token)\s+)\S+`, `\1[REDACTED]`, "Authorization: Bearer abc123")
	if err != nil || out != "Authorization: Bearer [REDACTED]" {
		t.Fatalf("got %q %v", out, err)
	}
	out, _ = subRE(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)`, "[REDACTED]", "x -----BEGIN RSA PRIVATE KEY-----\nabc\ndef")
	if out != "x [REDACTED]" {
		t.Fatalf("got %q", out)
	}
}

func TestMiniYAML(t *testing.T) {
	m := MiniYAML("extensions:\n  a:\n    enabled: true # c\n    uri: 'http://x/mcp'\n    list:\n      - skipped\n  b:\n    uri: http://y\n")
	if pyjson.DumpsDefault(m) != `{"extensions": {"a": {"enabled": "true", "uri": "http://x/mcp", "list": {}}, "b": {"uri": "http://y"}}}` {
		t.Fatalf("got %s", pyjson.DumpsDefault(m))
	}
}

func TestRedactMasksEnvSecrets(t *testing.T) {
	cfg, err := LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DEPLOY_TOKEN", "zq9-very-secret-value-4455")
	got := Redact("x zq9-very-secret-value-4455 y ghp_abcdefghijklmnopqrstuvwxyz z", cfg)
	if strings.Contains(got, "zq9-very") || strings.Contains(got, "ghp_abc") {
		t.Fatalf("secret leaked: %s", got)
	}
}
