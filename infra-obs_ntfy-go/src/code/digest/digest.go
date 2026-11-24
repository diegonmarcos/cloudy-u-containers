// Package digest is the Go port of notify-digest.py: Summarize is the pure aggregation core, the rest reads the
// reports history JSONL and hands the digest to the broker's dispatcher.
package digest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Record is one history line, already decoded.
type Record = map[string]any

// Incident is a transition into red.
type Incident struct {
	Service string
	TS      any
	Detail  string
}

// Stats mirrors the Python stats dict.
type Stats struct {
	Overall     string
	Window      string
	StateCounts map[string]int
	Incidents   int
	RedsNow     []string
	YellowsNow  []string
	GreenCount  int
}

// Digest is the Summarize result.
type Digest struct {
	Title string
	Body  string
	Stats Stats
}

// number is Python's numeric view of a JSON value: numbers, and booleans as 1/0.
func number(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func tsOf(r Record) float64 {
	f, _ := number(r["ts"])
	return f
}

func strOf(r Record, k, def string) string {
	v, ok := r[k]
	if !ok {
		return def
	}
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return "None"
	}
	return fmt.Sprint(v)
}

// ReadHistory reads the JSONL, keeping records with ts >= since. Bad lines are skipped.
func ReadHistory(path string, since float64) []Record {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var recs []Record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var r Record
		if json.Unmarshal([]byte(line), &r) != nil || r == nil {
			continue
		}
		if v, has := r["ts"]; has {
			if _, isNum := number(v); !isNum {
				continue
			}
		}
		if tsOf(r) >= since {
			recs = append(recs, r)
		}
	}
	return recs
}

func utc(ts float64) time.Time { return time.Unix(int64(ts), 0).UTC() }

// Summarize aggregates history records into a digest. Pure.
func Summarize(records []Record, now float64, weekly bool) Digest {
	window := "day"
	if weekly {
		window = "week"
	}
	counts := map[string]int{"green": 0, "yellow": 0, "red": 0, "unknown": 0, "stale": 0}
	last := map[string]string{}
	var order []string
	var incidents []Incident
	prev := map[string]string{}

	sorted := make([]Record, len(records))
	copy(sorted, records)
	sort.SliceStable(sorted, func(i, j int) bool { return tsOf(sorted[i]) < tsOf(sorted[j]) })

	for _, r := range sorted {
		svc := strOf(r, "service", "?")
		st := strOf(r, "state", "unknown")
		counts[st]++
		if _, ok := last[svc]; !ok {
			order = append(order, svc)
		}
		last[svc] = st
		if st == "red" {
			if prev[svc] != "red" {
				incidents = append(incidents, Incident{Service: svc, TS: r["ts"], Detail: strOf(r, "detail", "")})
			}
		}
		prev[svc] = st
	}

	reds, yellows, greens := []string{}, []string{}, []string{}
	for _, s := range order {
		switch last[s] {
		case "red":
			reds = append(reds, s)
		case "yellow", "stale", "unknown":
			yellows = append(yellows, s)
		case "green":
			greens = append(greens, s)
		}
	}
	sort.Strings(reds)
	sort.Strings(yellows)
	sort.Strings(greens)

	overall := "GREEN"
	if len(reds) > 0 {
		overall = "RED"
	} else if len(yellows) > 0 {
		overall = "YELLOW"
	}
	capital := []rune(window)
	capital[0] = unicode.ToUpper(capital[0])
	title := fmt.Sprintf("[%s] %s digest %s", overall, string(capital), utc(now).Format("2006-01-02"))

	lines := []string{
		"Overall: " + overall,
		fmt.Sprintf("Services: %d green / %d degraded / %d down", len(greens), len(yellows), len(reds)),
		fmt.Sprintf("Incidents (%s): %d", window, len(incidents)),
	}
	if len(reds) > 0 {
		lines = append(lines, "DOWN now: "+strings.Join(reds, ", "))
	}
	if len(yellows) > 0 {
		lines = append(lines, "Degraded: "+strings.Join(yellows, ", "))
	}
	if len(incidents) > 0 {
		lines = append(lines, "", "Recent incidents:")
		start := 0
		if len(incidents) > 10 {
			start = len(incidents) - 10
		}
		for _, inc := range incidents[start:] {
			t := now
			if f, ok := number(inc.TS); ok && f != 0 {
				t = f
			}
			lines = append(lines, strings.TrimRight(fmt.Sprintf("  %s %s %s", utc(t).Format("01-02 15:04"), inc.Service, inc.Detail), " \t\r\n\f\v"))
		}
	}
	return Digest{
		Title: title,
		Body:  strings.Join(lines, "\n"),
		Stats: Stats{Overall: overall, Window: window, StateCounts: counts, Incidents: len(incidents), RedsNow: reds, YellowsNow: yellows, GreenCount: len(greens)},
	}
}
