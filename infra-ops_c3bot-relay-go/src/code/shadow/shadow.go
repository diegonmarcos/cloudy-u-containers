// Package shadow is the self-check of the shadow stage (ticket #1873): the Go relay runs beside the Node one, outside every
// request path, with ephemeral secrets and no Telegram access, and periodically drives its own HTTP contract (webhook ->
// poll, lease, send refused without a bot, bearer gate) and logs `shadow-selfcheck PASS|FAIL`. Cross-implementation
// parity (same sequences against the Node relay) is the parity package, run in CI.
package shadow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Loop runs Check every interval (first run after a short delay).
func Loop(ctx context.Context, log *slog.Logger, base, prefix, token, whSecret string, every time.Duration) {
	t := time.NewTimer(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, bad := Check(ctx, strings.Replace(base, "0.0.0.0", "127.0.0.1", 1)+prefix, token, whSecret)
			if len(bad) == 0 {
				log.Info(fmt.Sprintf("shadow-selfcheck PASS: %d cases, 0 failures", n))
			} else {
				log.Error(fmt.Sprintf("shadow-selfcheck FAIL: %d cases, %d failures", n, len(bad)), "failed", bad)
			}
			t.Reset(every)
		}
	}
}

// Check returns the number of cases run and the names of the failed ones.
func Check(ctx context.Context, base, token, whSecret string) (int, []string) {
	cl := &http.Client{Timeout: 10 * time.Second}
	do := func(method, path string, hdr map[string]string, body any) (int, map[string]any) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, err := http.NewRequestWithContext(ctx, method, base+path, rd)
		if err != nil {
			return 0, nil
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := cl.Do(req)
		if err != nil {
			return 0, nil
		}
		defer resp.Body.Close()
		var j map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&j)
		return resp.StatusCode, j
	}
	auth := map[string]string{"Authorization": "Bearer " + token}
	wh := map[string]string{"X-Telegram-Bot-Api-Secret-Token": whSecret}
	sid := fmt.Sprintf("shadow-%d", time.Now().UnixNano())
	var bad []string
	n := 0
	chk := func(name string, cond bool) {
		n++
		if !cond {
			bad = append(bad, name)
		}
	}
	c, _ := do("GET", "/health", nil, nil)
	chk("health open", c == 200)
	c, _ = do("GET", "/poll", nil, nil)
	chk("bearer gate", c == 401)
	c, _ = do("POST", "/telegram/webhook", map[string]string{"X-Telegram-Bot-Api-Secret-Token": "wrong"}, map[string]any{})
	chk("webhook wrong secret", c == 401)
	c, j := do("GET", "/poll?after=0&wait=0", auth, nil)
	cursor, _ := j["cursor"].(float64)
	chk("poll empty", c == 200)
	c, _ = do("POST", "/telegram/webhook", wh, map[string]any{"update_id": 1, "message": map[string]any{"message_id": time.Now().Unix(), "date": time.Now().Unix(), "chat": map[string]any{"id": 1}, "from": map[string]any{"id": 1}, "text": sid}})
	chk("webhook ingest", c == 200)
	c, j = do("GET", fmt.Sprintf("/poll?after=%d&wait=2", int64(cursor)), auth, nil)
	evs, _ := j["events"].([]any)
	chk("poll sees webhook event", c == 200 && len(evs) == 1)
	c, j = do("POST", "/claim", auth, map[string]any{"session": sid, "ttl": 30})
	chk("claim granted", c == 200 && j["granted"] == true)
	c, j = do("POST", "/claim", auth, map[string]any{"session": sid + "-b", "ttl": 30})
	chk("claim refused for a second session", c == 200 && j["granted"] == false)
	c, j = do("POST", "/release", auth, map[string]any{"session": sid})
	chk("release", c == 200 && j["released"] == true)
	c, _ = do("POST", "/send", auth, map[string]any{"chat_id": 1, "text": "x"})
	chk("send refused without a bot (no Telegram traffic)", c == 503)
	return n, bad
}
