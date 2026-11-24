package c3pub

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPickTarget(t *testing.T) {
	primary := MailTarget{Host: "10.0.0.3", Port: 25}
	targets := map[string]MailTarget{"maddy-direct": {Host: "10.0.0.3", Port: 2526}, "stalwart": {Host: "10.0.0.3", Port: 2025}}
	for hdr, want := range map[string]TargetPick{
		"":             {OK: true, Name: "maddy", Host: "10.0.0.3", Port: 25},
		"maddy-direct": {OK: true, Name: "maddy-direct", Host: "10.0.0.3", Port: 2526},
		" Stalwart ":   {OK: true, Name: "stalwart", Host: "10.0.0.3", Port: 2025},
		"nope":         {Code: 400, Error: "unknown mail target 'nope'"},
		"maddy":        {Code: 503, Error: "mail target 'maddy' is declared but not resolved on this host"},
	} {
		if got := PickTarget(hdr, primary, targets, DeclaredTargets); got != want {
			t.Errorf("PickTarget(%q) = %+v, want %+v", hdr, got, want)
		}
	}
	if PickTarget("x", primary, map[string]MailTarget{"x": {Host: "h", Port: 2.5}}, nil).OK {
		t.Error("a non-integer port is not resolved")
	}
}

func TestDeclaredTargetsMatchBuildJson(t *testing.T) {
	b, err := os.ReadFile("../../../build.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Mail struct {
			Targets map[string]any `json:"targets"`
		} `json:"mail"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	var names []string
	for n := range doc.Mail.Targets {
		names = append(names, n)
	}
	sort.Strings(names)
	want := append([]string(nil), DeclaredTargets...)
	sort.Strings(want)
	if !reflect.DeepEqual(names, want) {
		t.Errorf("build.json#mail.targets %v != DeclaredTargets %v", names, want)
	}
}

func TestLedger(t *testing.T) {
	l := NewLedger(time.Minute)
	var sends atomic.Int32
	ok := func() error { sends.Add(1); return nil }
	if r := l.Deliver("k1", ok, time.Second); r.State != Delivered || r.Deduped {
		t.Errorf("first send: %+v", r)
	}
	if r := l.Deliver("k1", ok, time.Second); r.State != Delivered || !r.Deduped || sends.Load() != 1 {
		t.Errorf("a retry after success must not send again: %+v sends=%d", r, sends.Load())
	}
	// no key: never deduplicated
	l.Deliver("", ok, time.Second)
	l.Deliver("", ok, time.Second)
	if sends.Load() != 3 {
		t.Errorf("keyless sends must not dedupe, got %d", sends.Load())
	}
	// failure is forgotten, the next retry really sends
	fail := func() error { return errors.New("boom") }
	if r := l.Deliver("k2", fail, time.Second); r.State != Failed || r.Error != "boom" {
		t.Errorf("failure: %+v", r)
	}
	if r := l.Deliver("k2", ok, time.Second); r.State != Delivered || r.Deduped {
		t.Errorf("retry after failure: %+v", r)
	}
	// slow session: pending, a retry joins it (one send), and the join is deduped
	release := make(chan struct{})
	var slowSends atomic.Int32
	slow := func() error { slowSends.Add(1); <-release; return nil }
	if r := l.Deliver("k3", slow, 20*time.Millisecond); r.State != Pending || r.Joined {
		t.Errorf("slow: %+v", r)
	}
	go func() { time.Sleep(30 * time.Millisecond); close(release) }()
	if r := l.Deliver("k3", slow, time.Second); r.State != Delivered || !r.Deduped || slowSends.Load() != 1 {
		t.Errorf("join: %+v sends=%d", r, slowSends.Load())
	}
	if LedgerKey("maddy", "?", "a@b") != "" || LedgerKey("maddy", " ", "a@b") != "" {
		t.Error("a message without a Message-ID has no key")
	}
	if LedgerKey("maddy", " <x@y> ", " A@B ") != "maddy\x00<x@y>\x00a@b" {
		t.Error("key = target + id + lower-cased rcpt")
	}
}

func TestCodeStore(t *testing.T) {
	c := ProfileCfg{CodeTTLS: 600, ResendCooldownS: 60, MaxAttempts: 3}
	s := NewCodeStore(c)
	now := time.Now()
	a := s.Issue("u", now)
	if !a.OK || len(a.Code) != 6 || a.ExpiresIn != 600 {
		t.Fatalf("issue: %+v", a)
	}
	if b := s.Issue("u", now.Add(10*time.Second)); b.OK || b.RetryAfter != 50 {
		t.Errorf("cooldown: %+v", b)
	}
	if v := s.Verify("other", a.Code, now); v.OK || v.Err != "no_code" {
		t.Errorf("a code is bound to its identity: %+v", v)
	}
	if v := s.Verify("u", "x"+a.Code, now); v.Err != "bad_code" || v.AttemptsLeft != 2 {
		t.Errorf("bad: %+v", v)
	}
	if v := s.Verify("u", " "+a.Code+" ", now); !v.OK {
		t.Errorf("a padded code verifies: %+v", v)
	}
	if v := s.Verify("u", a.Code, now); v.OK {
		t.Error("single use")
	}
	b := s.Issue("u", now)
	s.Verify("u", "no", now)
	s.Verify("u", "no", now)
	if v := s.Verify("u", "no", now); v.Err != "too_many_attempts" {
		t.Errorf("budget: %+v", v)
	}
	if v := s.Verify("u", b.Code, now); v.Err != "no_code" {
		t.Errorf("a burnt code is gone: %+v", v)
	}
	d := s.Issue("u", now)
	if v := s.Verify("u", d.Code, now.Add(601*time.Second)); v.Err != "expired" {
		t.Errorf("expiry: %+v", v)
	}
	e := s.Issue("u", now)
	s.Revoke("u")
	if v := s.Verify("u", e.Code, now); v.Err != "no_code" {
		t.Errorf("revoke: %+v", v)
	}
}

func TestMailHelpers(t *testing.T) {
	if MaskAddress("me@diegonmarcos.com") != "m•@diegonmarcos.com" || MaskAddress("x") != "•" || MaskAddress("@x") != "•" {
		t.Error("MaskAddress")
	}
	if string(dotStuff([]byte("a\n.b\r\n..c"))) != "a\r\n..b\r\n...c\r\n.\r\n" {
		t.Errorf("dotStuff: %q", dotStuff([]byte("a\n.b\r\n..c")))
	}
	if string(lenientBase64("aGVsbG8gd29ybGQ=")) != "hello world" || string(lenientBase64("aGVsbG8")) != "hello" || string(lenientBase64(" aGVs\nbG8=")) != "hello" {
		t.Error("lenientBase64")
	}
	msg := []byte("From: A <a@x.org>\r\nTo: x@y.org,\r\n z@y.org\r\nMessage-ID:\r\n <f@x>\r\n\r\nTo: not-a-header\r\n")
	if v, _ := extractHeader(msg, "To"); v != "x@y.org, z@y.org" {
		t.Errorf("folded header: %q", v)
	}
	if v, _ := extractAddress(msg, "From"); v != "a@x.org" {
		t.Errorf("address: %q", v)
	}
	if v, ok := extractHeader(msg, "Message-ID"); !ok || v != " <f@x>" {
		t.Errorf("empty first line then continuation keeps the leading space (as the Node scan does): %q %v", v, ok)
	}
	if _, ok := extractHeader(msg, "Subject"); ok {
		t.Error("an absent header is absent")
	}
	if !strings.Contains(CodeMail(ProfileCfg{MailFrom: "a@b.c", MailTo: "t@x", CodeTTLS: 600}, "123456", "u", time.Unix(0, 0)), "It expires in 10 minutes and works once.") {
		t.Error("CodeMail")
	}
}

func TestMissingParts(t *testing.T) {
	dir := t.TempDir()
	c := ProfileCfg{MailTo: "x@y", BundleDir: dir, BundleFile: "b.json", SchemaFile: "s.json"}
	if got := MissingParts(c); !reflect.DeepEqual(got, []string{"bundle", "schema"}) {
		t.Errorf("%v", got)
	}
	_ = os.WriteFile(dir+"/b.json", []byte(`{"schema_version":1}`), 0o644)
	_ = os.WriteFile(dir+"/s.json", []byte(`{}`), 0o644)
	if got := MissingParts(c); len(got) != 0 {
		t.Errorf("%v", got)
	}
	c.MailTo = ""
	if got := MissingParts(c); !reflect.DeepEqual(got, []string{"mail_to"}) {
		t.Errorf("%v", got)
	}
	_ = os.WriteFile(dir+"/b.json", []byte(`{"sops":{},"schema_version":1}`), 0o644)
	if _, _, err := LoadBundle(c); err == nil || !strings.Contains(err.Error(), "sops-encrypted") {
		t.Errorf("a sops bundle is refused: %v", err)
	}
	_ = os.WriteFile(dir+"/b.json", []byte(`{"a":1}`), 0o644)
	if _, _, err := LoadBundle(c); err == nil || !strings.Contains(err.Error(), "schema_version") {
		t.Errorf("a bundle without schema_version is refused: %v", err)
	}
}

func TestIdentityAndConfig(t *testing.T) {
	h := map[string][]string{"X-Auth-User": {" a "}}
	if Identity(h) != "a" {
		t.Error("identity")
	}
	cfg, err := LoadConfig(func(k string) string {
		return map[string]string{"LIMITS_JSON": `{"max_body_bytes":10,"request_timeout_ms":200000}`, "SMTP_PORT": "2525"}[k]
	})
	if err != nil || *cfg.Limits.SMTPTimeoutMS != 200000 || *cfg.Limits.DedupeTTLMS != 1800000 || cfg.Primary.Port != 2525 || cfg.Port != 8087 || cfg.BasePath != "/c3-public-api" {
		t.Errorf("config defaults: %+v %v", cfg, err)
	}
	if _, err := LoadConfig(func(k string) string { return map[string]string{"BACKENDS_JSON": "{"}[k] }); err == nil {
		t.Error("an invalid JSON env var is an error")
	}
}

func TestParseAddresses(t *testing.T) {
	for in, want := range map[string][]string{
		"a@b.c":                     {"a@b.c"},
		"x@y.org, z@y.org":          {"x@y.org", "z@y.org"},
		`"Q, R" <q@r.org>, z@y.org`: {"q@r.org", "z@y.org"},
		"Name <n@m.org>":            {"n@m.org"},
		" , ":                       nil,
	} {
		if got := ParseAddresses(in); !reflect.DeepEqual(got, want) {
			t.Errorf("ParseAddresses(%q) = %v, want %v", in, got, want)
		}
	}
}
