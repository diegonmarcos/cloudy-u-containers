package fleetauth

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// Docker builds use one service directory as their context, so every service carries a byte-identical copy of this
// package in src/code/fleetauth. A drifted copy of a security-critical package fails the build: edit here, then copy.
func TestCopiesAreIdentical(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	copies, _ := filepath.Glob(filepath.Join(root, "*", "src", "code", "fleetauth"))
	if len(copies) == 0 {
		t.Fatal("no service copies found: the glob is wrong")
	}
	files, _ := filepath.Glob("*.go")
	var names []string
	for _, f := range files {
		if f != "copies_test.go" {
			names = append(names, f)
		}
	}
	sort.Strings(names)
	for _, dir := range copies {
		have, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		if len(have) != len(names) {
			t.Errorf("%s: %d files, shared package has %d", dir, len(have), len(names))
		}
		for _, f := range names {
			want, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(dir, f))
			if err != nil {
				t.Errorf("%s: %v", dir, err)
				continue
			}
			if string(got) != string(want) {
				t.Errorf("%s/%s differs from _shared/go/fleetauth/%s: copy it, never edit the copy", dir, f, f)
			}
		}
	}
	t.Log(fmt.Sprintf("%d copies checked", len(copies)))
}
