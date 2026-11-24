// Package execd is the c3-execd core: process exec with timeouts, a pooled native SSH
// client, a policy-gated Docker unix-socket client and an audit log (ticket #1875).
//
// Behaviour contract: the Node helpers it replaces (shared/libs/exec.ts, ssh.ts,
// shell-quote.ts, ssh-argv.ts, validators.ts, docker.ts). Each file names its original.
package execd

import "strings"

// PosixQuote single-quotes v for a POSIX shell (port of shell-quote.ts posixQuote).
func PosixQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

// AnyShellQuote quotes one word so POSIX shells AND fish read it back verbatim (port of
// anyShellQuote): single-quoted runs never hold ' or \, which go in double quotes.
func AnyShellQuote(v string) string {
	if v == "" {
		return "''"
	}
	var b strings.Builder
	start := 0
	flush := func(end int) {
		if end > start {
			b.WriteString("'" + v[start:end] + "'")
		}
	}
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '\'':
			flush(i)
			b.WriteString(`"'"`)
			start = i + 1
		case '\\':
			flush(i)
			b.WriteString(`"\\"`)
			start = i + 1
		}
	}
	flush(len(v))
	return b.String()
}

// RemoteShellWrap runs command under bash on the remote whatever the login shell is.
func RemoteShellWrap(command string) string { return "bash -c " + AnyShellQuote(command) }

// DockerExecShell is `docker exec <container> sh -c <command>` (POSIX-quoted body).
func DockerExecShell(container, command string) string {
	return "docker exec " + container + " sh -c " + PosixQuote(command)
}
