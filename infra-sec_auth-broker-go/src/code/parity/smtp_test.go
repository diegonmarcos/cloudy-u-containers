//go:build parity

package parity

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSMTP is an implicit-TLS submission server that records what a client sent: the AUTH credentials, the envelope
// and the message bytes. It never relays anything.
type fakeSMTP struct {
	ln       net.Listener
	mu       sync.Mutex
	sessions []string
	refuse   bool // answer AUTH with 535
}

func startFakeSMTP(t *testing.T) *fakeSMTP {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "mail.example.org"}, DNSNames: []string{"mail.example.org"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeSMTP) port() int { return f.ln.Addr().(*net.TCPAddr).Port }

func (f *fakeSMTP) serve(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	rd := bufio.NewReader(c)
	var rec []string
	defer func() {
		if len(rec) == 0 { // a handshake that never completed is not a session
			return
		}
		f.mu.Lock()
		f.sessions = append(f.sessions, strings.Join(rec, "\n"))
		f.mu.Unlock()
	}()
	w := func(s string) { fmt.Fprint(c, s+"\r\n") }
	w("220 fake.example ESMTP")
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		up := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
			w("250-fake.example")
			w("250-AUTH PLAIN")
			w("250 8BITMIME")
		case strings.HasPrefix(up, "AUTH PLAIN"):
			raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(line[len("AUTH PLAIN"):]))
			rec = append(rec, "AUTH "+strings.ReplaceAll(string(raw), "\x00", "<0>"))
			f.mu.Lock()
			refuse := f.refuse
			f.mu.Unlock()
			if refuse {
				w("535 5.7.8 authentication failed")
			} else {
				w("235 2.7.0 ok")
			}
		case strings.HasPrefix(up, "MAIL FROM:"):
			rec = append(rec, "MAIL "+line[len("MAIL FROM:"):strings.Index(line, ">")+1])
			w("250 ok")
		case strings.HasPrefix(up, "RCPT TO:"):
			rec = append(rec, "RCPT "+line[len("RCPT TO:"):strings.Index(line, ">")+1])
			w("250 ok")
		case up == "DATA":
			w("354 go ahead")
			var sb strings.Builder
			for {
				l, err := rd.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				sb.WriteString(l)
			}
			rec = append(rec, "DATA\n"+strings.ReplaceAll(sb.String(), "\r\n", "<crlf>\n"))
			w("250 queued")
		case up == "QUIT":
			w("221 bye")
			return
		default:
			w("502 not implemented")
		}
	}
}

func (f *fakeSMTP) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sessions...)
}

// TestParitySMTP sends the same one-time code through the real SMTP path of both services against a TLS submission
// server: the credentials, envelope and message must be byte-identical; and every way the SMTP path can fail must fall
// back to the mail API with the same request.
func TestParitySMTP(t *testing.T) {
	requirePython(t)
	for _, c := range []struct {
		name   string
		strict bool // verify the certificate (the self-signed one fails)
		refuse bool
		want   int // SMTP sessions each side opens
	}{
		{"delivered over SMTP", false, false, 1},
		{"authentication refused falls back to the mail API", false, true, 1},
		{"certificate verification fails falls back to the mail API", true, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := startFakeSMTP(t)
			f.refuse = c.refuse
			mut := func(ab map[string]any) {
				eo := ab["email_otp"].(map[string]any)
				eo["smtp"] = map[string]any{"host": "127.0.0.1", "port": f.port(), "user_env": "AB_SMTP_USER", "password_env": "AB_SMTP_PASS",
					"from": "Sign in <signin@example.org>", "tls_server_name": "mail.example.org", "allow_invalid_certs": !c.strict}
			}
			w := worldFor(t, "email", "smtp", func() string { return "{}" }, mut)
			w.env["AB_SMTP_USER"], w.env["AB_SMTP_PASS"] = "submit-user", "submit-pass-synthetic"
			py, gs := pair(t, w)
			steps := []step{
				{name: "request listed", method: "POST", path: "/oauth2/email/request", hdr: jsonPost("X-Real-IP", "198.51.100.5"), body: `{"email":"owner@example.org"}`, want: 200},
				{name: "request unlisted", method: "POST", path: "/oauth2/email/request", hdr: jsonPost("X-Real-IP", "198.51.100.6"), body: `{"email":"nobody@example.org"}`, want: 200},
			}
			n := run(t, py, gs, steps, map[string]string{})
			got := f.log()
			if len(got) != 2*c.want {
				t.Fatalf("expected %d SMTP sessions, got %d: %q", 2*c.want, len(got), got)
			}
			for i := 0; i+1 < len(got); i += 2 {
				if got[i] != got[i+1] {
					n++
					t.Errorf("SMTP sessions differ:\n--- python\n%s\n--- go\n%s", got[i], got[i+1])
				}
				if !strings.Contains(got[i], "Your sign-in code is ") && !c.refuse {
					t.Errorf("no message in the session: %q", got[i])
				}
			}
			finish(t, py, gs, n)
		})
	}
}
