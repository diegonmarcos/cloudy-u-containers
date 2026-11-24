package execd

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// repoFile resolves a path relative to the cloudy-u-containers root from this test file.
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	_, f, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(f), "../../../..", rel)
}

// node runs script (an ES module body) with Node's native TypeScript stripping and returns
// stdout. Parity tests FAIL, not skip, when node is absent: they run in the per-service
// workflow where Node 24 is installed.
func node(t *testing.T, script string, in string) string {
	t.Helper()
	p, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node is required for the parity tests: %v", err)
	}
	cmd := exec.Command(p, "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script)
	cmd.Env = append(os.Environ(), "NODE_NO_WARNINGS=1", "IN="+in)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	return string(out)
}
