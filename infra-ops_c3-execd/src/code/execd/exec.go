package execd

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// Result mirrors ExecResult in exec.ts (field for field).
type Result struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
	OK       bool   `json:"ok"`
	// TimedOut is true only when OUR timeout killed the child; a child that merely
	// exits 124 is not a timeout.
	TimedOut bool `json:"timedOut"`
}

const (
	// DefaultTimeout and MaxBuffer are exec.ts's defaults (30 s, 10 MiB).
	DefaultTimeout = 30 * time.Second
	MaxBuffer      = 10 * 1024 * 1024
)

// cloudCLIs read config from $HOME/.config/<tool>; exec.ts forces HOME=/root for them
// because the entrypoint points HOME at a writable scratch dir for ssh.
var cloudCLIs = map[string]bool{"gcloud": true, "bq": true, "gsutil": true, "oci": true, "aws": true, "az": true, "kubectl": true, "helm": true}

// ExecEnv is resolveExecEnv: the process env plus SOPS_AGE_KEY_FILE, HOME=/root for cloud CLIs.
func ExecEnv(command string, base []string, sopsKeyFile string) []string {
	env := append([]string{}, base...)
	if sopsKeyFile != "" {
		env = append(env, "SOPS_AGE_KEY_FILE="+sopsKeyFile)
	}
	if cloudCLIs[command] {
		env = append(env, "HOME=/root") // exec.Cmd keeps the last duplicate
	}
	return env
}

// capBuffer stops accepting once MaxBuffer is exceeded and reports it (spawnSync's ENOBUFS).
type capBuffer struct {
	buf      bytes.Buffer
	max      int
	overflow func()
	over     bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if c.over {
		return len(p), nil
	}
	if c.buf.Len()+len(p) > c.max {
		c.buf.Write(p[:c.max-c.buf.Len()])
		c.over = true
		c.overflow()
		return len(p), nil
	}
	return c.buf.Write(p)
}

// Request is one exec call.
type Request struct {
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	TimeoutMS int      `json:"timeout_ms"`
	Cwd       string   `json:"cwd"`
	Input     string   `json:"input"`
}

// Run executes the request. SIGTERM at the deadline, SIGKILL one second later (as the
// async path in exec.ts); status null (signal, overflow, start failure) maps to exit 1.
func Run(ctx context.Context, r Request) Result {
	timeout := DefaultTimeout
	if r.TimeoutMS > 0 {
		timeout = time.Duration(r.TimeoutMS) * time.Millisecond
	}
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(cctx, r.Command, r.Args...)
	cmd.Dir = r.Cwd
	cmd.Env = ExecEnv(r.Command, os.Environ(), os.Getenv("SOPS_AGE_KEY_FILE"))
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if r.Input != "" {
		cmd.Stdin = strings.NewReader(r.Input)
	}
	var overflowed bool
	out := &capBuffer{max: MaxBuffer, overflow: func() { overflowed = true; cancel() }}
	errb := &capBuffer{max: MaxBuffer, overflow: func() { overflowed = true; cancel() }}
	cmd.Stdout, cmd.Stderr = out, errb

	var fired atomic.Bool
	timer := time.AfterFunc(timeout, func() { fired.Store(true); cancel() })
	defer timer.Stop()

	err := cmd.Run()
	res := Result{Stdout: out.buf.String(), Stderr: errb.buf.String(), ExitCode: 1}
	if err == nil {
		res.ExitCode, res.OK = 0, true
		return res
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() >= 0 {
		res.ExitCode = ee.ExitCode()
	}
	if fired.Load() && !overflowed {
		res.TimedOut, res.ExitCode = true, 1
	}
	if !errors.As(err, &ee) { // start failure: error text goes to stderr like the async path
		res.Stderr += err.Error()
	}
	return res
}
