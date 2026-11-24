package digest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rec(ts float64, svc, state, detail string) Record {
	r := Record{"ts": ts, "service": svc, "state": state}
	if detail != "" {
		r["detail"] = detail
	}
	return r
}

func TestAllGreen(t *testing.T) {
	d := Summarize([]Record{rec(100, "maddy", "green", ""), rec(100, "caddy", "green", "")}, 1000, false)
	if d.Stats.Overall != "GREEN" || d.Stats.GreenCount != 2 || d.Stats.Incidents != 0 || !strings.HasPrefix(d.Title, "[GREEN]") {
		t.Fatalf("%+v", d)
	}
}

func TestIncidentAndDown(t *testing.T) {
	d := Summarize([]Record{
		rec(10, "maddy", "green", ""), rec(20, "maddy", "red", "OOM"), rec(30, "maddy", "green", ""),
		rec(40, "maddy", "red", "swap thrash"), rec(50, "caddy", "yellow", ""),
	}, 1000, false)
	if d.Stats.Overall != "RED" || d.Stats.Incidents != 2 {
		t.Fatalf("%+v", d.Stats)
	}
	if len(d.Stats.RedsNow) != 1 || d.Stats.RedsNow[0] != "maddy" || len(d.Stats.YellowsNow) != 1 || d.Stats.YellowsNow[0] != "caddy" {
		t.Fatalf("%+v", d.Stats)
	}
	if !strings.Contains(d.Body, "swap thrash") || !strings.Contains(d.Body, "DOWN now: maddy") {
		t.Fatal(d.Body)
	}
}

func TestDegradedOnlyAndWeekly(t *testing.T) {
	d := Summarize([]Record{rec(10, "photoprism", "stale", ""), rec(10, "gitea", "green", "")}, 1000, false)
	if d.Stats.Overall != "YELLOW" {
		t.Fatal(d.Stats)
	}
	w := Summarize([]Record{rec(1, "x", "green", "")}, 1000, true)
	if w.Stats.Window != "week" || !strings.Contains(w.Title, "Week digest") {
		t.Fatal(w.Title)
	}
}

func TestEmpty(t *testing.T) {
	d := Summarize(nil, 1000, false)
	if d.Stats.Overall != "GREEN" || d.Stats.Incidents != 0 {
		t.Fatal(d.Stats)
	}
}

func TestReadHistoryToleratesBadLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "h.jsonl")
	data := "{\"ts\": 100, \"service\": \"a\", \"state\": \"green\"}\nnot json\n\n[1,2]\n{\"ts\": \"x\"}\n{\"ts\": 5}\n{\"service\":\"b\"}\n"
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	got := ReadHistory(p, 50)
	if len(got) != 1 {
		t.Fatalf("got %d records: %v", len(got), got)
	}
	if ReadHistory(filepath.Join(t.TempDir(), "missing"), 0) != nil {
		t.Fatal("missing file yields nothing")
	}
}
