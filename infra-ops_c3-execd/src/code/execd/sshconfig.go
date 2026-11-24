package execd

import (
	"bufio"
	"os"
	"path"
	"strconv"
	"strings"
)

// HostConfig is the subset of ssh_config the fleet aliases use: the connection logic that
// ssh.ts delegates to ~/.ssh/config (host, user, key, port, ProxyJump).
type HostConfig struct {
	HostName      string
	User          string
	Port          int
	IdentityFiles []string
	ProxyJump     string
}

type sshBlock struct {
	patterns []string
	opts     map[string][]string
}

// SSHConfig is a parsed ssh_config. Like ssh, the first value obtained for an option wins
// (IdentityFile accumulates). Include, Match and %-tokens are not interpreted.
type SSHConfig struct{ blocks []sshBlock }

func ParseSSHConfig(text string) *SSHConfig {
	c := &SSHConfig{blocks: []sshBlock{{patterns: []string{"*"}, opts: map[string][]string{}}}}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val := splitKV(line)
		if key == "" {
			continue
		}
		if key == "host" {
			c.blocks = append(c.blocks, sshBlock{patterns: strings.Fields(val), opts: map[string][]string{}})
			continue
		}
		b := &c.blocks[len(c.blocks)-1]
		b.opts[key] = append(b.opts[key], strings.Trim(val, `"`))
	}
	return c
}

func LoadSSHConfig(file string) (*SSHConfig, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return ParseSSHConfig(string(b)), nil
}

func splitKV(line string) (string, string) {
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return "", ""
	}
	return strings.ToLower(line[:i]), strings.TrimSpace(strings.TrimLeft(line[i:], " \t="))
}

func hostMatches(patterns []string, host string) bool {
	matched := false
	for _, p := range patterns {
		neg := strings.HasPrefix(p, "!")
		p = strings.TrimPrefix(p, "!")
		if ok, _ := path.Match(p, host); ok {
			if neg {
				return false
			}
			matched = true
		}
	}
	return matched
}

// Resolve returns the effective config for an alias; HostName defaults to the alias.
func (c *SSHConfig) Resolve(alias, home string) HostConfig {
	hc := HostConfig{Port: 0}
	for _, b := range c.blocks {
		if !hostMatches(b.patterns, alias) {
			continue
		}
		if v := b.opts["hostname"]; len(v) > 0 && hc.HostName == "" {
			hc.HostName = v[0]
		}
		if v := b.opts["user"]; len(v) > 0 && hc.User == "" {
			hc.User = v[0]
		}
		if v := b.opts["port"]; len(v) > 0 && hc.Port == 0 {
			hc.Port, _ = strconv.Atoi(v[0])
		}
		if v := b.opts["proxyjump"]; len(v) > 0 && hc.ProxyJump == "" {
			hc.ProxyJump = v[0]
		}
		for _, f := range b.opts["identityfile"] {
			if strings.HasPrefix(f, "~/") {
				f = home + f[1:]
			}
			hc.IdentityFiles = append(hc.IdentityFiles, f)
		}
	}
	if hc.HostName == "" {
		hc.HostName = alias
	}
	if hc.Port == 0 {
		hc.Port = 22
	}
	return hc
}
