// Package ntfyc is the one place that talks to a ntfy server (publish) and the one place that can be switched to a
// dry-run sink. The shadow stage runs every sender in dry-run: it logs what it WOULD publish and never reaches a topic.
package ntfyc

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Message is one publish.
type Message struct {
	Topic    string
	Title    string
	Body     string
	Priority string
	Tags     []string
	Click    string
	// Authorization is sent verbatim when non-empty (broker uses a bearer token read from the environment).
	Authorization string
}

// Publisher publishes a message and reports success (HTTP 200).
type Publisher interface {
	Publish(m Message, timeout time.Duration) bool
}

// HTTP publishes to a ntfy base URL.
type HTTP struct {
	Base   string
	Client *http.Client
	Logf   func(string, ...any)
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Headers returns the request headers for m exactly as the Python senders built them.
func Headers(m Message) http.Header {
	h := http.Header{}
	h["Title"] = []string{trunc(m.Title, 250)}
	h["Priority"] = []string{m.Priority}
	if len(m.Tags) > 0 {
		h["Tags"] = []string{strings.Join(m.Tags, ",")}
	}
	if m.Click != "" {
		h["Click"] = []string{m.Click}
	}
	if m.Authorization != "" {
		h["Authorization"] = []string{m.Authorization}
	}
	return h
}

// Publish implements Publisher.
func (p *HTTP) Publish(m Message, timeout time.Duration) bool {
	c := p.Client
	if c == nil {
		c = &http.Client{}
	}
	ctx, cancel := contextWithTimeout(timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.Base, "/")+"/"+m.Topic, bytes.NewReader([]byte(m.Body)))
	if err != nil {
		p.logf("ntfy error: %v", err)
		return false
	}
	for k, v := range Headers(m) {
		req.Header[k] = v
	}
	resp, err := c.Do(req)
	if err != nil {
		p.logf("ntfy error: %v", err)
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == 200
}

func (p *HTTP) logf(f string, a ...any) {
	if p.Logf != nil {
		p.Logf(f, a...)
	}
}

// DryRun records publishes instead of sending them.
type DryRun struct {
	mu   sync.Mutex
	Sent []Message
	Logf func(string, ...any)
}

// Publish implements Publisher; it always "succeeds".
func (d *DryRun) Publish(m Message, _ time.Duration) bool {
	d.mu.Lock()
	d.Sent = append(d.Sent, m)
	d.mu.Unlock()
	if d.Logf != nil {
		d.Logf("shadow dry-run publish topic=%s priority=%s title=%q", m.Topic, m.Priority, trunc(m.Title, 250))
	}
	return true
}

// Messages returns a copy of what was recorded.
func (d *DryRun) Messages() []Message {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Message, len(d.Sent))
	copy(out, d.Sent)
	return out
}
