// Package rssgw is the Go port of rss-gateway.py: ntfy topic groups served as Atom feeds plus the discovery JSON.
// Output is byte-identical to the Python gateway (ordered JSON, ensure_ascii, the same Atom text including its
// double-escaping quirks) so the parity harness can diff whole response bodies.
package rssgw

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"ntfy-sidecars/pyjson"
)

const atomNS = "http://www.w3.org/2005/Atom"

// Gateway holds the configuration of one gateway instance.
type Gateway struct {
	ProfilesConfig string
	ChannelsConfig string
	NtfyInternal   string
	PollSince      string
	Client         *http.Client
	Now            func() time.Time
	Logf           func(string, ...any)
}

// New returns a gateway with the production defaults.
func New() *Gateway {
	return &Gateway{
		ProfilesConfig: "/etc/ntfy/profiles-config.json",
		ChannelsConfig: "/etc/ntfy/channels-config.json",
		NtfyInternal:   "http://ntfy:8090",
		PollSince:      "168h",
		Client:         &http.Client{Timeout: 15 * time.Second},
		Now:            time.Now,
	}
}

func (g *Gateway) logf(f string, a ...any) {
	if g.Logf != nil {
		g.Logf(f, a...)
	}
}

// Escape is xml.sax.saxutils.escape: & < > only.
func Escape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// ISO8601 formats an epoch second as UTC %Y-%m-%dT%H:%M:%SZ.
func ISO8601(ts int64) string { return time.Unix(ts, 0).UTC().Format("2006-01-02T15:04:05Z") }

// Msg is one ntfy message envelope.
type Msg = map[string]any

func mstr(m Msg, k, def string) string {
	v, ok := m[k]
	if !ok {
		return def
	}
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return "None"
	case float64:
		return fmt.Sprint(int64(t))
	}
	return fmt.Sprint(v)
}

func mtime(m Msg) int64 {
	if f, ok := m["time"].(float64); ok {
		return int64(f)
	}
	return 0
}

// AtomFeed renders an Atom 1.0 feed from ntfy message objects.
func (g *Gateway) AtomFeed(title, feedID, baseURL string, messages []Msg) string {
	var updated string
	if len(messages) > 0 {
		updated = ISO8601(mtime(messages[0]))
	} else {
		updated = ISO8601(g.Now().Unix())
	}
	entries := make([]string, 0, len(messages))
	for _, m := range messages {
		msgID := Escape(mstr(m, "id", ""))
		topic := Escape(mstr(m, "topic", ""))
		msgTime := ISO8601(mtime(m))
		subject := mstr(m, "title", "")
		if subject == "" {
			subject = topic
		}
		if subject == "" {
			subject = "Notification"
		}
		subject = Escape(subject)
		body := Escape(mstr(m, "message", ""))
		click := Escape(mstr(m, "click", ""))
		var tagList []string
		if tl, ok := m["tags"].([]any); ok {
			for _, t := range tl {
				tagList = append(tagList, fmt.Sprint(t))
			}
		}
		tags := strings.Join(tagList, ", ")

		parts := []string{body}
		if tags != "" {
			parts = append(parts, "Tags: "+Escape(tags))
		}
		if click != "" {
			parts = append(parts, "Link: "+Escape(click))
		}
		var kept []string
		for _, p := range parts {
			if p != "" {
				kept = append(kept, p)
			}
		}
		content := strings.Join(kept, " | ")

		entryLink := click
		if entryLink == "" {
			entryLink = baseURL + "/c/" + topic + ".atom"
		}
		entries = append(entries, fmt.Sprintf(`  <entry>
    <id>urn:ntfy:%s</id>
    <title>%s</title>
    <updated>%s</updated>
    <author><name>%s</name></author>
    <category term="%s"/>
    <content type="text">%s</content>
    <link href="%s"/>
  </entry>`, Escape(msgID), subject, msgTime, topic, topic, content, Escape(entryLink)))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="%s">
  <title>%s</title>
  <id>urn:ntfy-profile:%s</id>
  <updated>%s</updated>
  <link href="%s/%s.atom" rel="self"/>
%s
</feed>
`, atomNS, Escape(title), Escape(feedID), updated, Escape(baseURL), Escape(feedID), strings.Join(entries, "\n"))
}

// ParsePoll turns the ndjson of a ntfy poll into message envelopes, newest first (stable like Python's sort).
func ParsePoll(data string) []Msg {
	var msgs []Msg
	for _, line := range strings.Split(strings.TrimSpace(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var m Msg
		if json.Unmarshal([]byte(line), &m) != nil || m == nil {
			continue
		}
		if m["event"] == "message" {
			msgs = append(msgs, m)
		}
	}
	sort.SliceStable(msgs, func(i, j int) bool { return mtime(msgs[i]) > mtime(msgs[j]) })
	return msgs
}

func (g *Gateway) ntfyPoll(topics []string) []Msg {
	if len(topics) == 0 {
		return nil
	}
	topicStr := strings.Join(topics, ",")
	url := fmt.Sprintf("%s/%s/json?poll=1&since=%s", g.NtfyInternal, topicStr, g.PollSince)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		g.logf("ntfy poll error (%s): %v", topicStr, err)
		return nil
	}
	req.Header.Set("User-Agent", "rss-gateway/1.0")
	resp, err := g.Client.Do(req)
	if err != nil {
		g.logf("ntfy poll error (%s): %v", topicStr, err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		g.logf("ntfy poll error (%s): HTTP %d", topicStr, resp.StatusCode)
		return nil
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		g.logf("ntfy poll error (%s): %v", topicStr, err)
		return nil
	}
	return ParsePoll(string(b))
}

func (g *Gateway) loadConfig() (*pyjson.OMap, error) {
	b, err := os.ReadFile(g.ProfilesConfig)
	if err != nil {
		return nil, err
	}
	v, err := pyjson.Loads(b)
	if err != nil {
		return nil, err
	}
	m, ok := v.(*pyjson.OMap)
	if !ok {
		return nil, fmt.Errorf("profiles config is not an object")
	}
	return m, nil
}

func (g *Gateway) loadChannels() any {
	b, err := os.ReadFile(g.ChannelsConfig)
	if err != nil {
		return pyjson.NewOMap()
	}
	v, err := pyjson.Loads(b)
	if err != nil {
		return pyjson.NewOMap()
	}
	return v
}

func omapGet(v any, k string) (any, bool) {
	if m, ok := v.(*pyjson.OMap); ok {
		return m.Get(k)
	}
	return nil, false
}

func omapStr(v any, k string) (string, bool) {
	x, ok := omapGet(v, k)
	if !ok {
		return "", false
	}
	s, ok := x.(string)
	return s, ok
}

func list(v any, k string) []any {
	x, _ := omapGet(v, k)
	l, _ := x.([]any)
	return l
}

// pyErrorPage is http.server.BaseHTTPRequestHandler.send_error's body for Python 3.11.
func pyErrorPage(code int, message, explain string) string {
	esc := func(s string) string {
		s = strings.ReplaceAll(s, "&", "&amp;")
		s = strings.ReplaceAll(s, "<", "&lt;")
		return strings.ReplaceAll(s, ">", "&gt;")
	}
	return fmt.Sprintf(`<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: %d</p>
        <p>Message: %s.</p>
        <p>Error code explanation: %d - %s.</p>
    </body>
</html>
`, code, esc(message), code, esc(explain))
}

func sendError(w http.ResponseWriter, code int, message string) {
	explain := map[int]string{404: "Nothing matches the given URI", 503: "The server cannot process the request due to a high load", 501: "Server does not support this operation"}[code]
	body := pyErrorPage(code, message, explain)
	w.Header().Set("Content-Type", "text/html;charset=utf-8")
	w.Header().Set("Connection", "close")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body))
}

func writeJSON(w http.ResponseWriter, v any) {
	body := pyjson.Dumps(v, 2)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(200)
	_, _ = w.Write([]byte(body))
}

func writeAtom(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(200)
	_, _ = w.Write([]byte(body))
}

// ServeHTTP implements http.Handler with the Python gateway's routes and error pages.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, 501, fmt.Sprintf("Unsupported method ('%s')", r.Method))
		return
	}
	path := r.RequestURI
	if i := strings.Index(path, "?"); i >= 0 {
		path = path[:i]
	}
	cfg, err := g.loadConfig()
	if err != nil {
		sendError(w, 503, "Config unavailable: "+err.Error())
		return
	}
	baseURL := "https://rss.diegonmarcos.com/feed"
	if b, ok := omapStr(cfg, "base"); ok {
		baseURL = b
	}
	switch path {
	case "/feed/health", "/feed/health/":
		o := pyjson.NewOMap()
		o.Set("status", "ok")
		writeJSON(w, o)
		return
	case "/feed/profiles.json", "/feed/profiles.json/":
		writeJSON(w, cfg)
		return
	case "/feed/channels.json", "/feed/channels.json/":
		writeJSON(w, g.loadChannels())
		return
	}
	if strings.HasPrefix(path, "/feed/") && strings.HasSuffix(path, ".atom") && !strings.Contains(path, "/c/") {
		profileID := path[len("/feed/") : len(path)-len(".atom")]
		var profile any
		for _, p := range list(cfg, "profiles") {
			if id, ok := omapStr(p, "id"); ok && id == profileID {
				profile = p
				break
			}
		}
		if profile == nil {
			sendError(w, 404, "Unknown profile: "+profileID)
			return
		}
		var topics []string
		for _, ch := range list(profile, "channels") {
			if n, ok := omapStr(ch, "name"); ok {
				topics = append(topics, n)
			}
		}
		title, _ := omapStr(profile, "title")
		writeAtom(w, g.AtomFeed(title, profileID, baseURL, g.ntfyPoll(topics)))
		return
	}
	if strings.HasPrefix(path, "/feed/c/") && strings.HasSuffix(path, ".atom") {
		channel := path[len("/feed/c/") : len(path)-len(".atom")]
		all := map[string]bool{}
		for _, ch := range list(cfg, "channels") {
			if n, ok := omapStr(ch, "name"); ok {
				all[n] = true
			}
		}
		for _, ch := range list(g.loadChannels(), "channels") {
			if n, ok := omapStr(ch, "topic"); ok {
				all[n] = true
			}
		}
		if !all[channel] {
			sendError(w, 404, "Unknown channel: "+channel)
			return
		}
		writeAtom(w, g.AtomFeed(channel, channel, baseURL, g.ntfyPoll([]string{channel})))
		return
	}
	sendError(w, 404, "Not found")
}
