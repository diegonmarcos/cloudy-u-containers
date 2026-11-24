package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"c3bot-relay/relay"
)

// serveWS is WebSocket /ws: the server pushes events as JSON text; the client may send {type:"send",chat_id?,text} or
// {type:"since",after}. Bearer via header or ?token=; ?after= replays the ring first.
func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) error {
	if !s.bearerOK(r) {
		w.Header().Set("Connection", "close")
		w.WriteHeader(401)
		return nil
	}
	if int(s.clients.Load()) >= s.Cfg.MaxClients {
		w.Header().Set("Connection", "close")
		w.WriteHeader(429)
		return nil
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // origin is moot: bearer-gated
	if err != nil {
		return nil // Accept already answered
	}
	s.clients.Add(1)
	defer s.clients.Add(-1)
	c.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer c.CloseNow()

	out := make(chan []byte, s.Relay.BufferSize()*2+64)
	push := func(v any) {
		b, _ := json.Marshal(v)
		select {
		case out <- b:
		default:
			cancel() // slow client: drop it rather than block publish
		}
	}
	go func() { // single writer; pings keep idle links alive
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case b := <-out:
				wctx, wc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Write(wctx, websocket.MessageText, b)
				wc()
				if err != nil {
					cancel()
					return
				}
			case <-ping.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pc()
				if err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	push(map[string]any{"type": "hello", "cursor": s.Relay.Cursor(), "telegram": s.BotA.State()})
	unsub := s.Relay.SubscribeFrom(qnum(r.URL.Query().Get("after"), 0), s.Relay.BufferSize(), func(e relay.Event) { push(e) })
	defer unsub()

	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == -1 && ctx.Err() == nil {
				c.Close(websocket.StatusProtocolError, "protocol error")
			}
			return nil
		}
		if typ != websocket.MessageText {
			continue
		}
		var v any
		if json.Unmarshal(data, &v) != nil {
			push(map[string]any{"type": "error", "error": "invalid JSON"})
			continue
		}
		m, _ := v.(map[string]any)
		switch m["type"] {
		case "send":
			go func() {
				id := m["id"]
				res, err := s.DoSend(ctx, m)
				if err != nil {
					push(map[string]any{"type": "error", "id": id, "error": err.Error()})
					return
				}
				push(merge(map[string]any{"type": "send.ok", "id": id}, res))
			}()
		case "since":
			a := jsNum(m["after"])
			if math.IsNaN(a) {
				a = 0
			}
			for _, e := range s.Relay.Since(a, s.Relay.BufferSize()) {
				push(e)
			}
		default:
			push(map[string]any{"type": "error", "error": "unknown type"})
		}
	}
}

func jsNum(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return qnum(t, 0)
	case nil:
		return 0
	}
	return math.NaN()
}
