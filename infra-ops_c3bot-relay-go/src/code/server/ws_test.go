package server

// Port of the WebSocket test of transports.test.js plus the three hand-rolled RFC 6455 tests of relay.test.js
// (accept key, unmasked client frame refused, 16-bit length above 125 bytes), now on the wire against coder/websocket.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func wsRead(t *testing.T, c *websocket.Conn, until func(map[string]any) bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal("ws read:", err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if until(m) {
			return m
		}
	}
}

func TestWebSocketHelloLivePushSendFrameBadBearerRefused(t *testing.T) {
	f := newFixture(t)
	ctx := ctxT(10 * time.Second)
	if _, resp, err := websocket.Dial(ctx, "ws://"+f.host+"/ws?token=wrong", nil); err == nil {
		t.Fatal("bad bearer accepted")
	} else if resp == nil || resp.StatusCode != 401 {
		t.Fatal(err, resp)
	}
	c, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://%s/c3bot-relay/ws?token=%s&after=%d", f.host, tok, f.rl.Cursor()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	wsRead(t, c, func(m map[string]any) bool { return m["type"] == "hello" })
	f.inject(4, 42, "wslive")
	ev := wsRead(t, c, func(m map[string]any) bool { return m["text"] == "wslive" })
	eqs(t, ev["type"], "telegram.message", "type")
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"send","id":"a1","text":"via ws"}`)); err != nil {
		t.Fatal(err)
	}
	eqs(t, wsRead(t, c, func(m map[string]any) bool { return m["type"] == "send.ok" })["id"], "a1", "send.ok id")
	_ = c.Write(ctx, websocket.MessageText, []byte(`nope`))
	eqs(t, wsRead(t, c, func(m map[string]any) bool { return m["type"] == "error" })["error"], "invalid JSON", "invalid JSON")
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"since","after":0}`))
	wsRead(t, c, func(m map[string]any) bool { return m["text"] == "wslive" })
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"x"}`))
	eqs(t, wsRead(t, c, func(m map[string]any) bool { return m["type"] == "error" })["error"], "unknown type", "unknown")
	c.Close(websocket.StatusNormalClosure, "")
	for i := 0; i < 100 && f.srv.Clients() != 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	eqs(t, f.srv.Clients(), 0, "clients released on close")
}

func TestWebSocketLargeFrameUses16BitLength(t *testing.T) {
	f := newFixture(t)
	ctx := ctxT(10 * time.Second)
	c, _, err := websocket.Dial(ctx, "ws://"+f.host+"/ws?token="+tok, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	f.inject(8, 42, strings.Repeat("x", 300))
	ev := wsRead(t, c, func(m map[string]any) bool { return m["type"] == "telegram.message" })
	if len(ev["text"].(string)) != 300 {
		t.Fatal(len(ev["text"].(string)))
	}
}

// raw handshake on a TCP socket, to check bytes the library hides.
func rawWS(t *testing.T, f *fixture, key string) (*bufio.Reader, net.Conn, string) {
	conn, err := net.Dial("tcp", f.host)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	fmt.Fprintf(conn, "GET /ws?token=%s HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", tok, key)
	br := bufio.NewReader(conn)
	var head strings.Builder
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		head.WriteString(l)
		if l == "\r\n" {
			break
		}
	}
	return br, conn, head.String()
}

func TestWebSocketAcceptKeyMatchesRFC6455Example(t *testing.T) {
	f := newFixture(t)
	_, _, head := rawWS(t, f, "dGhlIHNhbXBsZSBub25jZQ==")
	if !strings.HasPrefix(head, "HTTP/1.1 101") || !strings.Contains(head, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") {
		t.Fatal(head)
	}
}

func TestWebSocketUnmaskedClientFrameClosesConnection(t *testing.T) {
	f := newFixture(t)
	br, conn, _ := rawWS(t, f, "dGhlIHNhbXBsZSBub25jZQ==")
	_, _ = conn.Write([]byte{0x81, 0x01, 0x61}) // unmasked text frame
	_ = conn.SetReadDeadline(time.Now().Add(4 * time.Second))
	var sawClose bool
	for { // hello text frame(s), then a close frame (0x88) or EOF
		b, err := br.ReadByte()
		if err != nil {
			sawClose = true
			break
		}
		if b == 0x88 {
			sawClose = true
			break
		}
	}
	if !sawClose {
		t.Fatal("connection stayed open")
	}
}

func TestWebSocketNonWsPathUpgradeIsDropped(t *testing.T) {
	f := newFixture(t)
	conn, err := net.Dial("tcp", f.host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n")
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, _ := conn.Read(make([]byte, 16)); n != 0 {
		t.Fatal("expected the socket to be destroyed with no response")
	}
}
