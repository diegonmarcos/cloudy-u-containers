// Package ghrss is the Go port of github-rss-to-ntfy.py: GitHub activity Atom feeds routed to categorised ntfy topics.
package ghrss

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"ntfy-sidecars/ntfyc"
)

// Topic routing by event type.
const (
	TopicCommits = "dev_commits"
	TopicPRs     = "dev_pull-requests"
	TopicOther   = "dev_releases"
)

// Feed is one monitored feed.
type Feed struct {
	Name string
	URL  string
	Icon string
}

// DefaultFeeds are the feeds the Python bridge monitors.
var DefaultFeeds = []Feed{{Name: "diegonmarcos activity", URL: "https://github.com/diegonmarcos.atom", Icon: "octocat"}}

// Classify maps an event title to (topic, event type).
func Classify(title string) (string, string) {
	t := strings.ToLower(title)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(t, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("pushed to", "committed"):
		return TopicCommits, "push"
	case has("created branch", "deleted branch"):
		return TopicCommits, "branch"
	case has("pull request", "merged"):
		return TopicPRs, "pr"
	case has("released", "tagged", "created tag"):
		return TopicOther, "release"
	case has("issue", "opened", "closed"):
		return TopicOther, "issue"
	case has("forked", "starred", "watched"):
		return TopicOther, "social"
	}
	return TopicOther, "other"
}

var tagRE = regexp.MustCompile(`<[^>]+>`)

// StripHTML removes tags, decodes the four basic entities and collapses whitespace.
func StripHTML(text string) string {
	if text == "" {
		return ""
	}
	text = tagRE.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&lt;", "<")
	text = strings.ReplaceAll(text, "&gt;", ">")
	text = strings.ReplaceAll(text, "&quot;", `"`)
	return strings.Join(strings.Fields(text), " ")
}

// Entry is one parsed feed entry.
type Entry struct {
	ID      string
	Title   string
	Link    string
	Updated string
	Content string
}

type node struct {
	space, local string
	attrs        []xml.Attr
	text         string
	tail         string
	hasText      bool
	children     []*node
}

func (n *node) itertext() string {
	var sb strings.Builder
	sb.WriteString(n.text)
	for _, c := range n.children {
		sb.WriteString(c.itertext())
		sb.WriteString(c.tail)
	}
	return sb.String()
}

func parseTree(data string) (*node, error) {
	dec := xml.NewDecoder(strings.NewReader(data))
	dec.CharsetReader = func(label string, in io.Reader) (io.Reader, error) { return in, nil }
	var root *node
	var stack []*node
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &node{space: t.Name.Space, local: t.Name.Local, attrs: t.Attr}
			if len(stack) > 0 {
				p := stack[len(stack)-1]
				p.children = append(p.children, n)
			} else if root == nil {
				root = n
			}
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if len(stack) == 0 {
				continue
			}
			p := stack[len(stack)-1]
			if len(p.children) == 0 {
				p.text += string(t)
			} else {
				last := p.children[len(p.children)-1]
				last.tail += string(t)
			}
		}
	}
	if root == nil {
		return nil, io.ErrUnexpectedEOF
	}
	return root, nil
}

const atomNS = "http://www.w3.org/2005/Atom"

func (n *node) child(local string) *node {
	for _, c := range n.children {
		if c.space == atomNS && c.local == local {
			return c
		}
	}
	return nil
}

func (n *node) descendants(local string, out *[]*node) {
	for _, c := range n.children {
		if c.space == atomNS && c.local == local {
			*out = append(*out, c)
		}
		c.descendants(local, out)
	}
}

func md5hex12(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])[:12]
}

func runeCut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// ParseAtom parses the latest 10 entries. A malformed document yields none, as in the Python bridge.
func ParseAtom(xmlContent string) []Entry {
	root, err := parseTree(xmlContent)
	if err != nil {
		return nil
	}
	var nodes []*node
	root.descendants("entry", &nodes)
	var entries []Entry
	for _, e := range nodes {
		title := e.child("title")
		link := e.child("link")
		updated := e.child("updated")
		content := e.child("content")

		contentText := ""
		if content != nil {
			contentText = runeCut(StripHTML(content.itertext()), 200)
		}
		titleText := ""
		if title != nil {
			titleText = title.text
			if titleText == "" {
				// Python: title.text is None for an empty element and None.encode() aborts the parse; keep what we have.
				break
			}
		}
		href := ""
		if link != nil {
			for _, a := range link.attrs {
				if a.Name.Local == "href" {
					href = a.Value
				}
			}
		}
		upd := ""
		if updated != nil {
			upd = updated.text
		}
		shown := "No title"
		if title != nil {
			shown = titleText
		}
		entries = append(entries, Entry{ID: md5hex12(titleText), Title: shown, Link: href, Updated: upd, Content: contentText})
	}
	if len(entries) > 10 {
		entries = entries[:10]
	}
	return entries
}

var tagMap = map[string]string{
	"push": "arrow_up", "branch": "herb", "pr": "twisted_rightwards_arrows", "release": "package",
	"issue": "exclamation", "social": "star", "other": "octocat",
}

// Notification is what would be published for one entry.
type Notification struct {
	Topic string
	Title string
	Body  string
	Tags  []string
	Click string
}

// BuildNotification turns an entry into its notification, exactly as the Python main loop does.
func BuildNotification(e Entry, icon string) Notification {
	topic, eventType := Classify(e.Title)
	repo := ""
	if e.Link != "" {
		parts := strings.Split(strings.ReplaceAll(e.Link, "https://github.com/", ""), "/")
		if len(parts) >= 2 {
			repo = parts[0] + "/" + parts[1]
		}
	}
	var msg []string
	if repo != "" {
		msg = append(msg, "Repo: "+repo)
	}
	if e.Content != "" {
		msg = append(msg, e.Content)
	}
	msg = append(msg, "Link: "+e.Link)
	if icon == "" {
		icon = "octocat"
	}
	return Notification{
		Topic: topic,
		Title: "[" + strings.ToUpper(eventType) + "] " + runeCut(e.Title, 100),
		Body:  strings.Join(msg, "\n"),
		Tags:  []string{tagMap[eventType], icon},
		Click: e.Link,
	}
}

// Bridge is the polling loop state.
type Bridge struct {
	Feeds     []Feed
	StateFile string
	Pub       ntfyc.Publisher
	Client    *http.Client
	Now       func() time.Time
	Logf      func(string, ...any)
	Seen      map[string]float64
}

func (b *Bridge) logf(f string, a ...any) {
	if b.Logf != nil {
		b.Logf(f, a...)
	}
}

// LoadSeen reads the seen-state file; errors yield an empty map.
func LoadSeen(path string) map[string]float64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]float64{}
	}
	m := map[string]float64{}
	if json.Unmarshal(raw, &m) != nil {
		return map[string]float64{}
	}
	return m
}

func (b *Bridge) send(n Notification) bool {
	ok := b.Pub.Publish(ntfyc.Message{Topic: n.Topic, Title: n.Title, Body: n.Body, Priority: "default", Tags: n.Tags, Click: n.Click}, 10*time.Second)
	if ok && n.Topic != "all" {
		_ = b.Pub.Publish(ntfyc.Message{Topic: "all", Title: n.Title, Body: n.Body, Priority: "default", Tags: append(append([]string{}, n.Tags...), n.Topic), Click: n.Click}, 5*time.Second)
	}
	return ok
}

func (b *Bridge) fetch(url string) (string, bool) {
	c := b.Client
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		b.logf("Feed fetch error: %v", err)
		return "", false
	}
	req.Header.Set("User-Agent", "ntfy-rss-bridge/1.0")
	resp, err := c.Do(req)
	if err != nil {
		b.logf("Feed fetch error: %v", err)
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b.logf("Feed fetch error: HTTP %d", resp.StatusCode)
		return "", false
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		b.logf("Feed fetch error: %v", err)
		return "", false
	}
	return string(raw), true
}

// Cycle runs one pass over every feed, then prunes entries older than 7 days and saves the state.
func (b *Bridge) Cycle() {
	if b.Seen == nil {
		b.Seen = LoadSeen(b.StateFile)
	}
	now := b.Now
	if now == nil {
		now = time.Now
	}
	for _, f := range b.Feeds {
		b.logf("Checking: %s", f.Name)
		content, ok := b.fetch(f.URL)
		if !ok || content == "" {
			continue
		}
		feedKey := md5hex12(f.URL)[:8]
		for _, e := range ParseAtom(content) {
			k := feedKey + ":" + e.ID
			if _, seen := b.Seen[k]; seen {
				continue
			}
			n := BuildNotification(e, f.Icon)
			if b.send(n) {
				b.logf("Sent [%s] -> %s: %s...", n.Title, n.Topic, runeCut(e.Title, 50))
				b.Seen[k] = float64(now().UnixNano()) / 1e9
			}
		}
	}
	cutoff := float64(now().UnixNano())/1e9 - 7*24*3600
	for k, v := range b.Seen {
		if v <= cutoff {
			delete(b.Seen, k)
		}
	}
	if raw, err := json.Marshal(b.Seen); err == nil && b.StateFile != "" {
		_ = os.WriteFile(b.StateFile, raw, 0o644)
	}
}
