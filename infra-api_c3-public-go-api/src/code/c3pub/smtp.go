package c3pub

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// SendRaw delivers one raw RFC 5322 message over plain SMTP (no TLS: the hop is wg0, which encrypts; maddy's own relay to
// :2025 uses `starttls no` for the same reason). Every phase runs under the same timeout the Node transport used for
// connection, greeting and socket.
func SendRaw(host string, port int, helo, from string, to []string, raw []byte, timeout time.Duration) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return fmt.Errorf("connect %s: %v", addr, err)
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	cmd := func(line string, want ...int) (string, error) {
		if line != "" {
			_ = conn.SetWriteDeadline(time.Now().Add(timeout))
			if _, err := conn.Write([]byte(line + "\r\n")); err != nil {
				return "", err
			}
		}
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
		var full strings.Builder
		for {
			l, err := rd.ReadString('\n')
			if err != nil {
				return full.String(), fmt.Errorf("connection closed: %v", err)
			}
			full.WriteString(l)
			if len(l) >= 4 && l[3] == '-' {
				continue
			}
			break
		}
		resp := strings.TrimRight(full.String(), "\r\n")
		code, _ := strconv.Atoi(resp[:min(3, len(resp))])
		for _, w := range want {
			if code == w {
				return resp, nil
			}
		}
		return resp, fmt.Errorf("%s: %s", strings.SplitN(line+" ", " ", 2)[0], resp)
	}
	if _, err := cmd("", 220); err != nil {
		return fmt.Errorf("greeting: %v", err)
	}
	if _, err := cmd("EHLO "+helo, 250); err != nil {
		if _, err2 := cmd("HELO "+helo, 250); err2 != nil {
			return err2
		}
	}
	if _, err := cmd("MAIL FROM:<"+from+">", 250); err != nil {
		return fmt.Errorf("Mail command failed: %v", err)
	}
	for _, r := range to {
		if _, err := cmd("RCPT TO:<"+r+">", 250, 251); err != nil {
			return fmt.Errorf("Can't send mail - all recipients were rejected: %v", err)
		}
	}
	if _, err := cmd("DATA", 354); err != nil {
		return fmt.Errorf("Data command failed: %v", err)
	}
	_ = conn.SetWriteDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(dotStuff(raw)); err != nil {
		return err
	}
	if _, err := cmd("", 250); err != nil {
		return fmt.Errorf("Message failed: %v", err)
	}
	_, _ = cmd("QUIT", 221)
	return nil
}

// dotStuff normalises line endings to CRLF, escapes leading dots and ends with <CRLF>.<CRLF>.
func dotStuff(raw []byte) []byte {
	var out bytes.Buffer
	lineStart := true
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == '\r' && i+1 < len(raw) && raw[i+1] == '\n' {
			continue
		}
		if c == '\n' {
			out.WriteString("\r\n")
			lineStart = true
			continue
		}
		if lineStart && c == '.' {
			out.WriteByte('.')
		}
		lineStart = false
		out.WriteByte(c)
	}
	if !bytes.HasSuffix(out.Bytes(), []byte("\r\n")) {
		out.WriteString("\r\n")
	}
	out.WriteString(".\r\n")
	return out.Bytes()
}
