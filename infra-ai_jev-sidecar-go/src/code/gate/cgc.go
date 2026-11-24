package gate

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"jev-gate/pyjson"
)

// MiniYAML is mini_yaml(): block-style YAML mappings of scalars -> nested objects; list items are skipped.
func MiniYAML(text string) *pyjson.OMap {
	root := pyjson.NewMap()
	type frame struct {
		indent int
		m      *pyjson.OMap
	}
	stack := []frame{{-1, root}}
	for _, line := range strings.Split(strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text), "\n") {
		body := line
		if i := strings.Index(body, " #"); i >= 0 {
			body = body[:i]
		}
		body = strings.TrimRightFunc(body, isPySpace)
		stripped := strings.TrimLeftFunc(body, isPySpace)
		if stripped == "" || strings.HasPrefix(stripped, "#") || strings.HasPrefix(stripped, "- ") || strings.HasPrefix(stripped, "-\t") || stripped == "-" {
			continue
		}
		key, val, found := strings.Cut(stripped, ":")
		if !found {
			continue
		}
		indent := runeLen(body) - runeLen(stripped)
		for stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		parent := stack[len(stack)-1].m
		key = strings.Trim(strings.TrimSpace(key), "'\"")
		val = strings.TrimSpace(val)
		if val != "" {
			parent.Set(key, strings.Trim(val, "'\""))
		} else {
			child := pyjson.NewMap()
			parent.Set(key, child)
			stack = append(stack, frame{indent, child})
		}
	}
	return root
}

func isPySpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Endpoint is a code-graph MCP server taken from the CLI's own client config.
type Endpoint struct {
	Server, URL string
	Headers     [][2]string
}

// CgcEndpoint is cgc_endpoint(): the first code_graph.servers entry the CLI's own MCP config declares.
func CgcEndpoint(cli string, cfg Config) (*Endpoint, error) {
	g := pyjson.AsMap(cfg.M["code_graph"])
	c := pyjson.AsMap(get(g, "client_configs", cli))
	if c == nil {
		return nil, nil
	}
	path, _ := expand(str(c.M["path"]), false)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, perr("FileNotFoundError", "%v", err)
	}
	var parsed *pyjson.OMap
	if strings.HasSuffix(path, ".json") {
		v, err := pyjson.Parse(b)
		if err != nil {
			return nil, perr("JSONDecodeError", "%v", err)
		}
		if parsed = pyjson.AsMap(v); parsed == nil {
			return nil, perr("AttributeError", "config is not an object")
		}
	} else {
		parsed = MiniYAML(string(b))
	}
	servers := pyjson.AsMap(parsed.M[str(c.M["servers_key"])])
	for _, nv := range pyjson.AsList(g.M["servers"]) {
		name := str(nv)
		sv, _ := servers.Get(name)
		s := pyjson.AsMap(sv)
		if s == nil {
			continue
		}
		if en, ok := s.M["enabled"]; ok && strings.ToLower(pyStr(en)) == "false" {
			continue
		}
		urlV := s.M["url"]
		if !pyjson.Truthy(urlV) {
			urlV = s.M["uri"]
		}
		u, isStr := urlV.(string)
		var headers [][2]string
		okH := true
		if h := pyjson.AsMap(s.M["headers"]); h != nil {
			for _, k := range h.Keys {
				if hv, isS := h.M[k].(string); isS {
					e, ok := expand(hv, true)
					if !ok {
						okH = false
					}
					headers = append(headers, [2]string{k, e})
				}
			}
		}
		if isStr && (strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")) && okH {
			return &Endpoint{Server: name, URL: u, Headers: headers}, nil
		}
	}
	return nil, nil
}

// mcpRPC is the bound rpc(method, params) of mcp_session().
type mcpRPC func(method string, params any, notify bool) (any, error)

// McpSession is mcp_session(): initialize one streamable-HTTP MCP session.
func McpSession(ep *Endpoint, deadline time.Time, cfg Config) (mcpRPC, error) {
	g := pyjson.AsMap(cfg.M["code_graph"])
	maxBytes := intOf(g.M["max_response_bytes"])
	var sid string
	var ids int64
	rpc := func(method string, params any, notify bool) (any, error) {
		left := time.Until(deadline)
		if left <= 0 {
			return nil, perr("TimeoutError", "code_graph budget spent")
		}
		body := pyjson.Obj("jsonrpc", "2.0", "method", method)
		if params != nil {
			body.Set("params", params)
		}
		var id int64
		if !notify {
			ids++
			id = ids
			body.Set("id", id)
		}
		ctx, cancel := context.WithTimeout(context.Background(), left)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "POST", ep.URL, bytes.NewReader([]byte(pyjson.DumpsDefault(body))))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		for _, h := range ep.Headers {
			req.Header.Set(h[0], h[1])
		}
		if sid != "" {
			req.Header.Set("Mcp-Session-Id", sid)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, httpErr(err)
		}
		defer res.Body.Close()
		if res.StatusCode >= 400 {
			return nil, &PyErr{"HTTPError", fmt.Sprint(res.StatusCode)}
		}
		if h := res.Header.Get("Mcp-Session-Id"); h != "" {
			sid = h
		}
		ctype := res.Header.Get("Content-Type")
		raw, err := io.ReadAll(io.LimitReader(res.Body, int64(maxBytes)+1))
		if err != nil {
			return nil, httpErr(err)
		}
		if notify {
			return nil, nil
		}
		if len(raw) > maxBytes {
			return nil, perr("ValueError", "response too large")
		}
		text := strings.ToValidUTF8(string(raw), "�")
		var msgs []any
		if strings.Contains(ctype, "event-stream") {
			for _, ev := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n") {
				var datas []string
				for _, l := range strings.Split(ev, "\n") {
					if strings.HasPrefix(l, "data:") {
						datas = append(datas, strings.TrimLeftFunc(l[5:], isPySpace))
					}
				}
				if data := strings.Join(datas, "\n"); data != "" {
					m, err := pyjson.Parse([]byte(data))
					if err != nil {
						return nil, perr("JSONDecodeError", "%v", err)
					}
					msgs = append(msgs, m)
				}
			}
		} else {
			m, err := pyjson.Parse([]byte(text))
			if err != nil {
				return nil, perr("JSONDecodeError", "%v", err)
			}
			msgs = []any{m}
		}
		var msg *pyjson.OMap
		for _, m := range msgs {
			if mm := pyjson.AsMap(m); mm != nil {
				if v, ok := mm.M["id"]; ok && pyEq(v, id) {
					msg = mm
					break
				}
			}
		}
		if msg == nil {
			return nil, perr("StopIteration", "")
		}
		if e, has := msg.Get("error"); has {
			code := any(nil)
			if em := pyjson.AsMap(e); em != nil {
				code = em.M["code"]
			}
			return nil, perr("RuntimeError", "mcp error %s", pyStr(code))
		}
		r, ok := msg.Get("result")
		if !ok {
			return nil, perr("KeyError", "result")
		}
		return r, nil
	}
	if _, err := rpc("initialize", pyjson.Obj("protocolVersion", g.M["protocol_version"], "capabilities", pyjson.NewMap(),
		"clientInfo", pyjson.Obj("name", "jev-gate", "version", "1.1.0")), false); err != nil {
		return nil, err
	}
	if _, err := rpc("notifications/initialized", nil, true); err != nil {
		return nil, err
	}
	return rpc, nil
}

func toolText(rpc mcpRPC, tool string, args *pyjson.OMap) (string, error) {
	r, err := rpc("tools/call", pyjson.Obj("name", tool, "arguments", args), false)
	if err != nil {
		return "", err
	}
	rm := pyjson.AsMap(r)
	if rm == nil {
		return "", perr("AttributeError", "result is not an object")
	}
	if pyjson.Truthy(rm.M["isError"]) {
		return "", perr("RuntimeError", "tool error")
	}
	var parts []string
	for _, c := range pyjson.AsList(rm.M["content"]) {
		cm := pyjson.AsMap(c)
		if cm == nil {
			return "", perr("AttributeError", "content item")
		}
		if cm.M["type"] == "text" {
			parts = append(parts, str(cm.M["text"]))
		}
	}
	return strings.Join(parts, "\n"), nil
}

// RepoOf is repo_of(): the nearest ancestor of path holding a .git (dir, or file for a worktree), or "".
func RepoOf(path string) string {
	d, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	for {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		up := filepath.Dir(d)
		if up == d {
			return ""
		}
		d = up
	}
}
