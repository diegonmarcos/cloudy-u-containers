//go:build parity

// Parity harness (#1874): the same request sequence goes to the TypeScript router
// (node mcp/index.ts --http, the reference) and to the Go router, both fronting one fake child MCP
// server, and the normalised responses must be identical. PARITY_REQUIRE=1 turns a missing node
// into a failure instead of a skip. PARITY_MUTATE=1 makes the Go side lie about one tool
// description so the harness proves it can go red.
package parity

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"cloudy-all-mcp/router"
	"cloudy-all-mcp/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// child starts a fake fleet member: paged tools/list (page size 1), structured results, an error result.
func child(t *testing.T) string {
	s := mcp.NewServer(&mcp.Implementation{Name: "fake-child", Version: "0.0.1"}, &mcp.ServerOptions{PageSize: 1})
	schema := map[string]any{"type": "object", "properties": map[string]any{"msg": map[string]any{"type": "string"}}}
	s.AddTool(&mcp.Tool{Name: "echo", Description: "echo the args back", InputSchema: schema},
		func(ctx context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var a map[string]any
			_ = json.Unmarshal(r.Params.Arguments, &a)
			return &mcp.CallToolResult{
				Content:           []mcp.Content{&mcp.TextContent{Text: "echo:" + fmt.Sprint(a["msg"])}},
				StructuredContent: map[string]any{"args": a},
			}, nil
		})
	s.AddTool(&mcp.Tool{Name: "echo_twice", Description: "second tool, no params", InputSchema: map[string]any{"type": "object"}},
		func(ctx context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "twice"}, &mcp.TextContent{Text: "twice"}}}, nil
		})
	s.AddTool(&mcp.Tool{Name: "boom", Description: "always an error result", InputSchema: map[string]any{"type": "object"}},
		func(ctx context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "boom happened"}}}, nil
		})
	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless: true, DisableLocalhostProtection: true})
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts.URL
}

func catalog(childURL string) string {
	b, _ := json.Marshal([]router.ServerEntry{
		{Name: "child-mcp", Aliases: []string{"kid"}, Description: "fake child", URLs: []string{childURL}},
		{Name: "down-mcp", Description: "nothing listens here", URLs: []string{"http://127.0.0.1:1/mcp"}},
		{Name: "needs-bearer-mcp", Description: "public only, no bearer configured", URLs: []string{"https://example.invalid/x/mcp"}},
	})
	return string(b)
}

func startNode(t *testing.T, cat string) string {
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("node not found")
		}
		t.Skip("node not found")
	}
	dir, _ := filepath.Abs("../../../../infra-api_cloudy-all-mcp/src/code")
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "@modelcontextprotocol")); err != nil {
		cmd := exec.Command("npm", "install", "--omit=dev", "--no-audit", "--no-fund")
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("npm install: %v\n%s", err, out)
		}
	}
	port := freePort(t)
	cmd := exec.Command(node, "mcp/index.ts", "--http")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), fmt.Sprintf("MCP_HTTP_PORT=%d", port), "MCP_HTTP_HOST=127.0.0.1", "ROUTER_SERVERS="+cat, "ROUTER_BEARER=", "FLEET_BEARER=")
	var logb bytes.Buffer
	cmd.Stderr, cmd.Stdout = &logb, &logb
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	for i := 0; i < 100; i++ {
		if r, err := http.Get(base + "/health"); err == nil {
			r.Body.Close()
			return base
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("node router did not start:\n%s", logb.String())
	return ""
}

func startGo(t *testing.T, cat string) string {
	t.Setenv("ROUTER_BEARER", "")
	t.Setenv("FLEET_BEARER", "")
	entries, err := router.LoadCatalog(func(k string) string {
		if k == "ROUTER_SERVERS" {
			return cat
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	r, err := router.New(entries, router.NewClientBackend(), router.Options{SelfName: router.Self})
	if err != nil {
		t.Fatal(err)
	}
	var be router.Backend = router.NewClientBackend()
	if os.Getenv("PARITY_MUTATE") == "1" {
		be = mutant{be}
		r, _ = router.New(entries, be, router.Options{SelfName: router.Self})
	}
	ts := httptest.NewServer(server.Handler(server.New(r)))
	t.Cleanup(ts.Close)
	return ts.URL
}

// mutant changes one description of a child tool: the transcripts must then differ.
type mutant struct{ router.Backend }

func (m mutant) ListTools(ctx context.Context, e router.ServerEntry) ([]router.ToolInfo, error) {
	tools, err := m.Backend.ListTools(ctx, e)
	for i := range tools {
		if tools[i].Name == "echo" {
			tools[i].Description = "MUTATED"
		}
	}
	return tools, err
}

// post sends one JSON-RPC request and returns "status|<canonical json of the response message>".
func post(base, body string) string {
	req, _ := http.NewRequest("POST", base+"/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "transport error: " + err.Error()
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	payload := string(raw)
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		var datas []string
		sc := bufio.NewScanner(bytes.NewReader(raw))
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			if d, ok := strings.CutPrefix(sc.Text(), "data:"); ok {
				datas = append(datas, strings.TrimSpace(d))
			}
		}
		payload = strings.Join(datas, "\n")
	}
	var v any
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		if strings.Contains(payload, "not handled") && resp.StatusCode == 400 {
			return "unknown-method-rejected" // Go SDK: HTTP 400 text; TS SDK: 200 + JSON-RPC -32601 (see normalise)
		}
		return fmt.Sprintf("%d|not-json:%q", resp.StatusCode, payload)
	}
	nv := sdkNeutral(v)
	if tok, ok := nv.(string); ok {
		return tok
	}
	return fmt.Sprintf("%d|%s", resp.StatusCode, canon(nv))
}

// sdkNeutral removes what the two MCP SDKs add on their own and no client depends on, so that everything the
// router itself decides is compared byte for byte:
//   - tools/list: the TS SDK adds execution.taskSupport per tool and lists tools in registration order, the Go SDK
//     adds result.cacheScope/ttlMs and lists them sorted: tools are compared sorted by name without those fields;
//   - tool results: `_meta` and `resultType` come from the (Go SDK) child at the newest protocol version and are
//     dropped by the TS client;
//   - the text of a list_tools result embeds the child's inputSchema, whose key order the Go side cannot keep
//     (JSON maps): that text is compared as canonical JSON;
//   - a JSON-RPC -32601 reply to an unknown method (TS: HTTP 200, Go: HTTP 400 text).
func sdkNeutral(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	if e, ok := m["error"].(map[string]any); ok && e["code"] == float64(-32601) {
		return "unknown-method-rejected"
	}
	r, ok := m["result"].(map[string]any)
	if !ok {
		return v
	}
	delete(r, "cacheScope")
	delete(r, "ttlMs")
	delete(r, "_meta")
	delete(r, "resultType")
	if tools, ok := r["tools"].([]any); ok {
		for _, t := range tools {
			if tm, ok := t.(map[string]any); ok {
				delete(tm, "execution")
			}
		}
		sort.Slice(tools, func(i, j int) bool {
			return fmt.Sprint(tools[i].(map[string]any)["name"]) < fmt.Sprint(tools[j].(map[string]any)["name"])
		})
	}
	if cs, ok := r["content"].([]any); ok {
		for _, c := range cs {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			if txt, ok := cm["text"].(string); ok && strings.Contains(txt, `"inputSchema"`) {
				var inner any
				if json.Unmarshal([]byte(txt), &inner) == nil {
					cm["text"] = canon(inner)
				}
			}
		}
	}
	return v
}

// canon renders JSON with sorted keys (Go maps) so key order, which differs legitimately, is not compared.
func canon(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// noSessionStream: a stateless router has no session to stream or to delete. The TS SDK answers GET with 200 and an
// idle event stream and DELETE with 200; the Go SDK answers both 405 Method Not Allowed (the spec's reply for a server
// without a standalone stream). Anything else is reported as is.
func noSessionStream(r string) string {
	st, _, _ := strings.Cut(r, "|")
	if st == "200" || st == "405" || strings.HasPrefix(r, "no response") {
		return "no-session-stream"
	}
	return r
}

func rpc(id int, method string, params any) string {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return string(b)
}

func tool(id int, name string, args any) string {
	return rpc(id, "tools/call", map[string]any{"name": name, "arguments": args})
}

// normalise keeps what must be identical and cuts what legitimately differs between two SDKs:
// the human text of a schema-validation error and the network detail inside a failure message.
func normalise(resp string) string {
	status, body, _ := strings.Cut(resp, "|")
	var m map[string]any
	if json.Unmarshal([]byte(body), &m) != nil {
		return resp
	}
	if e, ok := m["error"].(map[string]any); ok {
		// invalid-params wording is the SDK's; the code is the contract
		m["error"] = map[string]any{"code": e["code"]}
	}
	if r, ok := m["result"].(map[string]any); ok {
		if c, ok := r["content"].([]any); ok && len(c) == 1 {
			if item, ok := c[0].(map[string]any); ok {
				if txt, ok := item["text"].(string); ok && r["isError"] == true {
					for _, p := range []string{"down-mcp: list_tools failed:", "down-mcp.echo failed:", "needs-bearer-mcp: list_tools failed:"} {
						if strings.HasPrefix(txt, p) {
							item["text"] = p
						}
					}
				}
			}
		}
	}
	return status + "|" + canon(m)
}

func get(base, path, method string) string {
	req, _ := http.NewRequest(method, base+path, nil)
	req.Header.Set("Accept", "application/json, text/event-stream")
	// a GET /mcp may open an event stream that never ends: only the status line matters, so stop reading early
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return "no response: " + strings.ReplaceAll(err.Error(), req.URL.String(), "<url>")
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return fmt.Sprintf("%d|%s", resp.StatusCode, strings.TrimSpace(string(b)))
}

type step struct {
	name string
	do   func(base string) string
}

func steps() []step {
	ss := []step{
		{"health", func(b string) string { return get(b, "/health", "GET") }},
		{"not-found", func(b string) string { return get(b, "/nope", "GET") }},
		{"initialize", func(b string) string {
			r := normalise(post(b, rpc(1, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "parity", "version": "1"}})))
			// capabilities and instructions are SDK-specific; keep protocolVersion and serverInfo
			status, body, _ := strings.Cut(r, "|")
			var m map[string]any
			_ = json.Unmarshal([]byte(body), &m)
			res, _ := m["result"].(map[string]any)
			return status + "|" + canon(map[string]any{"protocolVersion": res["protocolVersion"], "serverInfo": res["serverInfo"], "hasTools": res["capabilities"].(map[string]any)["tools"] != nil})
		}},
		{"tools/list", func(b string) string { return normalise(post(b, rpc(2, "tools/list", map[string]any{}))) }},
		{"list_servers", func(b string) string { return normalise(post(b, tool(3, "list_servers", map[string]any{}))) }},
		{"list_servers-no-args", func(b string) string {
			return normalise(post(b, rpc(3, "tools/call", map[string]any{"name": "list_servers"})))
		}},
	}
	for _, c := range []struct {
		name string
		body string
	}{
		{"list_tools-child", tool(10, "list_tools", map[string]any{"server": "child-mcp"})},
		{"list_tools-alias", tool(11, "list_tools", map[string]any{"server": "KID"})},
		{"list_tools-padded", tool(12, "list_tools", map[string]any{"server": "  child-mcp "})},
		{"list_tools-unknown", tool(13, "list_tools", map[string]any{"server": "nope"})},
		{"list_tools-blank", tool(14, "list_tools", map[string]any{"server": "  "})},
		{"list_tools-missing", tool(15, "list_tools", map[string]any{})},
		{"list_tools-wrongtype", tool(16, "list_tools", map[string]any{"server": 5})},
		{"list_tools-down", tool(17, "list_tools", map[string]any{"server": "down-mcp"})},
		{"list_tools-no-bearer", tool(18, "list_tools", map[string]any{"server": "needs-bearer-mcp"})},
		{"call-echo", tool(20, "call", map[string]any{"server": "child-mcp", "tool": "echo", "args": map[string]any{"msg": "héllo <&> \"q\""}})},
		{"call-echo-alias-noargs", tool(21, "call", map[string]any{"server": "kid", "tool": "echo"})},
		{"call-echo-twice", tool(22, "call", map[string]any{"server": "child-mcp", "tool": "echo_twice"})},
		{"call-boom", tool(23, "call", map[string]any{"server": "child-mcp", "tool": "boom"})},
		{"call-unknown-tool-near", tool(24, "call", map[string]any{"server": "child-mcp", "tool": "echo_"})},
		{"call-unknown-tool-far", tool(25, "call", map[string]any{"server": "child-mcp", "tool": "zzz"})},
		{"call-empty-tool", tool(26, "call", map[string]any{"server": "child-mcp", "tool": ""})},
		{"call-missing-tool", tool(27, "call", map[string]any{"server": "child-mcp"})},
		{"call-unknown-server", tool(28, "call", map[string]any{"server": "nope", "tool": "echo"})},
		{"call-self", tool(29, "call", map[string]any{"server": "cloudy-all-mcp", "tool": "call"})},
		{"call-args-array", tool(30, "call", map[string]any{"server": "child-mcp", "tool": "echo", "args": []any{1}})},
		{"call-args-null", tool(31, "call", map[string]any{"server": "child-mcp", "tool": "echo", "args": nil})},
		{"call-args-string", tool(32, "call", map[string]any{"server": "child-mcp", "tool": "echo", "args": "x"})},
		{"call-down", tool(33, "call", map[string]any{"server": "down-mcp", "tool": "echo"})},
		{"unknown-router-tool", tool(40, "nope", map[string]any{})},
		{"unknown-method", rpc(41, "nope/nothing", map[string]any{})},
	} {
		c := c
		ss = append(ss, step{c.name, func(b string) string { return normalise(post(b, c.body)) }})
	}
	ss = append(ss,
		step{"GET-mcp", func(b string) string { return noSessionStream(get(b, "/mcp", "GET")) }},
		step{"DELETE-mcp", func(b string) string { return noSessionStream(get(b, "/mcp", "DELETE")) }},
	)
	return ss
}

func TestParity(t *testing.T) {
	cat := catalog(child(t))
	node := startNode(t, cat)
	goURL := startGo(t, cat)
	var bad []string
	names := []string{}
	for _, s := range steps() {
		want, got := s.do(node), s.do(goURL)
		names = append(names, s.name)
		if want != got {
			bad = append(bad, fmt.Sprintf("--- %s\n  ts: %s\n  go: %s", s.name, want, got))
		}
		t.Logf("%-26s %s", s.name, truncate(want, 160))
	}
	sort.Strings(names)
	if len(bad) > 0 {
		t.Fatalf("%d of %d steps differ:\n%s", len(bad), len(names), strings.Join(bad, "\n"))
	}
	t.Logf("parity: %d steps identical", len(names))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
