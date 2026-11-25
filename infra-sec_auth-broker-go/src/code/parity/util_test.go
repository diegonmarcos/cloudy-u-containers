//go:build parity

package parity

import (
	"os"
	"os/exec"
	"testing"

	"auth-broker/broker"
	"auth-broker/fleetauth"
)

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func pyCmd(bin, sub string, env map[string]string, conf, prov string) *exec.Cmd {
	cmd := exec.Command(bin, "ref.py", sub)
	cmd.Env = append(os.Environ(), "PY_APP_DIR="+appDir(), "BROKER_CONFIG="+conf, "BROKER_PROVIDER="+prov)
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	return cmd
}

func parseDoc(s string) (fleetauth.Value, error) { return fleetauth.ParseJSON([]byte(s)) }

func newBroker(doc fleetauth.Value, prov string, env map[string]string) (*broker.Broker, error) {
	return broker.New(broker.Config{Doc: doc, Provider: prov, Env: func(k string) string { return env[k] }, Out: func(string) {}})
}
