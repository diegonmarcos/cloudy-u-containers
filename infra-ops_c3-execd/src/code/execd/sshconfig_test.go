package execd

import (
	"reflect"
	"testing"
)

const sampleCfg = `
# global
ServerAliveInterval 30

Host jump
  HostName 10.0.0.1
  User ops
  IdentityFile ~/.ssh/jumpkey

Host oci-apps oci-mail
  HostName 10.0.0.6
  User ubuntu
  Port 2222
  ProxyJump jump
  IdentityFile ~/.ssh/k1
  IdentityFile ~/.ssh/k2

Host *
  User fallback
  IdentityFile ~/.ssh/default
  Port 22
`

func TestSSHConfigResolve(t *testing.T) {
	c := ParseSSHConfig(sampleCfg)
	got := c.Resolve("oci-apps", "/h")
	want := HostConfig{HostName: "10.0.0.6", User: "ubuntu", Port: 2222, ProxyJump: "jump",
		IdentityFiles: []string{"/h/.ssh/k1", "/h/.ssh/k2", "/h/.ssh/default"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v want %+v", got, want)
	}
	j := c.Resolve("jump", "/h")
	if j.HostName != "10.0.0.1" || j.User != "ops" || j.Port != 22 || j.IdentityFiles[0] != "/h/.ssh/jumpkey" {
		t.Fatalf("%+v", j)
	}
	u := c.Resolve("unknown-host", "/h")
	if u.HostName != "unknown-host" || u.User != "fallback" || u.Port != 22 {
		t.Fatalf("%+v", u)
	}
}

func TestSSHConfigFirstValueWins(t *testing.T) {
	c := ParseSSHConfig("Host a\n User first\nHost a\n User second\n")
	if u := c.Resolve("a", "/h").User; u != "first" {
		t.Fatalf("ssh_config semantics: first value wins, got %s", u)
	}
}
