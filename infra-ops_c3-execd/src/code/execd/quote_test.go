package execd

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

var quoteVectors = []string{
	"", "plain", "with space", "it's", "a\\b", "'", "\\", "''", `\'`, `'\'`, "a'b'c", `x\'y\\z`,
	"$(rm -rf /)", "`id`", "a;b|c&d", "line\nbreak", "tab\there", `"dq"`, "ünï©ode", "*?[x]", "-n", "--",
	"SELECT inbox_total='x' || COUNT(*) FROM t", "echo '  <-- NO MAIL'",
}

// Parity with the real shell-quote.ts, evaluated by Node.
func TestQuoteParityWithTS(t *testing.T) {
	in, _ := json.Marshal(quoteVectors)
	out := node(t, `
import { anyShellQuote, posixQuote, remoteShellWrap, dockerExecShell } from `+jsStr("file://"+repoFile(t, "infra-api_cloudy-c3-api/src/code/shared/libs/shell-quote.ts"))+`;
const v = JSON.parse(process.env.IN);
console.log(JSON.stringify(v.map(s => [anyShellQuote(s), posixQuote(s), remoteShellWrap(s), dockerExecShell("c1", s)])));`, string(in))
	var want [][]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &want); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for i, s := range quoteVectors {
		got := []string{AnyShellQuote(s), PosixQuote(s), RemoteShellWrap(s), DockerExecShell("c1", s)}
		for j := range got {
			if got[j] != want[i][j] {
				t.Errorf("vector %d fn %d %q: go %q ts %q", i, j, s, got[j], want[i][j])
			}
		}
	}
}

func jsStr(s string) string { b, _ := json.Marshal(s); return string(b) }

// Round trip through real POSIX shells: quoting must yield the original word.
func TestQuoteRoundTripShells(t *testing.T) {
	for _, sh := range []string{"sh", "bash"} {
		for _, s := range quoteVectors {
			for name, q := range map[string]func(string) string{"any": AnyShellQuote, "posix": PosixQuote} {
				out, err := exec.Command(sh, "-c", "printf %s "+q(s)).Output()
				if err != nil || string(out) != s {
					t.Errorf("%s/%s %q: got %q err %v", sh, name, s, out, err)
				}
			}
		}
	}
}

// Mutation proof: the round-trip check goes red for the classic broken quoter (POSIX
// escaping used where the fish-safe one is required fails the TS-parity vectors).
func TestQuoteMutantIsCaught(t *testing.T) {
	mutant := func(v string) string { return "'" + strings.ReplaceAll(v, "'", `\'`) + "'" }
	bad := 0
	for _, s := range quoteVectors {
		out, _ := exec.Command("sh", "-c", "printf %s "+mutant(s)).Output()
		if string(out) != s {
			bad++
		}
	}
	if bad == 0 {
		t.Fatal("mutant quoter survived the round-trip vectors")
	}
}

func jsArr(v []string) string               { b, _ := json.Marshal(v); return string(b) }
func jsonUnmarshal(out string, v any) error { return json.Unmarshal([]byte(strings.TrimSpace(out)), v) }
