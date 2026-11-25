package broker

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"strings"
	"time"
	"unicode"

	"auth-broker/fleetauth"
)

type pyErr struct{ name, msg string }

func (e pyErr) Error() string  { return e.name + ": " + e.msg }
func (e pyErr) PyName() string { return e.name }

// deliver sends the code through Stalwart over the mesh first, the Resend API as fallback. It fails when both do.
func (b *Broker) deliver(to, code string) error {
	var errs []string
	subject := b.eo.str("subject", "Your sign-in code")
	body := fmt.Sprintf("Your sign-in code is %s. It is valid for %d minutes and works once.\nIf you did not ask for it, ignore this message.\n", code, b.otpTTL/60)
	sm := b.eo.obj("smtp")
	user, pw := b.env(sm.str("user_env", "")), b.env(sm.str("password_env", ""))
	if sm.truthy("host") && user != "" && pw != "" {
		if err := b.sendSMTP(sm, user, pw, to, subject, body); err == nil {
			return nil
		} else {
			errs = append(errs, "smtp:"+errName(err))
		}
	}
	rs := b.eo.obj("resend")
	key := b.env(rs.str("api_key_env", ""))
	if rs.truthy("url") && key != "" {
		if err := b.sendResend(rs, key, to, subject, body); err == nil {
			return nil
		} else {
			errs = append(errs, "resend:"+errName(err))
		}
	}
	if len(errs) == 0 {
		return pyErr{"RuntimeError", "no mail path configured"}
	}
	return pyErr{"RuntimeError", strings.Join(errs, ",")}
}

func (b *Broker) sendResend(rs cv, key, to, subject, body string) error {
	payload := fleetauth.DumpJSON(fleetauth.ObjV(obj("from", rs.str("from", ""), "to", []string{to}, "subject", subject, "text", body)))
	req, err := http.NewRequest(http.MethodPost, rs.str("url", ""), strings.NewReader(payload))
	if err != nil {
		return pyErr{"ValueError", err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UA)
	cl := *b.client
	cl.Timeout = 15 * time.Second
	resp, err := cl.Do(req)
	if err != nil {
		return pyErr{"URLError", err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return pyErr{"HTTPError", resp.Status}
	}
	if resp.StatusCode >= 300 {
		return pyErr{"RuntimeError", fmt.Sprintf("resend status %d", resp.StatusCode)}
	}
	return nil
}

// emailMessage is the bytes smtplib sends for the EmailMessage the original builds (policy SMTP: CRLF).
func emailMessage(from, to, subject, body string) []byte {
	var sb strings.Builder
	hdr := func(k, v string) { sb.WriteString(k + ": " + v + "\r\n") }
	hdr("From", from)
	hdr("To", to)
	hdr("Subject", encodeHeader(subject))
	hdr("Content-Type", `text/plain; charset="utf-8"`)
	hdr("Content-Transfer-Encoding", "7bit")
	hdr("MIME-Version", "1.0")
	sb.WriteString("\r\n")
	sb.WriteString(strings.ReplaceAll(body, "\n", "\r\n"))
	return []byte(sb.String())
}

func encodeHeader(s string) string {
	for _, r := range s {
		if r > unicode.MaxASCII {
			return mime.QEncoding.Encode("utf-8", s)
		}
	}
	return s
}

func (b *Broker) sendSMTP(sm cv, user, pw, to, subject, body string) error {
	host := sm.str("host", "")
	port, err := sm.integer("port", 0)
	if err != nil || !sm.has("port") {
		return pyErr{"KeyError", "port"}
	}
	from := sm.str("from", "")
	if !sm.truthy("from") {
		from = user
	}
	name := sm.str("tls_server_name", "")
	if !sm.truthy("tls_server_name") {
		name = host
	}
	// connect by mesh IP, verify the public hostname
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), 15*time.Second)
	if err != nil {
		return pyErr{"OSError", err.Error()}
	}
	_ = raw.SetDeadline(time.Now().Add(15 * time.Second))
	tc := tls.Client(raw, &tls.Config{ServerName: name, InsecureSkipVerify: sm.truthy("allow_invalid_certs"), MinVersion: tls.VersionTLS12})
	if err := tc.Handshake(); err != nil {
		raw.Close()
		return pyErr{"SSLError", err.Error()}
	}
	c, err := smtp.NewClient(tc, host)
	if err != nil {
		tc.Close()
		return pyErr{"SMTPServerDisconnected", err.Error()}
	}
	defer c.Close()
	hn, _ := os.Hostname()
	if hn == "" {
		hn = "localhost"
	}
	if err := c.Hello(hn); err != nil {
		return pyErr{"SMTPHeloError", err.Error()}
	}
	ok, params := c.Extension("auth")
	if !ok {
		return pyErr{"SMTPNotSupportedError", "SMTP AUTH extension not supported by server."}
	}
	if err := c.Auth(chooseAuth(strings.Fields(strings.ToUpper(params)), user, pw, host)); err != nil {
		return pyErr{"SMTPAuthenticationError", err.Error()}
	}
	addr := from
	if a, err := mail.ParseAddress(from); err == nil {
		addr = a.Address
	}
	if err := c.Mail(addr); err != nil {
		return pyErr{"SMTPSenderRefused", err.Error()}
	}
	if err := c.Rcpt(to); err != nil {
		return pyErr{"SMTPRecipientsRefused", err.Error()}
	}
	w, err := c.Data()
	if err != nil {
		return pyErr{"SMTPDataError", err.Error()}
	}
	if _, err := w.Write(emailMessage(from, to, subject, body)); err != nil {
		return pyErr{"SMTPDataError", err.Error()}
	}
	if err := w.Close(); err != nil {
		return pyErr{"SMTPDataError", err.Error()}
	}
	_ = c.Quit()
	return nil
}

// chooseAuth follows smtplib's preference order: CRAM-MD5, PLAIN, LOGIN, among what the server advertises.
func chooseAuth(advertised []string, user, pw, host string) smtp.Auth {
	has := func(m string) bool {
		for _, a := range advertised {
			if a == m {
				return true
			}
		}
		return false
	}
	switch {
	case has("CRAM-MD5"):
		return smtp.CRAMMD5Auth(user, pw)
	case has("PLAIN"):
		return smtp.PlainAuth("", user, pw, host)
	case has("LOGIN"):
		return loginAuth{user, pw}
	}
	return smtp.PlainAuth("", user, pw, host)
}

type loginAuth struct{ user, pw string }

func (a loginAuth) Start(*smtp.ServerInfo) (string, []byte, error) { return "LOGIN", nil, nil }
func (a loginAuth) Next(from []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(string(bytes.TrimSpace(from))) {
	case "username:":
		return []byte(a.user), nil
	case "password:":
		return []byte(a.pw), nil
	}
	return nil, errors.New("unexpected LOGIN challenge")
}
