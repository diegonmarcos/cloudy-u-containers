package execd

import (
	"fmt"
	"regexp"
	"strings"
)

// The policy is the contract (ticket #1875): the sidecar executes nothing the Node tools
// could not already run, and nothing outside this table.

// AllowedCommands is every binary the TS tool tree passes to exec()/execAsync() today
// (grep of `exec("<cmd>"` over cloudy-c3-api, cloud-infra-mcp, cloud-superapp-mcp) plus the
// CLIs the cloud groups shell out to. A bare name only: no path, so PATH decides.
var AllowedCommands = map[string]bool{
	"gh": true, "sh": true, "bash": true, "curl": true, "ssh": true, "gcloud": true,
	"terraform": true, "oci": true, "ping": true, "ssh-keyscan": true, "docker": true,
	"dig": true, "bq": true, "aws": true, "gsutil": true, "az": true, "kubectl": true,
	"helm": true, "wrangler": true, "hcloud": true, "cloudflared": true, "sops": true,
	"git": true,
}

var (
	safeName  = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)
	safeSince = regexp.MustCompile(`^\d+[smhd]$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$`)
)

// CheckCommand rejects anything that is not a bare allowlisted binary name.
func CheckCommand(command string) error {
	if strings.ContainsAny(command, "/ \t\n\x00") || !AllowedCommands[command] {
		return fmt.Errorf("command not allowed: %q", command)
	}
	return nil
}

// ValidateName ports validateContainerName / validatePathComponent.
func ValidateName(kind, name string) error {
	if !safeName.MatchString(name) {
		return fmt.Errorf("Invalid %s: %s", kind, name)
	}
	return nil
}

// ValidateSince ports validateSince.
func ValidateSince(since string) error {
	if !safeSince.MatchString(since) {
		return fmt.Errorf("Invalid since format: %s. Expected: '1h', '30m', '2d', or '2024-01-01'", since)
	}
	return nil
}

// CheckAlias: an ssh alias is a config Host name, never a free-form target.
func CheckAlias(alias string) error { return ValidateName("ssh alias", alias) }
