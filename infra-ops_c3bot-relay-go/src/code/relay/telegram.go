package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

// TelegramMax is the Telegram message cap, in UTF-16 code units like the JS string length.
const TelegramMax = 4096

// ChunkText splits text at the Telegram cap (never inside a surrogate pair).
func ChunkText(text string, max int) []string {
	if max <= 0 {
		max = TelegramMax
	}
	var out []string
	var cur strings.Builder
	n := 0
	for _, r := range text {
		w := len(utf16.Encode([]rune{r}))
		if n+w > max {
			out = append(out, cur.String())
			cur.Reset()
			n = 0
		}
		cur.WriteRune(r)
		n += w
	}
	if n > 0 || len(out) == 0 {
		out = append(out, cur.String())
	}
	return out
}

// Error carries the failure class the HTTP layer maps to a status ("unconfigured" -> 503, "telegram" -> 502).
type Error struct{ Code, Msg string }

func (e *Error) Error() string { return e.Msg }

// Telegram is the Bot API client plus the getUpdates loop state. The token is never logged.
type Telegram struct {
	Token string
	Base  string
	HTTP  *http.Client

	mu        sync.Mutex
	state     string
	lastError *string
	offset    int64
	stopped   bool
}

// NewTelegram builds a client; an empty token is "unconfigured" and never calls out.
func NewTelegram(token, base string) *Telegram {
	if base == "" {
		base = "https://api.telegram.org"
	}
	t := &Telegram{Token: token, Base: base, HTTP: &http.Client{}, state: "idle"}
	if token == "" {
		t.state = "unconfigured"
	}
	return t
}

func (t *Telegram) Configured() bool { return t.Token != "" }
func (t *Telegram) State() string    { t.mu.Lock(); defer t.mu.Unlock(); return t.state }
func (t *Telegram) LastError() *string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastError
}
func (t *Telegram) set(state string, err *string) {
	t.mu.Lock()
	t.state = state
	if err != nil || state != "error" {
		t.lastError = err
	}
	t.mu.Unlock()
}

// Redact masks the token in an error message.
func (t *Telegram) Redact(s string) string {
	if t.Token == "" {
		return s
	}
	return strings.ReplaceAll(s, t.Token, "***")
}

// API posts one Bot API method and returns the decoded JSON answer.
func (t *Telegram) API(ctx context.Context, method string, body map[string]any, timeout time.Duration) (map[string]any, error) {
	if body == nil {
		body = map[string]any{}
	}
	b, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.Base+"/bot"+t.Token+"/"+method, bytes.NewReader(b))
	if err != nil {
		return nil, errors.New(t.Redact(err.Error()))
	}
	req.Header.Set("content-type", "application/json")
	resp, err := t.HTTP.Do(req)
	if err != nil {
		return nil, errors.New(t.Redact(err.Error()))
	}
	defer resp.Body.Close()
	var j map[string]any
	d := json.NewDecoder(resp.Body)
	d.UseNumber()
	if err := d.Decode(&j); err != nil {
		return nil, errors.New(t.Redact(err.Error()))
	}
	return j, nil
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	}
	return ""
}

// Send posts sendMessage per 4096-unit chunk and returns the message ids.
func (t *Telegram) Send(ctx context.Context, chatID any, text string, threadID any) ([]any, error) {
	if !t.Configured() {
		return nil, &Error{"unconfigured", "telegram bot token not configured"}
	}
	ids := []any{}
	for _, part := range ChunkText(text, TelegramMax) {
		body := map[string]any{"chat_id": chatID, "text": part}
		if threadID != nil {
			body["message_thread_id"] = threadID
		}
		j, err := t.API(ctx, "sendMessage", body, 15*time.Second)
		if err != nil {
			return nil, err
		}
		if ok, _ := j["ok"].(bool); !ok {
			d := str(j["description"])
			if d == "" {
				d = "sendMessage failed"
			}
			return nil, &Error{"telegram", d}
		}
		ids = append(ids, obj(j["result"])["message_id"])
	}
	return ids, nil
}

func (t *Telegram) GetWebhookInfo(ctx context.Context) (map[string]any, error) {
	return t.API(ctx, "getWebhookInfo", nil, 10*time.Second)
}

func (t *Telegram) SetWebhook(ctx context.Context, url, secret string) (map[string]any, error) {
	return t.API(ctx, "setWebhook", map[string]any{"url": url, "secret_token": secret,
		"allowed_updates": []string{"message", "edited_message"}, "max_connections": 4}, 15*time.Second)
}

// Loop runs getUpdates while gate() is true (Bot A only polls while the webhook is deleted); a closed gate idles without
// touching Telegram. It returns when ctx is done or Stop is called.
func (t *Telegram) Loop(ctx context.Context, onUpdate func(map[string]any), pollTimeoutS int, backoff, idle time.Duration, gate func() bool) {
	if !t.Configured() {
		return
	}
	sleep := func(d time.Duration) {
		select {
		case <-ctx.Done():
		case <-time.After(d):
		}
	}
	for ctx.Err() == nil {
		t.mu.Lock()
		stopped := t.stopped
		off := t.offset
		t.mu.Unlock()
		if stopped {
			return
		}
		if gate != nil && !gate() {
			t.set("standby", nil)
			sleep(idle)
			continue
		}
		t.set("polling", nil)
		j, err := t.API(ctx, "getUpdates", map[string]any{"timeout": pollTimeoutS, "offset": off,
			"allowed_updates": []string{"message", "edited_message"}}, time.Duration(pollTimeoutS+15)*time.Second)
		if err != nil {
			e := t.Redact(err.Error())
			t.set("error", &e)
			sleep(backoff)
			continue
		}
		if ok, _ := j["ok"].(bool); !ok {
			e := strings.TrimSpace(str(j["error_code"]) + " " + str(j["description"]))
			t.set("error", &e)
			sleep(backoff)
			continue
		}
		res, isArr := j["result"].([]any)
		if !isArr { // a malformed answer is an error with backoff, never a hot loop
			e := "getUpdates: result is not a list"
			t.set("error", &e)
			sleep(backoff)
			continue
		}
		t.set("polling", nil)
		for _, x := range res {
			u := obj(x)
			if id, ok := u["update_id"].(json.Number); ok {
				n, _ := id.Int64()
				t.mu.Lock()
				t.offset = n + 1
				t.mu.Unlock()
			}
			onUpdate(u)
		}
	}
}

func (t *Telegram) Stop() { t.mu.Lock(); t.stopped = true; t.mu.Unlock() }
