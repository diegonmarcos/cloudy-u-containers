// Package bridge is the Go port of user-comm_chat-mattermost/src/code/ntfy-bridge.py: the Mattermost bootstrap
// (admin, team, channels mirrored from ntfy topics, sidebar categories, webhook, /c3 slash command, bot and AI
// accounts, icons), the ntfy -> Mattermost bridge loop and the C3 command bot. It speaks the Mattermost REST API
// v4 with net/http (the same calls as the Python requests code, in the same order) so a recorded transcript against a
// fake server can be compared one to one with the Python original (parity harness).
package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Config is the environment of the Python bridge.
type Config struct {
	NtfyURL, Topics, MMURL, AdminEmail, AdminUser, AdminPass string
	C3APIURL, C3Token, C3BindIP, ActionURL, SlashURL         string
	C3Port                                                   int
	CatNtfy, CatAgents, CatProjects                          string
	ClaudePassword, LLMBackends                              string
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// ConfigFromEnv reads the bridge environment; the five required variables fail like Python's os.environ[...].
func ConfigFromEnv() (*Config, error) {
	c := &Config{}
	for _, r := range []struct {
		dst *string
		key string
	}{{&c.NtfyURL, "NTFY_URL"}, {&c.Topics, "TOPICS"}, {&c.MMURL, "MM_URL"}, {&c.AdminEmail, "MM_ADMIN_EMAIL"}, {&c.AdminUser, "MM_ADMIN_USERNAME"}, {&c.AdminPass, "MM_ADMIN_PASSWORD"}} {
		v, ok := os.LookupEnv(r.key)
		if !ok {
			return nil, fmt.Errorf("missing required environment variable %s", r.key)
		}
		*r.dst = v
	}
	c.C3APIURL = env("C3_API_URL", "http://c3-infra-mcp-api:8080")
	c.CatNtfy, c.CatAgents, c.CatProjects = "NTFY", "AGENTS", "Projects"
	if raw := os.Getenv("MM_SIDEBAR_CATEGORIES"); raw != "" {
		var cats map[string]string
		if err := json.Unmarshal([]byte(raw), &cats); err != nil {
			return nil, fmt.Errorf("MM_SIDEBAR_CATEGORIES: %w", err)
		}
		if v, ok := cats["ntfy"]; ok {
			c.CatNtfy = v
		}
		if v, ok := cats["agents"]; ok {
			c.CatAgents = v
		}
		if v, ok := cats["default_channels"]; ok {
			c.CatProjects = v
		}
	}
	c.C3BindIP = env("C3_BIND_IP", "0.0.0.0")
	port, err := strconv.Atoi(env("C3_PORT", "8887"))
	if err != nil {
		return nil, fmt.Errorf("C3_PORT: %w", err)
	}
	c.C3Port = port
	c.ActionURL = env("C3_ACTION_URL", fmt.Sprintf("http://mattermost-bots:%d/c3/action", port))
	c.SlashURL = env("C3_SLASH_URL", fmt.Sprintf("http://mattermost-bots:%d/c3", port))
	c.ClaudePassword = os.Getenv("MM_CLAUDE_PASSWORD")
	c.LLMBackends = os.Getenv("MM_AGENTS_LLM_BACKENDS")
	return c, nil
}

// Bridge holds the clients and configuration.
type Bridge struct {
	Cfg   *Config
	HTTP  *http.Client
	Logf  func(string, ...any)
	Sleep func(time.Duration)
	// ReadOnly (shadow stage) makes every C3 API call other than GET fail locally, so the slash command server of the
	// shadow cannot wake, sleep, reset, start, stop or restart anything.
	ReadOnly bool
}

// New returns a bridge with production defaults.
func New(cfg *Config) *Bridge {
	return &Bridge{Cfg: cfg, HTTP: &http.Client{}, Sleep: time.Sleep}
}

func (b *Bridge) logf(f string, a ...any) {
	if b.Logf != nil {
		b.Logf(f, a...)
	}
}

// Resp is one HTTP response.
type Resp struct {
	Status int
	Body   []byte
	Header http.Header
}

// OK is requests' Response.ok.
func (r Resp) OK() bool { return r.Status < 400 }

// Text is the body as a string.
func (r Resp) Text() string { return string(r.Body) }

// JSON decodes the body (generic, objects as map[string]any).
func (r Resp) JSON() (any, error) {
	var v any
	err := json.Unmarshal(r.Body, &v)
	return v, err
}

func (r Resp) must() (any, error) {
	if !r.OK() {
		return nil, fmt.Errorf("HTTP %d: %s", r.Status, trunc(r.Text(), 200))
	}
	return r.JSON()
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Headers is the per-call header set (Python's `headers` dict).
type Headers map[string]string

func auth(token string) Headers { return Headers{"Authorization": "Bearer " + token} }

func (b *Bridge) do(method, url string, h Headers, body any, timeout time.Duration) (Resp, error) {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return Resp{}, err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		return Resp{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
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
	data, err := io.ReadAll(resp.Body)
	return Resp{Status: resp.StatusCode, Body: data, Header: resp.Header}, err
}

// mm is mm_api: a Mattermost v4 call with a JSON body.
func (b *Bridge) mm(method, path string, h Headers, body any) (Resp, error) {
	return b.do(method, b.Cfg.MMURL+"/api/v4"+path, h, body, 30*time.Second)
}

// ---- helpers over generic JSON ---------------------------------------------------------------------------------

type obj = map[string]any

func s(v any) string {
	if x, ok := v.(string); ok {
		return x
	}
	return ""
}

// strDefault is dict.get(key, def) for a string field.
func strDefault(m obj, key, def string) string {
	if v, ok := m[key]; ok {
		return s(v)
	}
	return def
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func o(v any) obj {
	m, _ := v.(obj)
	return m
}

func strList(v any) []string {
	var out []string
	for _, x := range list(v) {
		out = append(out, s(x))
	}
	return out
}

// SanitizeChannel maps an ntfy topic to a Mattermost channel name.
func SanitizeChannel(topic string) string {
	name := regexp.MustCompile(`[^a-z0-9_-]`).ReplaceAllString(strings.ToLower(strings.TrimSpace(topic)), "-")
	name = strings.Trim(regexp.MustCompile(`-+`).ReplaceAllString(name, "-"), "-")
	r := []rune(name)
	if len(r) > 64 {
		name = string(r[:64])
	}
	if name == "" {
		return "ntfy-general"
	}
	return name
}

// ---- bootstrap ----------------------------------------------------------------------------------------------------

// WaitForMattermost polls /system/ping every 2 s for up to 240 s.
func (b *Bridge) WaitForMattermost() error {
	b.logf("Waiting for Mattermost at %s ...", b.Cfg.MMURL)
	for i := 0; i < 120; i++ {
		r, err := b.do("GET", b.Cfg.MMURL+"/api/v4/system/ping", nil, nil, 5*time.Second)
		if err == nil && r.OK() {
			b.logf("Mattermost is ready.")
			return nil
		}
		b.Sleep(2 * time.Second)
	}
	return fmt.Errorf("Mattermost did not become ready in 240s")
}

// BootstrapAdmin logs the admin in, creating the user when needed, and returns the session token.
func (b *Bridge) BootstrapAdmin() (string, error) {
	login := obj{"login_id": b.Cfg.AdminUser, "password": b.Cfg.AdminPass}
	r, err := b.mm("POST", "/users/login", Headers{}, login)
	if err != nil {
		return "", err
	}
	if r.OK() {
		b.logf("Admin login OK (user exists)")
		return r.Header.Get("Token"), nil
	}
	b.logf("Admin login failed (%d), attempting user creation...", r.Status)
	r, err = b.mm("POST", "/users", Headers{}, obj{"email": b.Cfg.AdminEmail, "username": b.Cfg.AdminUser, "password": b.Cfg.AdminPass})
	if err != nil {
		return "", err
	}
	errText := strings.ToLower(r.Text())
	if !(r.OK() || r.Status == 201) {
		if strings.Contains(errText, "already exists") || strings.Contains(errText, "no_open_server") || r.Status == 403 {
			b.logf("User creation blocked (%d): %s", r.Status, trunc(r.Text(), 200))
		} else if _, err := r.must(); err != nil {
			return "", err
		}
	}
	b.logf("Admin user created/exists: %s", b.Cfg.AdminUser)
	r, err = b.mm("POST", "/users/login", Headers{}, login)
	if err != nil {
		return "", err
	}
	if _, err := r.must(); err != nil {
		return "", err
	}
	return r.Header.Get("Token"), nil
}

// EnsureTeam returns the id of the first team, creating "main" when there is none.
func (b *Bridge) EnsureTeam(h Headers) (string, error) {
	r, err := b.mm("GET", "/teams", h, nil)
	if err != nil {
		return "", err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil && len(list(v)) > 0 {
			return s(o(list(v)[0])["id"]), nil
		}
	}
	r, err = b.mm("POST", "/teams", h, obj{"name": "main", "display_name": "Main", "type": "O"})
	if err != nil {
		return "", err
	}
	v, err := r.must()
	if err != nil {
		return "", err
	}
	tid := s(o(v)["id"])
	b.logf("Created team: main (%s)", tid)
	return tid, nil
}

const ntfyMarker = "Mirrored from ntfy topic:"

// SyncChannels creates the missing ntfy channels and deletes the removed ones. It returns the id of town-square
// and the ids of the ntfy channels in topic order.
func (b *Bridge) SyncChannels(h Headers, teamID string) (string, []string, error) {
	topics := strings.Split(b.Cfg.Topics, ",")
	wanted := map[string]bool{}
	for _, t := range topics {
		wanted[SanitizeChannel(t)] = true
	}
	var ntfyIDs []string
	r, err := b.mm("GET", "/teams/"+teamID+"/channels?per_page=200", h, nil)
	if err != nil {
		return "", nil, err
	}
	v, err := r.must()
	if err != nil {
		return "", nil, err
	}
	existing := map[string]string{}
	var order []string
	defaultID := ""
	const oldPrefix = "ntfy: "
	for _, c := range list(v) {
		ch := o(c)
		purpose := s(ch["purpose"])
		dn := s(ch["display_name"])
		if strings.Contains(purpose, ntfyMarker) || strings.HasPrefix(dn, oldPrefix) {
			name := s(ch["name"])
			if _, ok := existing[name]; !ok {
				order = append(order, name)
			}
			existing[name] = s(ch["id"])
			if strings.HasPrefix(dn, oldPrefix) {
				newDN := dn[len(oldPrefix):]
				p := purpose
				if p == "" {
					p = ntfyMarker + " " + newDN
				}
				if _, err := b.mm("PUT", "/channels/"+s(ch["id"]), h, obj{"id": ch["id"], "display_name": newDN, "purpose": p}); err != nil {
					return "", nil, err
				}
				b.logf("Renamed channel display: %s -> %s", dn, newDN)
			}
		}
		if s(ch["name"]) == "town-square" {
			defaultID = s(ch["id"])
		}
	}
	for _, topic := range topics {
		name := SanitizeChannel(topic)
		if id, ok := existing[name]; !ok {
			r, err := b.mm("POST", "/channels", h, obj{"team_id": teamID, "name": name, "display_name": topic, "purpose": ntfyMarker + " " + topic, "type": "O"})
			if err != nil {
				return "", nil, err
			}
			switch {
			case r.OK():
				b.logf("Created channel: %s", name)
				if jv, err := r.JSON(); err == nil {
					ntfyIDs = append(ntfyIDs, s(o(jv)["id"]))
				}
			case r.Status == 409:
				b.logf("Channel exists: %s", name)
			default:
				b.logf("Failed to create %s: %s", name, trunc(r.Text(), 100))
			}
		} else {
			ntfyIDs = append(ntfyIDs, id)
		}
	}
	for _, name := range order {
		if !wanted[name] {
			r, err := b.mm("DELETE", "/channels/"+existing[name], h, nil)
			if err != nil {
				return "", nil, err
			}
			if r.OK() {
				b.logf("Deleted channel: %s", name)
			} else {
				b.logf("Failed to delete %s: %s", name, trunc(r.Text(), 100))
			}
		}
	}
	b.logf("Channel sync complete: %d wanted, %d existed", len(wanted), len(existing))
	return defaultID, ntfyIDs, nil
}

func stringSet(l []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range l {
		m[x] = true
	}
	return m
}

func sameSet(a, b []string) bool { return reflect.DeepEqual(stringSet(a), stringSet(b)) }

func catPath(userID, teamID string) string {
	return "/users/" + userID + "/teams/" + teamID + "/channels/categories"
}

// SyncSidebarCategory groups the ntfy channels under the ntfy sidebar category and removes them from "Channels".
func (b *Bridge) SyncSidebarCategory(h Headers, userID, teamID string, ntfyIDs []string) error {
	r, err := b.mm("GET", catPath(userID, teamID), h, nil)
	if err != nil {
		return err
	}
	if !r.OK() {
		b.logf("Failed to get sidebar categories: %s", trunc(r.Text(), 100))
		return nil
	}
	v, err := r.JSON()
	if err != nil {
		return err
	}
	var ntfyCat, channelsCat obj
	set := stringSet(ntfyIDs)
	for _, c := range list(o(v)["categories"]) {
		cat := o(c)
		if s(cat["display_name"]) == b.Cfg.CatNtfy {
			ntfyCat = cat
		}
		if s(cat["type"]) == "channels" {
			channelsCat = cat
		}
	}
	sorted := append([]string{}, ntfyIDs...)
	sort.Strings(sorted)
	if channelsCat != nil {
		cur := strList(channelsCat["channel_ids"])
		cleaned := []string{}
		for _, id := range cur {
			if !set[id] {
				cleaned = append(cleaned, id)
			}
		}
		if len(cleaned) != len(cur) {
			dn := strDefault(channelsCat, "display_name", "Channels")
			if _, err := b.mm("PUT", catPath(userID, teamID)+"/"+s(channelsCat["id"]), h, obj{"id": channelsCat["id"], "user_id": userID, "team_id": teamID, "display_name": dn, "type": "channels", "channel_ids": cleaned}); err != nil {
				return err
			}
			b.logf("Removed %d ntfy channels from default Channels category", len(cur)-len(cleaned))
		}
	}
	if ntfyCat != nil {
		if !sameSet(strList(ntfyCat["channel_ids"]), sorted) {
			r, err := b.mm("PUT", catPath(userID, teamID)+"/"+s(ntfyCat["id"]), h, obj{"id": ntfyCat["id"], "user_id": userID, "team_id": teamID, "display_name": b.Cfg.CatNtfy, "type": "custom", "sorting": "alpha", "channel_ids": sorted})
			if err != nil {
				return err
			}
			if r.OK() {
				b.logf("Updated ntfy sidebar category with %d channels", len(sorted))
			} else {
				b.logf("Failed to update ntfy category: %s", trunc(r.Text(), 100))
			}
		} else {
			b.logf("ntfy sidebar category already up to date")
		}
		return nil
	}
	r, err = b.mm("POST", catPath(userID, teamID), h, obj{"user_id": userID, "team_id": teamID, "display_name": "ntfy", "type": "custom", "sorting": "alpha", "channel_ids": sorted})
	if err != nil {
		return err
	}
	if r.OK() {
		b.logf("Created ntfy sidebar category with %d channels", len(sorted))
	} else {
		b.logf("Failed to create ntfy category: %s", trunc(r.Text(), 100))
	}
	return nil
}

// EnsureWebhook finds or creates the "ntfy Bridge" incoming webhook and returns its URL.
func (b *Bridge) EnsureWebhook(h Headers, defaultChannelID string) (string, error) {
	r, err := b.mm("GET", "/hooks/incoming?per_page=200", h, nil)
	if err != nil {
		return "", err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil {
			for _, hook := range list(v) {
				if s(o(hook)["display_name"]) == "ntfy Bridge" {
					b.logf("Found existing webhook: %s", s(o(hook)["id"]))
					return b.Cfg.MMURL + "/hooks/" + s(o(hook)["id"]), nil
				}
			}
		}
	}
	r, err = b.mm("POST", "/hooks/incoming", h, obj{"channel_id": defaultChannelID, "display_name": "ntfy Bridge", "description": "Bridges ntfy notifications to Mattermost channels"})
	if err != nil {
		return "", err
	}
	v, err := r.must()
	if err != nil {
		return "", err
	}
	b.logf("Created webhook: %s", s(o(v)["id"]))
	return b.Cfg.MMURL + "/hooks/" + s(o(v)["id"]), nil
}

// RegisterSlashCommand registers or updates /c3.
func (b *Bridge) RegisterSlashCommand(h Headers, teamID string) error {
	data := obj{
		"team_id": teamID, "trigger": "c3", "method": "P", "url": b.Cfg.SlashURL, "display_name": "C3 Infrastructure",
		"description": "Control VMs and containers", "auto_complete": true,
		"auto_complete_hint": "[status|vms|wake|sleep|reset|ps|start|stop|restart|gpu|model|models|help]",
	}
	r, err := b.mm("GET", "/commands?team_id="+teamID, h, nil)
	if err != nil {
		return err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil {
			for _, c := range list(v) {
				cmd := o(c)
				if s(cmd["trigger"]) == "c3" {
					data["id"] = cmd["id"]
					r2, err := b.mm("PUT", "/commands/"+s(cmd["id"]), h, data)
					if err != nil {
						return err
					}
					if r2.OK() {
						b.logf("Updated slash command /c3: %s", s(cmd["id"]))
					} else {
						b.logf("Failed to update /c3: %s", trunc(r2.Text(), 200))
					}
					return nil
				}
			}
		}
	}
	r, err = b.mm("POST", "/commands", h, data)
	if err != nil {
		return err
	}
	if r.OK() || r.Status == 201 {
		b.logf("Registered slash command /c3")
	} else {
		b.logf("Failed to register /c3: %s", trunc(r.Text(), 200))
	}
	return nil
}

// ensureBot is the shared find-or-create of create_bot / create_hai_ai.
func (b *Bridge) ensureBot(h Headers, teamID, username, display, desc, tokenDesc string) (string, string, error) {
	botID := ""
	r, err := b.mm("GET", "/bots?include_deleted=false&per_page=200", h, nil)
	if err != nil {
		return "", "", err
	}
	if r.OK() {
		if v, err := r.JSON(); err == nil {
			for _, bot := range list(v) {
				if s(o(bot)["username"]) == username {
					botID = s(o(bot)["user_id"])
					b.logf("Found existing %s: %s", username, botID)
					break
				}
			}
		}
	}
	if botID == "" {
		r, err := b.mm("POST", "/bots", h, obj{"username": username, "display_name": display, "description": desc})
		if err != nil {
			return "", "", err
		}
		if r.OK() || r.Status == 201 {
			v, err := r.JSON()
			if err != nil {
				return "", "", err
			}
			botID = s(o(v)["user_id"])
			b.logf("Created %s: %s", username, botID)
		} else {
			b.logf("Failed to create %s: %s", username, trunc(r.Text(), 200))
			return "", "", nil
		}
	}
	if _, err := b.mm("POST", "/teams/"+teamID+"/members", h, obj{"team_id": teamID, "user_id": botID}); err != nil {
		return "", "", err
	}
	if username == "c3-bot" {
		b.logf("Added c3-bot to team %s", teamID)
	}
	r, err = b.mm("POST", "/users/"+botID+"/tokens", h, obj{"description": tokenDesc})
	if err != nil {
		return "", "", err
	}
	if !r.OK() {
		b.logf("Failed to create bot token: %s", trunc(r.Text(), 200))
		return botID, "", nil
	}
	v, err := r.JSON()
	if err != nil {
		return "", "", err
	}
	return botID, s(o(v)["token"]), nil
}

// CreateBot creates or finds c3-bot, adds it to the team and mints a fresh access token.
func (b *Bridge) CreateBot(h Headers, teamID string) (string, string, error) {
	return b.ensureBot(h, teamID, "c3-bot", "C3", "Infrastructure control bot. DM me: status, vms, gpu, help", "c3-bot runtime")
}

// HAIUsername is the AI bot account name.
const HAIUsername = "hai-1.5bq4-ai"

// CreateHAI creates or finds the HAI AI bot account.
func (b *Bridge) CreateHAI(h Headers, teamID string) (string, string, error) {
	return b.ensureBot(h, teamID, HAIUsername, "HAI Agent (Qwen 1.5B)", "Lightweight infra agent with strict guardrails. DM me or @mention. Always on (CPU, oci-apps).", HAIUsername+" runtime")
}

// AddBotToChannels adds a bot to each channel; failures other than "already" are logged.
func (b *Bridge) AddBotToChannels(h Headers, botID string, channelIDs []string) error {
	for _, id := range channelIDs {
		r, err := b.mm("POST", "/channels/"+id+"/members", h, obj{"user_id": botID})
		if err != nil {
			return err
		}
		if !(r.OK() || r.Status == 201) && !strings.Contains(strings.ToLower(r.Text()), "already") {
			b.logf("Failed to add bot to channel %s: %s", id, trunc(r.Text(), 100))
		}
	}
	short := botID
	if len(short) > 8 {
		short = short[:8]
	}
	b.logf("Bot %s added to %d channels", short, len(channelIDs))
	return nil
}

// ClaudeUsers are the regular accounts created for the Claude models.
var ClaudeUsers = []struct{ Username, Display, Email string }{
	{"claude-opus-ai", "Claude Opus", "claude-opus@diegonmarcos.com"},
	{"claude-sonnet-ai", "Claude Sonnet", "claude-sonnet@diegonmarcos.com"},
	{"claude-haiku-ai", "Claude Haiku", "claude-haiku@diegonmarcos.com"},
}

// CreateClaudeUsers creates the Claude accounts and adds them to the team, all channels and the ntfy category.
func (b *Bridge) CreateClaudeUsers(h Headers, teamID string, allChannelIDs, ntfyIDs []string) error {
	if b.Cfg.ClaudePassword == "" {
		b.logf("MM_CLAUDE_PASSWORD not set — skipping Claude user creation")
		return nil
	}
	for _, info := range ClaudeUsers {
		var uid string
		r, err := b.mm("GET", "/users/username/"+info.Username, h, nil)
		if err != nil {
			return err
		}
		if r.OK() {
			v, err := r.JSON()
			if err != nil {
				return err
			}
			uid = s(o(v)["id"])
			b.logf("Claude user exists: %s (%s)", info.Username, uid)
		} else {
			parts := strings.Fields(info.Display)
			last := ""
			if len(parts) > 1 {
				last = parts[1]
			}
			r, err := b.mm("POST", "/users", h, obj{"email": info.Email, "username": info.Username, "password": b.Cfg.ClaudePassword, "first_name": parts[0], "last_name": last})
			if err != nil {
				return err
			}
			if r.OK() || r.Status == 201 {
				v, err := r.JSON()
				if err != nil {
					return err
				}
				uid = s(o(v)["id"])
				b.logf("Created Claude user: %s (%s)", info.Username, uid)
			} else {
				b.logf("Failed to create %s: %s", info.Username, trunc(r.Text(), 100))
				continue
			}
		}
		if _, err := b.mm("POST", "/teams/"+teamID+"/members", h, obj{"team_id": teamID, "user_id": uid}); err != nil {
			return err
		}
		for _, ch := range allChannelIDs {
			if _, err := b.mm("POST", "/channels/"+ch+"/members", h, obj{"user_id": uid}); err != nil {
				return err
			}
		}
		b.logf("Added %s to team + %d channels", info.Username, len(allChannelIDs))
		if len(ntfyIDs) > 0 {
			if err := b.SyncSidebarCategory(h, uid, teamID, ntfyIDs); err != nil {
				return err
			}
		}
	}
	return nil
}

// SetupC3Sidebar creates the admin <-> c3-bot DM, files it under the agents category and posts the welcome help.
func (b *Bridge) SetupC3Sidebar(h Headers, userID, teamID, botID string) error {
	r, err := b.mm("POST", "/channels/direct", h, []string{userID, botID})
	if err != nil {
		return err
	}
	if !r.OK() {
		b.logf("Failed to create DM with c3-bot: %s", trunc(r.Text(), 100))
		return nil
	}
	v, err := r.JSON()
	if err != nil {
		return err
	}
	dm := s(o(v)["id"])
	b.logf("DM channel with c3-bot: %s", dm)
	r, err = b.mm("GET", catPath(userID, teamID), h, nil)
	if err != nil {
		return err
	}
	if !r.OK() {
		return nil
	}
	cv, err := r.JSON()
	if err != nil {
		return err
	}
	var c3Cat, dmCat obj
	for _, c := range list(o(cv)["categories"]) {
		cat := o(c)
		if s(cat["display_name"]) == b.Cfg.CatAgents {
			c3Cat = cat
		}
		if s(cat["type"]) == "direct_messages" {
			dmCat = cat
		}
	}
	if dmCat != nil && contains(strList(dmCat["channel_ids"]), dm) {
		cleaned := []string{}
		for _, id := range strList(dmCat["channel_ids"]) {
			if id != dm {
				cleaned = append(cleaned, id)
			}
		}
		dn := strDefault(dmCat, "display_name", "Direct Messages")
		if _, err := b.mm("PUT", catPath(userID, teamID)+"/"+s(dmCat["id"]), h, obj{"id": dmCat["id"], "user_id": userID, "team_id": teamID, "display_name": dn, "type": "direct_messages", "channel_ids": cleaned}); err != nil {
			return err
		}
		b.logf("Removed c3-bot DM from Direct Messages category")
	}
	if c3Cat != nil {
		ids := strList(c3Cat["channel_ids"])
		if !contains(ids, dm) {
			ids = append(ids, dm)
			if _, err := b.mm("PUT", catPath(userID, teamID)+"/"+s(c3Cat["id"]), h, obj{"id": c3Cat["id"], "user_id": userID, "team_id": teamID, "display_name": b.Cfg.CatAgents, "type": "custom", "channel_ids": ids}); err != nil {
				return err
			}
			b.logf("Added c3-bot DM to C3 sidebar category")
		} else {
			b.logf("c3-bot DM already in C3 sidebar category")
		}
	} else {
		r, err := b.mm("POST", catPath(userID, teamID), h, obj{"user_id": userID, "team_id": teamID, "display_name": b.Cfg.CatAgents, "type": "custom", "channel_ids": []string{dm}})
		if err != nil {
			return err
		}
		if r.OK() {
			b.logf("Created C3 sidebar category with bot DM")
		} else {
			b.logf("Failed to create C3 category: %s", trunc(r.Text(), 100))
		}
	}
	r, err = b.mm("GET", "/channels/"+dm+"/posts?per_page=1", h, nil)
	if err != nil {
		return err
	}
	if r.OK() {
		pv, err := r.JSON()
		if err == nil && len(list(o(pv)["order"])) == 0 {
			if _, err := b.mm("POST", "/posts", Headers{"Authorization": h["Authorization"]}, obj{"channel_id": dm, "message": b.HandleC3Command("help"), "props": obj{"from_webhook": "true", "override_username": "c3-bot"}}); err != nil {
				return err
			}
		}
	}
	return nil
}

func contains(l []string, x string) bool {
	for _, y := range l {
		if y == x {
			return true
		}
	}
	return false
}

// EnsureAgentsLLMConfig wires the LLM backends into the Agents plugin config (idempotent).
func (b *Bridge) EnsureAgentsLLMConfig(h Headers) error {
	if b.Cfg.LLMBackends == "" {
		return nil
	}
	var backends any
	if err := json.Unmarshal([]byte(b.Cfg.LLMBackends), &backends); err != nil {
		return err
	}
	r, err := b.mm("GET", "/config", h, nil)
	if err != nil {
		return err
	}
	if !r.OK() {
		b.logf("ensure_agents_llm_config: cannot GET config: %s", trunc(r.Text(), 100))
		return nil
	}
	cv, err := r.JSON()
	if err != nil {
		return err
	}
	cfg := o(cv)
	var cur any = []any{}
	if ps := o(cfg["PluginSettings"]); ps != nil {
		if pl := o(ps["Plugins"]); pl != nil {
			if ai := o(pl["mattermost-ai"]); ai != nil {
				if v, ok := ai["llmBackends"]; ok {
					cur = v
				}
			}
		}
	}
	if reflect.DeepEqual(cur, backends) {
		b.logf("Agents plugin LLM backends already up-to-date")
		return nil
	}
	ps, _ := cfg["PluginSettings"].(obj)
	if ps == nil {
		ps = obj{}
		cfg["PluginSettings"] = ps
	}
	pl, _ := ps["Plugins"].(obj)
	if pl == nil {
		pl = obj{}
		ps["Plugins"] = pl
	}
	ai, _ := pl["mattermost-ai"].(obj)
	if ai == nil {
		ai = obj{}
		pl["mattermost-ai"] = ai
	}
	ai["llmBackends"] = backends
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	r, err = b.do("PUT", b.Cfg.MMURL+"/api/v4/config", h, json.RawMessage(raw), 120*time.Second)
	if err != nil {
		return err
	}
	if r.OK() {
		n := len(list(backends))
		b.logf("Agents plugin LLM backends configured (%d backend(s))", n)
	} else {
		b.logf("Agents plugin LLM backends config failed: %s", trunc(r.Text(), 200))
	}
	return nil
}

// ReconcileCategories renames existing sidebar categories to the configured names, in place.
func (b *Bridge) ReconcileCategories(h Headers, userID, teamID string) error {
	r, err := b.mm("GET", catPath(userID, teamID), h, nil)
	if err != nil {
		return err
	}
	if !r.OK() {
		b.logf("reconcile_categories: cannot list categories: %s", trunc(r.Text(), 100))
		return nil
	}
	v, err := r.JSON()
	if err != nil {
		return err
	}
	renames := map[string]string{"ntfy": b.Cfg.CatNtfy, "C3": b.Cfg.CatAgents}
	for _, c := range list(o(v)["categories"]) {
		cat := o(c)
		cur, _ := cat["display_name"].(string)
		target, ok := renames[cur]
		if !ok && s(cat["type"]) == "channels" {
			target, ok = b.Cfg.CatProjects, true
		}
		if !ok || target == "" || target == cur {
			continue
		}
		body := obj{}
		for k, v := range cat {
			body[k] = v
		}
		body["display_name"] = target
		rr, err := b.mm("PUT", catPath(userID, teamID)+"/"+s(cat["id"]), h, body)
		if err != nil {
			return err
		}
		if rr.OK() {
			b.logf("Reconciled sidebar category %q -> %q", cur, target)
		} else {
			b.logf("Failed to rename category %q -> %q: %s", cur, target, trunc(rr.Text(), 100))
		}
	}
	return nil
}
