package bridge

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mm-bridge/fakemm"
)

func testBridge(mm string) *Bridge {
	cfg := &Config{
		NtfyURL: "http://ntfy.invalid", Topics: "health_mesh,dev_commits,Sec Audit!,new_topic", MMURL: mm,
		AdminEmail: "a@b.c", AdminUser: "admin", AdminPass: "pw", C3APIURL: "http://c3.invalid", C3BindIP: "127.0.0.1", C3Port: 8887,
		ActionURL: "http://bots:8887/c3/action", SlashURL: "http://bots:8887/c3", CatNtfy: "NTFY", CatAgents: "AGENTS", CatProjects: "Projects",
		ClaudePassword: "cpw", LLMBackends: `[{"name":"x"}]`,
	}
	b := New(cfg)
	b.Sleep = func(time.Duration) {}
	return b
}

func TestSanitizeChannel(t *testing.T) {
	for in, want := range map[string]string{
		"health_mesh": "health_mesh", "Sec Audit!": "sec-audit", "  ÄÖ weird  ": "weird", "---": "ntfy-general", "": "ntfy-general",
		"a--b__c": "a-b__c", "dev/commits": "dev-commits", strings.Repeat("a", 80): strings.Repeat("a", 64),
	} {
		if got := SanitizeChannel(in); got != want {
			t.Errorf("SanitizeChannel(%q)=%q want %q", in, got, want)
		}
	}
}

func TestFormatMessage(t *testing.T) {
	if got := FormatMessage(map[string]any{}); got != "(empty notification)" {
		t.Fatal(got)
	}
	got := FormatMessage(map[string]any{"title": "T", "message": "M", "priority": 4.0, "tags": []any{"a", "b"}})
	if got != "**ALERT**\n**T**\nM\n_Tags: a, b_" {
		t.Fatalf("%q", got)
	}
	if FormatMessage(map[string]any{"priority": 3.0, "message": "m"}) != "m" {
		t.Fatal("priority 3 is not an alert")
	}
}

func TestMakeColoredPNG(t *testing.T) {
	data, err := MakeColoredPNG("C3", "#00B8D9", 128)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil || img.Bounds().Dx() != 128 || img.Bounds().Dy() != 128 {
		t.Fatalf("bad png: %v", err)
	}
	r, g, bl, _ := img.At(2, 2).RGBA()
	if r>>8 != 0x00 || g>>8 != 0xB8 || bl>>8 != 0xD9 {
		t.Fatal("background colour")
	}
	white := false
	for y := 0; y < 128 && !white; y++ {
		for x := 0; x < 128; x++ {
			if r, g, b, _ := img.At(x, y).RGBA(); r>>8 == 255 && g>>8 == 255 && b>>8 == 255 {
				white = true
				break
			}
		}
	}
	if !white {
		t.Fatal("the letters must be drawn in white")
	}
}

func TestBootstrapFreshAndEstablished(t *testing.T) {
	for _, sc := range []string{"fresh", "established"} {
		fake := fakemm.New(sc)
		b := testBridge(fake.URL)
		started := false
		st, err := b.Bootstrap(func() { started = true })
		if err != nil {
			t.Fatalf("%s: %v", sc, err)
		}
		if !started || !strings.HasPrefix(st.WebhookURL, fake.URL+"/hooks/") || st.BotUserID == "" || st.BotToken == "" {
			t.Fatalf("%s: state %+v started=%v", sc, st, started)
		}
		var sawIcon, sawDelete, sawCreateAdmin bool
		for _, e := range fake.Transcript {
			sawIcon = sawIcon || strings.HasSuffix(e.Path, "/image")
			sawDelete = sawDelete || e.Method == "DELETE"
			sawCreateAdmin = sawCreateAdmin || (e.Method == "POST" && e.Path == "/api/v4/users" && e.Auth == "")
		}
		if !sawIcon {
			t.Errorf("%s: no icon upload", sc)
		}
		if sc == "established" && !sawDelete {
			t.Errorf("established: the stale ntfy channel must be deleted")
		}
		if sc == "fresh" && !sawCreateAdmin {
			t.Errorf("fresh: the admin user must be created")
		}
		fake.Close()
	}
}

func TestBootstrapNeverRunsWithoutTheSecondLoginCredential(t *testing.T) {
	fake := fakemm.New("fresh")
	defer fake.Close()
	b := testBridge(fake.URL)
	b.Cfg.AdminUser = "someone-else"
	if _, err := b.Bootstrap(nil); err == nil {
		t.Fatal("a login that cannot succeed must fail the bootstrap (the Python bridge raises on it)")
	}
}

func c3Server() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/health/tier1":
			w.Write([]byte(`[{"alias":"a","reachable":true},{"vm":"b","reachable":false}]`))
		case strings.Contains(r.URL.Path, "bad"):
			http.Error(w, "x", 404)
		default:
			w.Write([]byte(`{"ok":true}`))
		}
	}))
}

func TestC3Commands(t *testing.T) {
	c3 := c3Server()
	defer c3.Close()
	b := testBridge("http://mm.invalid")
	b.Cfg.C3APIURL = c3.URL
	if got := b.HandleC3Command("status"); got != "| VM | Status |\n|:---|:---|\n| a | :white_check_mark: UP |\n| b | :x: DOWN |" {
		t.Fatalf("%q", got)
	}
	if got := b.HandleC3Command("wake a"); got != ":rocket: Start requested for **a**" {
		t.Fatalf("%q", got)
	}
	if got := b.HandleC3Command("wake bad"); !strings.HasPrefix(got, ":x: 404 Client Error: Not Found for url: "+c3.URL+"/vms/bad/start") {
		t.Fatalf("%q", got)
	}
	if !strings.HasPrefix(b.HandleC3Command("nonsense"), "**C3 Infrastructure Commands**") {
		t.Fatal("unknown command shows help")
	}
}

func TestShadowIsReadOnly(t *testing.T) {
	c3 := c3Server()
	defer c3.Close()
	b := testBridge("http://mm.invalid")
	b.Cfg.C3APIURL = c3.URL
	b.ReadOnly = true
	if got := b.HandleC3Command("wake a"); !strings.Contains(got, "shadow stage: read-only") {
		t.Fatalf("a mutating call must be refused locally: %q", got)
	}
	if got := b.HandleC3Command("status"); !strings.Contains(got, "UP") {
		t.Fatalf("reads still work: %q", got)
	}
}

func TestSlashHandlerAndBotReply(t *testing.T) {
	c3 := c3Server()
	defer c3.Close()
	b := testBridge("http://mm.invalid")
	b.Cfg.C3APIURL = c3.URL
	srv := httptest.NewServer(b.SlashHandler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/c3", "application/x-www-form-urlencoded", strings.NewReader("text=status"))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out["response_type"] != "in_channel" || out["attachments"] == nil {
		t.Fatalf("%v", out)
	}
	frame := func(chType, msg, uid string) []byte {
		post, _ := json.Marshal(map[string]any{"id": "p1", "channel_id": "c1", "user_id": uid, "message": msg})
		f, _ := json.Marshal(map[string]any{"event": "posted", "data": map[string]any{"channel_type": chType, "post": string(post)}})
		return f
	}
	if b.BotReply(frame("D", "status", "bot"), "bot") != nil {
		t.Fatal("the bot ignores its own posts")
	}
	if b.BotReply(frame("O", "status please", "u"), "bot") != nil {
		t.Fatal("channel posts without a mention are ignored")
	}
	rep := b.BotReply(frame("O", "@c3-bot status", "u"), "bot")
	if rep == nil || rep["root_id"] != "p1" || rep["props"] == nil {
		t.Fatalf("%v", rep)
	}
	dm := b.BotReply(frame("D", "help", "u"), "bot")
	if dm == nil || dm["root_id"] != nil || dm["channel_id"] != "c1" {
		t.Fatalf("%v", dm)
	}
}
