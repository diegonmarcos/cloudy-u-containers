// Package syslogbr is the Go port of syslog-to-ntfy.py: tail the syslog file and push Sauron alerts to ntfy.
package syslogbr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ntfy-sidecars/ntfyc"
)

// Topic is the ntfy topic the alerts go to.
const Topic = "sec_yara"

var alertRE = regexp.MustCompile(`\{"vm":.*\}`)

// Alert is a parsed Sauron alert line.
type Alert struct {
	VM, TS, Rule, Path string
}

func pyStr(v any, def string) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// ParseAlert extracts the {"vm":...} JSON object from a syslog line.
func ParseAlert(line string) (Alert, bool) {
	m := alertRE.FindString(line)
	if m == "" {
		return Alert{}, false
	}
	var data map[string]any
	if json.Unmarshal([]byte(m), &data) != nil || data == nil {
		return Alert{}, false
	}
	a := Alert{VM: "unknown", Rule: "Unknown"}
	if v, ok := data["vm"]; ok {
		a.VM = pyStr(v, "unknown")
	}
	if v, ok := data["ts"]; ok {
		a.TS = pyStr(v, "")
	}
	if ad, ok := data["alert"].(map[string]any); ok {
		if v, ok := ad["rule"]; ok {
			a.Rule = pyStr(v, "Unknown")
		}
		if v, ok := ad["path"]; ok {
			a.Path = pyStr(v, "")
		}
	}
	return a, true
}

// Format returns the ntfy title and message of an alert.
func Format(a Alert) (string, string) {
	return "🔴 Sauron Alert: " + a.Rule, fmt.Sprintf("VM: %s\nPath: %s\nTime: %s", a.VM, a.Path, a.TS)
}

// ProcessChunk handles newly read bytes: complete lines only. It returns the alerts and the number of bytes consumed
// (a trailing partial line is left for the next read so that a line is never split across two passes).
func ProcessChunk(chunk []byte) ([]Alert, int) {
	var out []Alert
	consumed := 0
	for {
		i := bytes.IndexByte(chunk[consumed:], '\n')
		if i < 0 {
			break
		}
		line := string(chunk[consumed : consumed+i])
		consumed += i + 1
		if a, ok := ParseAlert(line); ok {
			out = append(out, a)
		}
	}
	return out, consumed
}

// Bridge tails SyslogFile and publishes alerts.
type Bridge struct {
	SyslogFile string
	StateFile  string
	Pub        ntfyc.Publisher
	Logf       func(string, ...any)
	Offset     int64
}

func (b *Bridge) logf(f string, a ...any) {
	if b.Logf != nil {
		b.Logf(f, a...)
	}
}

// LoadOffset reads the saved offset, 0 on any error.
func LoadOffset(path string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// Pass reads from the current offset to the end of the file once, publishing alerts.
func (b *Bridge) Pass() {
	f, err := os.Open(b.SyslogFile)
	if err != nil {
		b.logf("Error: %v", err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		b.logf("Error: %v", err)
		return
	}
	if b.Offset > st.Size() {
		b.Offset = 0 // rotated
	}
	if _, err := f.Seek(b.Offset, io.SeekStart); err != nil {
		b.logf("Error: %v", err)
		return
	}
	data, err := io.ReadAll(f)
	if err != nil {
		b.logf("Error: %v", err)
		return
	}
	alerts, used := ProcessChunk(data)
	for _, a := range alerts {
		title, msg := Format(a)
		if b.Pub.Publish(ntfyc.Message{Topic: Topic, Title: title, Body: msg, Priority: "high", Tags: []string{"warning", "sauron"}}, 10*time.Second) {
			b.logf("Sent alert: %s on %s", a.Rule, a.VM)
		}
	}
	b.Offset += int64(used)
	if b.StateFile != "" {
		_ = os.WriteFile(b.StateFile, []byte(strconv.FormatInt(b.Offset, 10)), 0o644)
	}
}
