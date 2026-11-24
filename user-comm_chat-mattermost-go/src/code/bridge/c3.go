package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"mm-bridge/pyjson"
)

// ---- ntfy stream -> Mattermost webhook --------------------------------------------------------------------------

// FormatMessage renders one ntfy message as Mattermost markdown.
func FormatMessage(msg map[string]any) string {
	title := pyjson.Str(getOr(msg, "title", ""))
	body := pyjson.Str(getOr(msg, "message", ""))
	priority := 3.0
	if f, ok := msg["priority"].(float64); ok {
		priority = f
	}
	var parts []string
	if priority >= 4 {
		parts = append(parts, "**ALERT**")
	}
	if title != "" {
		parts = append(parts, "**"+title+"**")
	}
	if body != "" {
		parts = append(parts, body)
	}
	if tags, ok := msg["tags"].([]any); ok && len(tags) > 0 {
		var ts []string
		for _, t := range tags {
			ts = append(ts, pyjson.Str(t))
		}
		parts = append(parts, "_Tags: "+strings.Join(ts, ", ")+"_")
	}
	out := strings.Join(parts, "\n")
	if out == "" {
		return "(empty notification)"
	}
	return out
}

func getOr(m map[string]any, k string, def any) any {
	if v, ok := m[k]; ok {
		return v
	}
	return def
}

// SubscribeAndBridge reads the ntfy JSON stream and posts every message event to the webhook. It returns when the
// stream ends or breaks (the caller reconnects with backoff).
func (b *Bridge) SubscribeAndBridge(webhookURL string) error {
	u := b.Cfg.NtfyURL + "/" + b.Cfg.Topics + "/json"
	n := len(strings.Split(b.Cfg.Topics, ","))
	b.logf("Subscribing to %d topics: %s", n, trunc(b.Cfg.Topics, 120))
	c := *b.HTTP
	c.Timeout = 0
	resp, err := c.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d for url: %s", resp.StatusCode, u)
	}
	b.logf("Connected to ntfy stream")
	rd := bufio.NewReader(resp.Body)
	for {
		line, err := rd.ReadBytes('\n')
		if t := strings.TrimSpace(string(line)); t != "" {
			var msg map[string]any
			if json.Unmarshal([]byte(t), &msg) == nil && msg != nil && msg["event"] == "message" {
				topic := pyjson.Str(getOr(msg, "topic", "unknown"))
				b.logf("Received [%s]: %s", topic, trunc(pyjson.Str(getOr(msg, "message", "")), 80))
				_, perr := b.do("POST", webhookURL, nil, map[string]any{"channel": SanitizeChannel(topic), "text": FormatMessage(msg), "username": "ntfy"}, 10*time.Second)
				if perr != nil {
					b.logf("Failed to post to %s: %v", topic, perr)
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// ---- C3 command bot --------------------------------------------------------------------------------------------

// reason is http.client.responses[status] for the statuses requests reports in its HTTPError text.
func reason(status int) string { return http.StatusText(status) }

// C3Req calls the C3 API. Success returns the decoded JSON (ordered); any failure returns {"error": "..."} exactly
// as the Python helper does (requests' error text for HTTP statuses).
func (b *Bridge) C3Req(method, path string, timeout time.Duration) any {
	errObj := func(msg string) any {
		o := pyjson.NewOMap()
		o.Set("error", msg)
		return o
	}
	if b.ReadOnly && method != http.MethodGet {
		return errObj("shadow stage: read-only, " + method + " " + path + " refused")
	}
	h := Headers{}
	if b.Cfg.C3Token != "" {
		h["Authorization"] = "Bearer " + b.Cfg.C3Token
	}
	full := b.Cfg.C3APIURL + path
	r, err := b.do(method, full, h, nil, timeout)
	if err != nil {
		return errObj(err.Error())
	}
	if r.Status >= 400 {
		kind := "Client"
		if r.Status >= 500 {
			kind = "Server"
		}
		return errObj(fmt.Sprintf("%d %s Error: %s for url: %s", r.Status, kind, reason(r.Status), full))
	}
	v, err := pyjson.Loads(r.Body)
	if err != nil {
		return errObj(err.Error())
	}
	return v
}

func items(data any) []any {
	if l, ok := data.([]any); ok {
		return l
	}
	l, _ := pyjson.GetOr(data, "results", []any{}).([]any)
	return l
}

func g(item any, k string, def any) any { return pyjson.GetOr(item, k, def) }

func fallbackBlock(data any) string { return "```\n" + pyjson.Dumps(data, 2) + "\n```" }

// FormatTier1 renders tier1 health as a markdown table.
func FormatTier1(data any) string {
	its := items(data)
	if len(its) == 0 {
		return fallbackBlock(data)
	}
	lines := []string{"| VM | Status |", "|:---|:---|"}
	for _, it := range its {
		alias := pyjson.Str(g(it, "alias", g(it, "vm", "?")))
		up := ":x: DOWN"
		if pyjson.Truthy(g(it, "reachable", nil)) {
			up = ":white_check_mark: UP"
		}
		lines = append(lines, fmt.Sprintf("| %s | %s |", alias, up))
	}
	return strings.Join(lines, "\n")
}

// FormatTier3 renders tier3 health as a markdown table.
func FormatTier3(data any) string {
	its := items(data)
	if len(its) == 0 {
		return fallbackBlock(data)
	}
	lines := []string{"| VM | Mem | Disk | Containers |", "|:---|:---|:---|:---|"}
	for _, it := range its {
		alias := pyjson.Str(g(it, "alias", g(it, "vm", "?")))
		res := g(it, "resources", pyjson.NewOMap())
		mem, disk := "?", "?"
		if _, ok := res.(*pyjson.OMap); ok {
			used := g(res, "memoryUsed", "?")
			total := g(res, "memoryTotal", "?")
			if us, isStr := used.(string); !(isStr && us == "?") {
				mem = pyjson.Str(used) + "/" + pyjson.Str(total)
			}
			disk = pyjson.Str(g(res, "diskPercent", "?"))
		}
		ct := "?"
		if l, ok := g(it, "containers", []any{}).([]any); ok {
			ct = fmt.Sprint(len(l))
		}
		up := ":x:"
		if pyjson.Truthy(g(it, "reachable", nil)) {
			up = ":white_check_mark:"
		}
		lines = append(lines, fmt.Sprintf("| %s %s | %s | %s | %s |", up, alias, mem, disk, ct))
	}
	return strings.Join(lines, "\n")
}

// errorOf returns data["error"] when the C3 call failed (Python: `"error" in data`, which for a list is membership).
func errorOf(data any) (string, bool) {
	switch t := data.(type) {
	case *pyjson.OMap:
		if v, ok := t.Get("error"); ok {
			return pyjson.Str(v), true
		}
	case []any:
		for _, x := range t {
			if xs, ok := x.(string); ok && xs == "error" {
				return "", true
			}
		}
	}
	return "", false
}

// HandleC3Command parses and routes one /c3 command line and returns the markdown answer.
func (b *Bridge) HandleC3Command(text string) string {
	parts := strings.Fields(text)
	cmd := "help"
	if len(parts) > 0 {
		cmd = strings.ToLower(parts[0])
	}
	var args []string
	if len(parts) > 1 {
		args = parts[1:]
	}
	simple := func(method, path, okFmt string, a ...any) string {
		data := b.C3Req(method, path, 30*time.Second)
		if e, bad := errorOf(data); bad {
			return ":x: " + e
		}
		return fmt.Sprintf(okFmt, a...)
	}
	switch {
	case cmd == "status":
		return FormatTier1(b.C3Req("GET", "/health/tier1", 30*time.Second))
	case cmd == "vms":
		return FormatTier3(b.C3Req("GET", "/health/tier3", 120*time.Second))
	case cmd == "wake" && len(args) >= 1:
		return simple("POST", "/vms/"+args[0]+"/start", ":rocket: Start requested for **%s**", args[0])
	case cmd == "sleep" && len(args) >= 1:
		return simple("POST", "/vms/"+args[0]+"/stop", ":zzz: Stop requested for **%s**", args[0])
	case cmd == "reset" && len(args) >= 1:
		return simple("POST", "/vms/"+args[0]+"/reset", ":arrows_counterclockwise: Reset requested for **%s**", args[0])
	case cmd == "ps" && len(args) >= 1:
		data := b.C3Req("GET", "/health/deployed/"+args[0], 30*time.Second)
		if om, ok := data.(*pyjson.OMap); ok {
			if e, bad := errorOf(om); bad {
				return ":x: " + e
			}
		}
		var containers []any
		if l, ok := data.([]any); ok {
			for _, entry := range l {
				if pyjson.Has(entry, "containers") {
					containers, _ = pyjson.GetOr(entry, "containers", []any{}).([]any)
					break
				} else if pyjson.Has(entry, "name") {
					containers = l
					break
				}
			}
		}
		if len(containers) > 0 {
			lines := []string{"| Container | Status |", "|:---|:---|"}
			for _, c := range containers {
				name := pyjson.Str(g(c, "name", "?"))
				status := pyjson.Str(g(c, "status", g(c, "state", "?")))
				lines = append(lines, fmt.Sprintf("| %s | %s |", name, status))
			}
			return strings.Join(lines, "\n")
		}
		return "No containers found"
	case cmd == "start" && len(args) >= 2:
		return simple("POST", "/vms/"+args[0]+"/containers/"+args[1]+"/start", ":white_check_mark: Started **%s** on **%s**", args[1], args[0])
	case cmd == "stop" && len(args) >= 2:
		return simple("POST", "/vms/"+args[0]+"/containers/"+args[1]+"/stop", ":octagonal_sign: Stopped **%s** on **%s**", args[1], args[0])
	case cmd == "restart" && len(args) >= 2:
		return simple("POST", "/vms/"+args[0]+"/containers/"+args[1]+"/restart", ":arrows_counterclockwise: Restarted **%s** on **%s**", args[1], args[0])
	}
	return "**C3 Infrastructure Commands**\n" +
		"_DM me directly or use `/c3` in any channel_\n\n" +
		"| Command | Description |\n" +
		"|:---|:---|\n" +
		"| `status` | All VMs UP/DOWN |\n" +
		"| `vms` | VMs with CPU/RAM/disk |\n" +
		"| `wake <vm>` | Start a VM |\n" +
		"| `sleep <vm>` | Stop a VM |\n" +
		"| `reset <vm>` | Force reset a VM |\n" +
		"| `ps <vm>` | List containers on VM |\n" +
		"| `start <vm> <c>` | Start a container |\n" +
		"| `stop <vm> <c>` | Stop a container |\n" +
		"| `restart <vm> <c>` | Restart a container |\n" +
		"| `help` | Show this message |"
}

func (b *Bridge) makeButtons(actions [][2]string) []any {
	var out []any
	for _, a := range actions {
		cmd := a[1]
		integ := pyjson.NewOMap()
		integ.Set("url", b.Cfg.ActionURL)
		ctx := pyjson.NewOMap()
		ctx.Set("command", cmd)
		integ.Set("context", ctx)
		btn := pyjson.NewOMap()
		btn.Set("name", cmd)
		btn.Set("integration", integ)
		out = append(out, btn)
	}
	return out
}

func attachment(text string, actions []any) []any {
	a := pyjson.NewOMap()
	a.Set("text", text)
	a.Set("actions", actions)
	return []any{a}
}

// HelpAttachments is the help message with quick-action buttons.
func (b *Bridge) HelpAttachments() []any {
	return attachment("_Quick actions:_", b.makeButtons([][2]string{{":bar_chart: Status", "status"}, {":desktop_computer: VMs", "vms"}, {":rocket: GPU", "gpu"}}))
}

// StatusAttachments offers wake/sleep/ps buttons per VM after a status answer.
func (b *Bridge) StatusAttachments(data any) []any {
	var actions [][2]string
	for _, it := range items(data) {
		alias := pyjson.Str(g(it, "alias", g(it, "vm", "?")))
		if pyjson.Truthy(g(it, "reachable", nil)) {
			actions = append(actions, [2]string{":zzz: " + alias, "sleep " + alias}, [2]string{":page_facing_up: " + alias, "ps " + alias})
		} else {
			actions = append(actions, [2]string{":rocket: " + alias, "wake " + alias})
		}
	}
	if len(actions) > 0 {
		if len(actions) > 8 {
			actions = actions[:8]
		}
		return attachment("_Actions:_", b.makeButtons(actions))
	}
	return nil
}

// commandAnswer is the shared answer + attachments computation of the slash handler and the websocket bot.
func (b *Bridge) commandAnswer(text string) (response string, attachments []any, hasProps bool) {
	defer func() {
		if r := recover(); r != nil {
			response, attachments, hasProps = fmt.Sprintf(":x: Error: %v", r), nil, false
		}
	}()
	response = b.HandleC3Command(text)
	fields := strings.Fields(text)
	cmd := "help"
	if len(fields) > 0 {
		cmd = strings.ToLower(fields[0])
	}
	switch cmd {
	case "help", "":
		attachments, hasProps = b.HelpAttachments(), true
	case "status":
		attachments, hasProps = b.StatusAttachments(b.C3Req("GET", "/health/tier1", 30*time.Second)), true
	}
	return response, attachments, hasProps
}

// SlashHandler serves the /c3 slash command (form encoded) and the interactive button callbacks (/c3/action, JSON).
func (b *Bridge) SlashHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Unsupported method", http.StatusNotImplemented)
			return
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		action := r.URL.Path == "/c3/action"
		text := "help"
		if action {
			var payload map[string]any
			if json.Unmarshal(raw, &payload) == nil {
				text = "help"
				if ctx, ok := payload["context"].(map[string]any); ok {
					if c, ok := ctx["command"]; ok {
						text = pyjson.Str(c)
					}
				}
			}
		} else if vals, err := url.ParseQuery(string(raw)); err == nil {
			if t := vals.Get("text"); t != "" { // parse_qs drops blank values
				text = t
			}
		}
		b.logf("C3 command: %s", text)
		response, attachments, _ := b.commandAnswer(text)
		var out any
		if action {
			props := pyjson.NewOMap()
			if attachments == nil {
				attachments = []any{}
			}
			props.Set("attachments", attachments)
			upd := pyjson.NewOMap()
			upd.Set("message", response)
			upd.Set("props", props)
			o := pyjson.NewOMap()
			o.Set("update", upd)
			out = o
		} else {
			o := pyjson.NewOMap()
			o.Set("response_type", "in_channel")
			o.Set("text", response)
			if len(attachments) > 0 {
				o.Set("attachments", attachments)
			}
			out = o
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(pyjson.Dumps(out, -1)))
	})
}

var mentionRE = regexp.MustCompile(`@c3-bot\s*`)

// BotReply decides what the c3-bot answers to one websocket frame: nil when it stays silent, else the post body.
func (b *Bridge) BotReply(frame []byte, botUserID string) map[string]any {
	var data map[string]any
	if json.Unmarshal(frame, &data) != nil || data["event"] != "posted" {
		return nil
	}
	pd, _ := data["data"].(map[string]any)
	channelType := s(pd["channel_type"])
	rawPost, ok := pd["post"].(string)
	if !ok {
		return nil
	}
	var post map[string]any
	if json.Unmarshal([]byte(rawPost), &post) != nil {
		return nil
	}
	if s(post["user_id"]) == botUserID {
		return nil
	}
	text := strings.TrimSpace(s(post["message"]))
	if text == "" {
		return nil
	}
	isDM := channelType == "D"
	if !isDM {
		if !strings.Contains(strings.ToLower(text), "@c3-bot") {
			return nil
		}
		text = strings.TrimSpace(mentionRE.ReplaceAllString(text, ""))
		if text == "" {
			text = "help"
		}
	}
	rootID := ""
	if !isDM {
		rootID = s(post["id"])
	}
	b.logf("C3 bot %s: %s", map[bool]string{true: "DM", false: "mention"}[isDM], trunc(text, 80))
	response, attachments, hasProps := b.commandAnswer(text)
	body := map[string]any{"channel_id": post["channel_id"], "message": response}
	if hasProps {
		if attachments == nil {
			attachments = []any{}
		}
		body["props"] = map[string]any{"attachments": attachments}
	}
	if rootID != "" {
		body["root_id"] = rootID
	}
	return body
}
