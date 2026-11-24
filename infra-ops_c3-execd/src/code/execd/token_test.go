package execd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestResolveToken(t *testing.T) {
	d := t.TempDir()
	f := filepath.Join(d, "run", "token")
	rd, wr, mk, rnd := os.ReadFile, os.WriteFile, os.MkdirAll, func(b []byte) (int, error) {
		for i := range b {
			b[i] = byte(i + 1)
		}
		return len(b), nil
	}
	if _, err := ResolveToken(envOf(nil), rd, wr, mk, rnd); err == nil {
		t.Fatal("no token configuration must refuse to start")
	}
	if tok, err := ResolveToken(envOf(map[string]string{"EXECD_TOKEN": " abc "}), rd, wr, mk, rnd); err != nil || tok != "abc" {
		t.Fatalf("%q %v", tok, err)
	}
	tok, err := ResolveToken(envOf(map[string]string{"EXECD_TOKEN_FILE": f}), rd, wr, mk, rnd)
	if err != nil || len(tok) != 64 {
		t.Fatalf("generated token: %q %v", tok, err)
	}
	st, err := os.Stat(f)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode: %v %v", st, err)
	}
	if ds, _ := os.Stat(filepath.Dir(f)); ds.Mode().Perm() != 0o700 {
		t.Fatalf("token dir mode %v", ds.Mode())
	}
	again, _ := ResolveToken(envOf(map[string]string{"EXECD_TOKEN_FILE": f}), rd, wr, mk, func([]byte) (int, error) { t.Fatal("must reuse the file, not regenerate"); return 0, nil })
	if again != tok {
		t.Fatal("token must be stable across restarts")
	}
	os.WriteFile(f, []byte("short"), 0o600)
	if re, _ := ResolveToken(envOf(map[string]string{"EXECD_TOKEN_FILE": f}), rd, wr, mk, rnd); re == "short" || strings.TrimSpace(re) == "" {
		t.Fatalf("a too-short file must be replaced, got %q", re)
	}
}
