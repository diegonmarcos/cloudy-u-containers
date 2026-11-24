package bridge

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func (b *Bridge) doRaw(method, url string, h Headers, body []byte, timeout time.Duration) (Resp, error) {
	req, err := http.NewRequest(method, url, strings.NewReader(string(body)))
	if err != nil {
		return Resp{}, err
	}
	for k, v := range h {
		req.Header.Set(k, v)
	}
	c := *b.HTTP
	c.Timeout = timeout
	resp, err := c.Do(req)
	if err != nil {
		return Resp{}, err
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, rerr := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if rerr != nil {
			break
		}
	}
	return Resp{Status: resp.StatusCode, Body: []byte(sb.String()), Header: resp.Header}, nil
}

// State is what Bootstrap hands to the long-running loops.
type State struct {
	WebhookURL string
	BotUserID  string
	BotToken   string
}

// Bootstrap runs main()'s setup sequence in the Python order, up to (not including) the long-running loops.
// startServer is called once the slash command is registered (Python starts the HTTP server there).
func (b *Bridge) Bootstrap(startServer func()) (*State, error) {
	if err := b.WaitForMattermost(); err != nil {
		return nil, err
	}
	token, err := b.BootstrapAdmin()
	if err != nil {
		return nil, err
	}
	h := auth(token)
	r, err := b.mm("GET", "/users/me", h, nil)
	if err != nil {
		return nil, err
	}
	me, err := r.must()
	if err != nil {
		return nil, err
	}
	userID := s(o(me)["id"])
	teamID, err := b.EnsureTeam(h)
	if err != nil {
		return nil, err
	}
	if err := b.ReconcileCategories(h, userID, teamID); err != nil {
		return nil, err
	}
	if err := b.EnsureAgentsLLMConfig(h); err != nil {
		return nil, err
	}
	defaultCh, ntfyIDs, err := b.SyncChannels(h, teamID)
	if err != nil {
		return nil, err
	}
	webhook, err := b.EnsureWebhook(h, defaultCh)
	if err != nil {
		return nil, err
	}
	if err := b.SyncSidebarCategory(h, userID, teamID, ntfyIDs); err != nil {
		return nil, err
	}
	if err := b.RegisterSlashCommand(h, teamID); err != nil {
		return nil, err
	}
	if startServer != nil {
		startServer()
	}

	var allIDs []string
	r, err = b.mm("GET", "/teams/"+teamID+"/channels?per_page=200", h, nil)
	if err != nil {
		return nil, err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil {
			for _, c := range list(v) {
				allIDs = append(allIDs, s(o(c)["id"]))
			}
		}
	}
	r, err = b.mm("GET", "/users/"+userID+"/channels", h, nil)
	if err != nil {
		return nil, err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil {
			for _, c := range list(v) {
				if s(o(c)["type"]) == "G" && !contains(allIDs, s(o(c)["id"])) {
					allIDs = append(allIDs, s(o(c)["id"]))
				}
			}
		}
	}
	if err := b.CreateClaudeUsers(h, teamID, allIDs, ntfyIDs); err != nil {
		return nil, err
	}
	st := &State{WebhookURL: webhook}
	botID, botTok, err := b.CreateBot(h, teamID)
	if err != nil {
		return nil, err
	}
	if botID != "" && botTok != "" {
		st.BotUserID, st.BotToken = botID, botTok
		if err := b.AddBotToChannels(h, botID, allIDs); err != nil {
			return nil, err
		}
		if err := b.SetupC3Sidebar(h, userID, teamID, botID); err != nil {
			return nil, err
		}
		b.logf("C3 bot ready — DM @c3-bot or use /c3")
	} else {
		b.logf("C3 bot creation failed — slash command still works")
	}
	haiID, _, err := b.CreateHAI(h, teamID)
	if err != nil {
		return nil, err
	}
	if haiID != "" {
		if err := b.AddBotToChannels(h, haiID, allIDs); err != nil {
			return nil, err
		}
		b.logf("%s ready", HAIUsername)
	} else {
		b.logf("%s creation failed", HAIUsername)
	}
	ids := map[string]string{}
	if botID != "" {
		ids["c3-bot"] = botID
	}
	if haiID != "" {
		ids[HAIUsername] = haiID
	}
	for _, info := range ClaudeUsers {
		r, err := b.mm("GET", "/users/username/"+info.Username, h, nil)
		if err != nil {
			return nil, err
		}
		if r.OK() {
			if v, err := r.JSON(); err == nil {
				ids[info.Username] = s(o(v)["id"])
			}
		}
	}
	if err := b.SetAccountIcons(h, ids); err != nil {
		return nil, err
	}
	b.logf("Bootstrap complete. Starting ntfy bridge loop.")
	return st, nil
}

// BridgeLoop reconnects to the ntfy stream forever with the Python doubling backoff (1 s, capped at 300 s, never reset).
func (b *Bridge) BridgeLoop(webhook string, stop <-chan struct{}) {
	backoff := time.Second
	for {
		if err := b.SubscribeAndBridge(webhook); err != nil {
			b.logf("ntfy stream error: %v -- retrying in %s", err, backoff)
		}
		select {
		case <-stop:
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 300*time.Second {
			backoff = 300 * time.Second
		}
	}
}

// WSListener answers DMs and @c3-bot mentions over the Mattermost websocket, reconnecting every 5 s.
func (b *Bridge) WSListener(botUserID, botToken string, stop <-chan struct{}) {
	u := strings.Replace(strings.Replace(b.Cfg.MMURL, "http://", "ws://", 1), "https://", "wss://", 1) + "/api/v4/websocket"
	for {
		if err := b.wsOnce(u, botUserID, botToken, stop); err != nil {
			b.logf("C3 bot WebSocket failed: %v — retrying in 5s", err)
		}
		select {
		case <-stop:
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (b *Bridge) wsOnce(u, botUserID, botToken string, stop <-chan struct{}) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://chat.diegonmarcos.com"}}})
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	hello := fmt.Sprintf(`{"seq": 1, "action": "authentication_challenge", "data": {"token": %q}}`, botToken)
	if err := conn.Write(ctx, websocket.MessageText, []byte(hello)); err != nil {
		return err
	}
	b.logf("C3 bot WebSocket connected")
	botHeaders := auth(botToken)
	go func() { // ping every 30 s like run_forever(ping_interval=30, ping_timeout=10)
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				if conn.Ping(pctx) != nil {
					pc()
					cancel()
					return
				}
				pc()
			}
		}
	}()
	for {
		_, frame, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if body := b.BotReply(frame, botUserID); body != nil {
			if _, err := b.mm("POST", "/posts", botHeaders, body); err != nil {
				b.logf("C3 bot post failed: %v", err)
			}
		}
	}
}
