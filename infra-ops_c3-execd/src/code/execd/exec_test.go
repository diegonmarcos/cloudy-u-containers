package execd

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRunBasics(t *testing.T) {
	r := Run(context.Background(), Request{Command: "sh", Args: []string{"-c", "echo hi; echo err >&2; exit 3"}})
	if r.Stdout != "hi\n" || r.Stderr != "err\n" || r.ExitCode != 3 || r.OK || r.TimedOut {
		t.Fatalf("%+v", r)
	}
	if r := Run(context.Background(), Request{Command: "true"}); !r.OK || r.ExitCode != 0 {
		t.Fatalf("%+v", r)
	}
	if r := Run(context.Background(), Request{Command: "cat", Input: "secret-in-stdin"}); r.Stdout != "secret-in-stdin" {
		t.Fatalf("%+v", r)
	}
}

func TestRunTimeoutVersusExit124(t *testing.T) {
	t0 := time.Now()
	r := Run(context.Background(), Request{Command: "sh", Args: []string{"-c", "sleep 5"}, TimeoutMS: 200})
	if !r.TimedOut || r.OK || r.ExitCode != 1 || time.Since(t0) > 3*time.Second {
		t.Fatalf("%+v after %v", r, time.Since(t0))
	}
	if r := Run(context.Background(), Request{Command: "sh", Args: []string{"-c", "exit 124"}}); r.TimedOut || r.ExitCode != 124 {
		t.Fatalf("exit 124 must not count as our timeout: %+v", r)
	}
}

func TestRunOutputOverflow(t *testing.T) {
	r := Run(context.Background(), Request{Command: "sh", Args: []string{"-c", "head -c 12000000 /dev/zero"}, TimeoutMS: 20000})
	if r.OK || r.ExitCode != 1 || len(r.Stdout) > MaxBuffer {
		t.Fatalf("overflow: ok=%v exit=%d len=%d", r.OK, r.ExitCode, len(r.Stdout))
	}
}

func TestRunStartFailure(t *testing.T) {
	r := Run(context.Background(), Request{Command: "definitely-not-a-binary-xyz"})
	if r.OK || r.ExitCode != 1 || r.Stderr == "" {
		t.Fatalf("%+v", r)
	}
}

func TestExecEnvCloudCLIHome(t *testing.T) {
	base := []string{"HOME=/tmp/c3-home", "PATH=/bin"}
	has := func(env []string, kv string) bool {
		last := ""
		for _, e := range env {
			if strings.HasPrefix(e, "HOME=") {
				last = e
			}
		}
		return last == kv
	}
	for _, c := range []string{"gcloud", "bq", "gsutil", "oci", "aws", "az", "kubectl", "helm"} {
		if !has(ExecEnv(c, base, ""), "HOME=/root") {
			t.Errorf("%s must run with HOME=/root", c)
		}
	}
	if !has(ExecEnv("ssh", base, ""), "HOME=/tmp/c3-home") {
		t.Error("ssh keeps the scratch HOME")
	}
	if got := ExecEnv("sops", base, "/k"); got[len(got)-1] != "SOPS_AGE_KEY_FILE=/k" {
		t.Errorf("sops key file not passed: %v", got)
	}
}

// Parity with Node's spawnSync as exec.ts uses it (timeout, maxBuffer, status ?? 1,
// ETIMEDOUT => timedOut). The Node side runs the same commands; we compare the contract
// fields, and a mutation (timeout reported for exit 124) must differ.
func TestRunParityWithSpawnSync(t *testing.T) {
	type tc struct {
		Cmd     string
		Args    []string
		Timeout int
	}
	cases := []tc{
		{"sh", []string{"-c", "echo hi; echo err >&2; exit 3"}, 5000},
		{"sh", []string{"-c", "exit 124"}, 5000},
		{"sh", []string{"-c", "sleep 3"}, 300},
		{"true", nil, 5000},
		{"false", nil, 5000},
		{"definitely-not-a-binary-xyz", nil, 5000},
		{"sh", []string{"-c", "kill -9 $$"}, 5000},
	}
	in, _ := json.Marshal(cases)
	out := node(t, `
import { spawnSync } from "node:child_process";
const cases = JSON.parse(process.env.IN);
console.log(JSON.stringify(cases.map(c => {
  const r = spawnSync(c.Cmd, c.Args ?? [], { timeout: c.Timeout, encoding: "utf-8", maxBuffer: 10*1024*1024 });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? 1, ok: r.status === 0, timedOut: r.error?.code === "ETIMEDOUT" };
})));`, string(in))
	var want []Result
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &want); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for i, c := range cases {
		got := Run(context.Background(), Request{Command: c.Cmd, Args: c.Args, TimeoutMS: c.Timeout})
		if got.Stdout != want[i].Stdout || got.ExitCode != want[i].ExitCode || got.OK != want[i].OK || got.TimedOut != want[i].TimedOut {
			t.Errorf("case %d %v: go {%q exit=%d ok=%v to=%v} node {%q exit=%d ok=%v to=%v}", i, c,
				got.Stdout, got.ExitCode, got.OK, got.TimedOut, want[i].Stdout, want[i].ExitCode, want[i].OK, want[i].TimedOut)
		}
	}
	// mutation: a runner that reports every non-zero exit as a timeout must disagree with Node
	mut := Run(context.Background(), Request{Command: "sh", Args: []string{"-c", "exit 124"}})
	mut.TimedOut = !mut.OK
	if mut.TimedOut == want[1].TimedOut {
		t.Fatal("mutant not distinguishable from the reference")
	}
}
