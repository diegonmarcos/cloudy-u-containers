// Package fakemm is a small stateful fake of the Mattermost REST API v4 (only the calls the ntfy bridge makes). It
// records every request, so the Go port and the Python original can be run against identical servers and their
// transcripts compared. Responses depend only on the request sequence, never on the client implementation.
package fakemm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
)

// Entry is one recorded request.
type Entry struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Auth   string `json:"auth"`
	Type   string `json:"type"`
	Body   any    `json:"body"`
}

type obj = map[string]any

// Server is the fake. Create with New, read Transcript, discard with Close.
type Server struct {
	*httptest.Server
	mu         sync.Mutex
	n          int
	scenario   string
	Transcript []Entry
	users      []obj
	teams      []obj
	channels   []obj
	hooks      []obj
	commands   []obj
	bots       []obj
	cats       map[string][]obj // "user:team" -> categories
	config     obj
	posts      map[string][]any
}

// New starts a fake in the given scenario: "fresh" (empty server, admin must be created) or "established"
// (admin, team, channels incl. old-prefix and stale ntfy channels, categories, hook, command, bots, users).
func New(scenario string) *Server {
	s := &Server{scenario: scenario, cats: map[string][]obj{}, posts: map[string][]any{}}
	s.seed()
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

func (s *Server) id(prefix string) string {
	s.n++
	return fmt.Sprintf("%s%04d", prefix, s.n)
}

func (s *Server) seed() {
	// Lists must serialise as [] (never null), like the real server.
	s.users, s.teams, s.channels, s.hooks, s.commands, s.bots = []obj{}, []obj{}, []obj{}, []obj{}, []obj{}, []obj{}
	if s.scenario != "established" {
		return
	}
	s.users = []obj{{"id": "admin-id", "username": "admin"}, {"id": "u-opus", "username": "claude-opus-ai"}}
	s.teams = []obj{{"id": "team-1", "name": "main"}}
	s.channels = []obj{
		{"id": "ch-town", "name": "town-square", "display_name": "Town Square", "purpose": ""},
		{"id": "ch-old", "name": "health-mesh", "display_name": "ntfy: health_mesh", "purpose": ""},
		{"id": "ch-ok", "name": "dev-commits", "display_name": "dev_commits", "purpose": "Mirrored from ntfy topic: dev_commits"},
		{"id": "ch-stale", "name": "gone-topic", "display_name": "gone_topic", "purpose": "Mirrored from ntfy topic: gone_topic"},
		{"id": "ch-user", "name": "random", "display_name": "Random", "purpose": "x"},
	}
	s.hooks = []obj{{"id": "hook-1", "display_name": "ntfy Bridge"}}
	s.commands = []obj{{"id": "cmd-1", "trigger": "c3"}}
	s.bots = []obj{{"user_id": "bot-c3", "username": "c3-bot"}}
	s.cats["admin-id:team-1"] = []obj{
		{"id": "cat-ch", "display_name": "Channels", "type": "channels", "channel_ids": []any{"ch-town", "ch-ok", "ch-user"}},
		{"id": "cat-ntfy", "display_name": "ntfy", "type": "custom", "channel_ids": []any{"ch-ok"}},
		{"id": "cat-c3", "display_name": "C3", "type": "custom", "channel_ids": []any{"dm-old"}},
		{"id": "cat-dm", "display_name": "Direct Messages", "type": "direct_messages", "channel_ids": []any{"dm-admin-id-bot-c3", "dm-x"}},
	}
	s.config = obj{"PluginSettings": obj{"Plugins": obj{"mattermost-ai": obj{"llmBackends": []any{obj{"name": "old"}}}}}, "Other": 1}
	s.posts["dm-admin-id-bot-c3"] = nil
}

// Reset clears the transcript and re-seeds, keeping the same URL.
func (s *Server) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n, s.Transcript = 0, nil
	s.users, s.teams, s.channels, s.hooks, s.commands, s.bots = nil, nil, nil, nil, nil, nil
	s.cats, s.posts, s.config = map[string][]obj{}, map[string][]any{}, nil
	s.seed()
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	e := Entry{Method: r.Method, Path: r.URL.RequestURI(), Auth: r.Header.Get("Authorization"), Type: mt}
	switch {
	case strings.HasPrefix(mt, "multipart/"):
		e.Body = multipartSummary(raw, params["boundary"])
	case len(raw) > 0:
		var v any
		if json.Unmarshal(raw, &v) == nil {
			e.Body = v
		} else {
			e.Body = string(raw)
		}
	}
	s.Transcript = append(s.Transcript, e)
	status, hdr, out := s.route(r, e.Body)
	for k, v := range hdr {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	b, _ := json.Marshal(out)
	_, _ = w.Write(b)
}

func multipartSummary(raw []byte, boundary string) any {
	mr := multipart.NewReader(bytes.NewReader(raw), boundary)
	var parts []any
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		data, _ := io.ReadAll(p)
		sum := obj{"name": p.FormName(), "filename": p.FileName(), "content_type": p.Header.Get("Content-Type")}
		if img, err := png.Decode(bytes.NewReader(data)); err == nil {
			b := img.Bounds()
			r, g, bl, _ := img.At(2, 2).RGBA()
			sum["png"] = obj{"w": b.Dx(), "h": b.Dy(), "corner": []uint32{r >> 8, g >> 8, bl >> 8}}
		} else {
			sum["png"] = "invalid"
		}
		parts = append(parts, sum)
	}
	return parts
}

func find(l []obj, key, val string) (int, obj) {
	for i, x := range l {
		if x[key] == val {
			return i, x
		}
	}
	return -1, nil
}

func asObj(v any) obj {
	m, _ := v.(map[string]any)
	if m == nil {
		m = obj{}
	}
	return m
}

func (s *Server) route(r *http.Request, body any) (int, map[string]string, any) {
	p := strings.TrimPrefix(r.URL.Path, "/api/v4")
	seg := strings.Split(strings.Trim(p, "/"), "/")
	b := asObj(body)
	nf := obj{"message": "not found"}
	switch {
	case p == "/system/ping":
		return 200, nil, obj{"status": "OK"}
	case p == "/users/login" && r.Method == "POST":
		for _, u := range s.users {
			if u["username"] == b["login_id"] && b["login_id"] == "admin" {
				return 200, map[string]string{"Token": "tok-admin"}, u
			}
		}
		return 401, nil, obj{"message": "invalid credentials"}
	case p == "/users" && r.Method == "POST":
		u := obj{"id": s.id("user-"), "username": b["username"], "email": b["email"]}
		if b["username"] == "admin" {
			u["id"] = "admin-id"
		}
		s.users = append(s.users, u)
		return 201, nil, u
	case p == "/users/me":
		_, u := find(s.users, "username", "admin")
		if u == nil {
			return 401, nil, obj{"message": "no session"}
		}
		return 200, nil, u
	case len(seg) == 3 && seg[0] == "users" && seg[1] == "username":
		_, u := find(s.users, "username", seg[2])
		if u == nil {
			return 404, nil, nf
		}
		return 200, nil, u
	case p == "/teams" && r.Method == "GET":
		return 200, nil, s.teams
	case p == "/teams" && r.Method == "POST":
		t := obj{"id": s.id("team-"), "name": b["name"]}
		s.teams = append(s.teams, t)
		return 201, nil, t
	case len(seg) == 3 && seg[0] == "teams" && seg[2] == "members":
		return 201, nil, obj{"team_id": seg[1]}
	case len(seg) == 3 && seg[0] == "teams" && seg[2] == "channels" && r.Method == "GET":
		return 200, nil, s.channels
	case p == "/channels" && r.Method == "POST":
		if i, _ := find(s.channels, "name", fmt.Sprint(b["name"])); i >= 0 {
			return 409, nil, obj{"id": "api.channel.create_channel.direct_channel.app_error", "message": "exists"}
		}
		c := obj{"id": s.id("ch-"), "name": b["name"], "display_name": b["display_name"], "purpose": b["purpose"]}
		s.channels = append(s.channels, c)
		return 201, nil, c
	case p == "/channels/direct":
		ids, _ := body.([]any)
		return 201, nil, obj{"id": "dm-" + fmt.Sprint(ids[0]) + "-" + fmt.Sprint(ids[1])}
	case len(seg) == 2 && seg[0] == "channels" && r.Method == "PUT":
		if i, _ := find(s.channels, "id", seg[1]); i >= 0 {
			for k, v := range b {
				s.channels[i][k] = v
			}
		}
		return 200, nil, obj{"id": seg[1]}
	case len(seg) == 2 && seg[0] == "channels" && r.Method == "DELETE":
		if i, _ := find(s.channels, "id", seg[1]); i >= 0 {
			s.channels = append(s.channels[:i], s.channels[i+1:]...)
		}
		return 200, nil, obj{"status": "OK"}
	case len(seg) == 3 && seg[0] == "channels" && seg[2] == "members":
		return 201, nil, obj{"channel_id": seg[1]}
	case len(seg) == 3 && seg[0] == "channels" && seg[2] == "posts":
		order := []any{}
		for range s.posts[seg[1]] {
			order = append(order, "p")
		}
		return 200, nil, obj{"order": order}
	case p == "/posts":
		return 201, nil, obj{"id": s.id("post-")}
	case p == "/hooks/incoming" && r.Method == "GET":
		return 200, nil, s.hooks
	case p == "/hooks/incoming":
		h := obj{"id": s.id("hook-"), "display_name": b["display_name"]}
		s.hooks = append(s.hooks, h)
		return 201, nil, h
	case p == "/commands" && r.Method == "GET":
		return 200, nil, s.commands
	case p == "/commands":
		c := obj{"id": s.id("cmd-"), "trigger": b["trigger"]}
		s.commands = append(s.commands, c)
		return 201, nil, c
	case len(seg) == 2 && seg[0] == "commands":
		return 200, nil, obj{"id": seg[1]}
	case p == "/bots" && r.Method == "GET":
		return 200, nil, s.bots
	case p == "/bots":
		uid := s.id("bot-")
		s.bots = append(s.bots, obj{"user_id": uid, "username": b["username"]})
		return 201, nil, obj{"user_id": uid, "username": b["username"]}
	case len(seg) == 3 && seg[0] == "users" && seg[2] == "tokens":
		return 200, nil, obj{"token": "tok-" + seg[1]}
	case len(seg) == 3 && seg[0] == "users" && seg[2] == "channels":
		return 200, nil, []obj{{"id": "grp-1", "type": "G"}, {"id": "ch-ok", "type": "O"}, {"id": "dm-1", "type": "D"}}
	case len(seg) == 3 && seg[0] == "users" && seg[2] == "image":
		return 200, nil, obj{"status": "OK"}
	case len(seg) >= 6 && seg[0] == "users" && seg[2] == "teams" && seg[4] == "channels" && seg[5] == "categories":
		key := seg[1] + ":" + seg[3]
		switch {
		case r.Method == "GET":
			cats := s.cats[key]
			if cats == nil {
				cats = []obj{{"id": "cat-ch-" + seg[1], "display_name": "Channels", "type": "channels", "channel_ids": []any{}}}
			}
			return 200, nil, obj{"categories": cats}
		case r.Method == "POST":
			c := obj{"id": s.id("cat-")}
			for k, v := range b {
				c[k] = v
			}
			s.cats[key] = append(s.cats[key], c)
			return 200, nil, c
		default:
			return 200, nil, b
		}
	case p == "/config" && r.Method == "GET":
		if s.config == nil {
			return 200, nil, obj{"PluginSettings": obj{}}
		}
		return 200, nil, s.config
	case p == "/config":
		return 200, nil, b
	}
	return 404, nil, nf
}
