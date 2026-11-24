package syslogbr

import (
	"os"
	"path/filepath"
	"testing"

	"ntfy-sidecars/ntfyc"
)

func TestParseAndFormat(t *testing.T) {
	line := `Nov 24 sauron: {"vm":"oci-mail","ts":"2026-11-24T10:00:00Z","alert":{"rule":"Webshell","path":"/var/www/x.php"}}`
	a, ok := ParseAlert(line)
	if !ok {
		t.Fatal("alert expected")
	}
	title, msg := Format(a)
	if title != "🔴 Sauron Alert: Webshell" || msg != "VM: oci-mail\nPath: /var/www/x.php\nTime: 2026-11-24T10:00:00Z" {
		t.Fatalf("%q %q", title, msg)
	}
	if _, ok := ParseAlert("plain syslog line"); ok {
		t.Fatal("no alert expected")
	}
	if _, ok := ParseAlert(`x {"vm": broken}`); ok {
		t.Fatal("bad json is not an alert")
	}
	d, _ := ParseAlert(`{"vm":"v"}`)
	if d.Rule != "Unknown" || d.Path != "" || d.TS != "" {
		t.Fatalf("defaults %+v", d)
	}
}

func TestPassOffsetsRotationAndPartialLine(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "messages")
	st := filepath.Join(dir, "offset")
	if err := os.WriteFile(log, []byte("noise\n{\"vm\":\"a\",\"alert\":{\"rule\":\"R1\"}}\n{\"vm\":\"b\",\"alert\":{\"rule\":\"R2\"}}"), 0o644); err != nil {
		t.Fatal(err)
	}
	pub := &ntfyc.DryRun{}
	b := &Bridge{SyslogFile: log, StateFile: st, Pub: pub}
	b.Pass()
	if len(pub.Messages()) != 1 || pub.Messages()[0].Topic != "sec_yara" || pub.Messages()[0].Priority != "high" {
		t.Fatalf("%+v", pub.Messages())
	}
	// the partial line completes on the next pass and is then published exactly once
	f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("\n")
	f.Close()
	b.Pass()
	b.Pass()
	if len(pub.Messages()) != 2 {
		t.Fatalf("want 2, got %d", len(pub.Messages()))
	}
	if LoadOffset(st) != b.Offset {
		t.Fatal("offset persisted")
	}
	// rotation: file shorter than the offset restarts from 0
	os.WriteFile(log, []byte("{\"vm\":\"c\",\"alert\":{\"rule\":\"R3\"}}\n"), 0o644)
	b.Pass()
	if len(pub.Messages()) != 3 {
		t.Fatal("rotation must restart at offset 0")
	}
}
