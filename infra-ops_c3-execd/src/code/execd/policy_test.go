package execd

import "testing"

func TestCheckCommand(t *testing.T) {
	for _, ok := range []string{"gh", "ssh", "docker", "gcloud", "bash", "sh", "curl", "terraform", "oci", "aws", "bq", "dig", "ping", "ssh-keyscan"} {
		if err := CheckCommand(ok); err != nil {
			t.Errorf("%s should be allowed: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "rm", "/bin/sh", "./sh", "../sh", "sh -c id", "sh\n", "python3", "nc", "dd", "sudo", "mount", "SH", "sh\x00"} {
		if err := CheckCommand(bad); err == nil {
			t.Errorf("%q must be denied", bad)
		}
	}
}

func TestValidators(t *testing.T) {
	for _, ok := range []string{"caddy", "my_c-1.x"} {
		if ValidateName("container name", ok) != nil {
			t.Errorf("%s", ok)
		}
	}
	for _, bad := range []string{"", "a b", "a/b", "a;b", "$(x)", "a\n", "../x"} {
		if ValidateName("container name", bad) == nil {
			t.Errorf("%q", bad)
		}
	}
	for _, ok := range []string{"1h", "30m", "2d", "10s", "2024-01-01", "2024-01-01T10:20:30"} {
		if ValidateSince(ok) != nil {
			t.Errorf("%s", ok)
		}
	}
	for _, bad := range []string{"", "1w", "h", "2024-1-1", "1h; id", "2024-01-01T10:20"} {
		if ValidateSince(bad) == nil {
			t.Errorf("%q", bad)
		}
	}
}

// Parity with validators.ts: same accept/reject answers on the same inputs.
func TestValidatorParityWithTS(t *testing.T) {
	names := []string{"", "a", "a b", "a/b", "ok_1.2-x", "$(x)", "a\n", "é"}
	sinces := []string{"", "1h", "1w", "2024-01-01", "2024-01-01T01:02:03", "2024-01-01T01:02", "5d; id"}
	out := node(t, `
import * as v from `+jsStr("file://"+repoFile(t, "infra-api_cloudy-c3-api/src/code/shared/libs/validators.ts"))+`;
const ok = (f, x) => { try { f(x); return true; } catch { return false; } };
const names = `+jsArr(names)+`, sinces = `+jsArr(sinces)+`;
console.log(JSON.stringify([names.map(n => ok(v.validateContainerName, n)), sinces.map(s => ok(v.validateSince, s))]));`, "")
	var want [2][]bool
	if err := jsonUnmarshal(out, &want); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for i, n := range names {
		if got := ValidateName("container name", n) == nil; got != want[0][i] {
			t.Errorf("name %q go=%v ts=%v", n, got, want[0][i])
		}
	}
	for i, s := range sinces {
		if got := ValidateSince(s) == nil; got != want[1][i] {
			t.Errorf("since %q go=%v ts=%v", s, got, want[1][i])
		}
	}
}

// Mutation proof for the allowlist: dropping the path check lets "/bin/sh" through, and the
// table above would then fail; here the mutant is evaluated directly.
func TestCheckCommandMutantCaught(t *testing.T) {
	mutant := func(c string) bool { return AllowedCommands[c] } // no bare-name check
	AllowedCommands["/bin/sh"] = true
	defer delete(AllowedCommands, "/bin/sh")
	if !mutant("/bin/sh") || CheckCommand("/bin/sh") == nil {
		t.Fatal("the bare-name check is not doing its job")
	}
}
