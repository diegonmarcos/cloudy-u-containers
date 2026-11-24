package broker

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"ntfy-sidecars/ntfyc"
)

// PriorityFor maps a severity to a ntfy priority (severity_levels.<sev>.priority, else the fixed table).
func PriorityFor(severity string, p *Policy) string {
	levels := asM(p.Raw["severity_levels"])
	if lv, ok := levels[severity].(M); ok {
		if pr, ok := lv["priority"]; ok {
			return pyStr(pr)
		}
	}
	switch severity {
	case "info":
		return "default"
	case "warn":
		return "high"
	case "crit", "page":
		return "urgent"
	}
	return "default"
}

// Dispatcher sends decided actions over their transports. Secrets are read from the environment at send time.
type Dispatcher struct {
	Policy *Policy
	// Ntfy publishes ntfy actions; a ntfyc.DryRun in the shadow stage.
	Ntfy ntfyc.Publisher
	// DryRun suppresses the matrix and email transports as well (they only log).
	DryRun bool
	Client *http.Client
	Logf   func(string, ...any)
	Getenv func(string) string
}

func (d *Dispatcher) logf(f string, a ...any) {
	if d.Logf != nil {
		d.Logf(f, a...)
	}
}

func (d *Dispatcher) env(k string) string {
	if d.Getenv != nil {
		return d.Getenv(k)
	}
	return os.Getenv(k)
}

func (d *Dispatcher) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return http.DefaultClient
}

func str(m M, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return pyStr(v)
	}
	return ""
}

// Dispatch sends one action and reports success.
func (d *Dispatcher) Dispatch(a M) bool {
	kind := pyStr(a["kind"])
	pol := d.Policy.Raw
	switch kind {
	case "ntfy":
		ntfy := asM(pol["ntfy"])
		topic, _ := a["topic"].(string)
		if topic == "" {
			d.logf("[broker] skip ntfy action without topic: %s", pyStr(a["key"]))
			return false
		}
		if valid := asList(pol["valid_topics"]); len(valid) > 0 {
			found := false
			for _, v := range valid {
				if v == topic {
					found = true
					break
				}
			}
			if !found {
				d.logf("[broker] ERROR unknown topic '%s' (not in valid_topics) — dropping", topic)
				return false
			}
		}
		timeout := time.Duration(num(get(ntfy, "timeout_secs", 5.0), 5) * float64(time.Second))
		msg := ntfyc.Message{
			Topic:    topic,
			Title:    pyStr(a["title"]),
			Body:     pyStr(a["body"]),
			Priority: PriorityFor(pyStr(a["severity"]), d.Policy),
		}
		if te := str(asM(asM(pol["channels"])["ntfy"]), "token_env"); te != "" {
			if tok := d.env(te); tok != "" {
				msg.Authorization = "Bearer " + tok
			}
		}
		if d.Ntfy == nil {
			return false
		}
		return d.Ntfy.Publish(msg, timeout)
	case "matrix":
		ch := asM(asM(pol["channels"])["matrix"])
		if !truthy(ch["enabled"]) {
			return false
		}
		tok := d.env(str(ch, "token_env"))
		if tok == "" {
			d.logf("[broker] matrix token missing — skipping matrix action")
			return false
		}
		if d.DryRun {
			d.logf("shadow dry-run matrix action key=%s", pyStr(a["key"]))
			return true
		}
		hs := strings.TrimRight(str(ch, "homeserver"), "/")
		room := str(ch, "room")
		txn := time.Now().UnixMilli()
		u := hs + "/_matrix/client/v3/rooms/" + url.PathEscape(room) + "/send/m.room.message/" + itoa(txn)
		payload, _ := json.Marshal(M{"msgtype": "m.text", "body": pyStr(a["title"]) + "\n" + pyStr(a["body"])})
		return d.send(http.MethodPut, u, payload, tok, 8*time.Second, 200, 201)
	case "email":
		ch := asM(asM(pol["channels"])["email"])
		if !truthy(ch["enabled"]) {
			return false
		}
		key := d.env(str(ch, "resend_key_env"))
		if key == "" {
			d.logf("[broker] resend key missing — skipping email action")
			return false
		}
		if d.DryRun {
			d.logf("shadow dry-run email action key=%s", pyStr(a["key"]))
			return true
		}
		payload, _ := json.Marshal(M{
			"from":    ch["from"],
			"to":      []any{ch["to"]},
			"subject": "[" + strings.ToUpper(pyStr(a["severity"])) + "] " + pyStr(a["title"]),
			"text":    a["body"],
		})
		return d.send(http.MethodPost, "https://api.resend.com/emails", payload, key, 10*time.Second, 200, 202)
	}
	d.logf("[broker] unknown channel kind: %s", kind)
	return false
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (d *Dispatcher) send(method, u string, payload []byte, bearer string, timeout time.Duration, ok ...int) bool {
	req, err := http.NewRequest(method, u, bytes.NewReader(payload))
	if err != nil {
		d.logf("[broker] dispatch error: %v", err)
		return false
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Content-Type", "application/json")
	c := *d.client()
	c.Timeout = timeout
	resp, err := c.Do(req)
	if err != nil {
		d.logf("[broker] dispatch error: %v", err)
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	for _, c := range ok {
		if resp.StatusCode == c {
			return true
		}
	}
	return false
}
