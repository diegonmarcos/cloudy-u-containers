// Package server exposes the router as three MCP tools over stateless Streamable HTTP (and stdio):
// a fresh session per request, no state kept between requests (the router holds none).
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"cloudy-all-mcp/router"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func text(v any) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: router.JSON(v)}}}
}

// passthrough: a child's own CallToolResult goes through untouched, a router failure becomes an
// isError result, anything else is rendered as JSON text.
func passthrough(v any) *mcp.CallToolResult {
	switch x := v.(type) {
	case *mcp.CallToolResult:
		if x != nil {
			return x
		}
		return text(nil)
	case *router.Failure:
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: x.Text}}}
	}
	return text(v)
}

func invalid(format string, a ...any) error {
	return &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: fmt.Sprintf(format, a...)}
}

// decode parses the tool arguments into a generic object (absent = empty).
func decode(raw json.RawMessage) (map[string]any, error) {
	m := map[string]any{}
	if len(raw) == 0 || string(raw) == "null" {
		return m, nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, invalid("Invalid arguments: %v", err)
	}
	return m, nil
}

func str(m map[string]any, key string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", invalid("Invalid arguments: %s is required", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", invalid("Invalid arguments: %s must be a string", key)
	}
	return s, nil
}

func objSchema(props map[string]any, required []string) map[string]any {
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#"}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

// New builds the MCP server with the three router tools.
func New(r *router.Router) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: router.Self, Version: "1.0.0"}, nil)

	s.AddTool(&mcp.Tool{
		Name:        "list_servers",
		Description: "List the fleet MCP servers behind this router (name, aliases, purpose).",
		InputSchema: objSchema(map[string]any{}, nil),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if _, err := decode(req.Params.Arguments); err != nil {
			return nil, err
		}
		return text(r.ListServers()), nil
	})

	s.AddTool(&mcp.Tool{
		Name:        "list_tools",
		Description: "List one server's tools with their input schemas. Old cloud-* names work as aliases.",
		InputSchema: objSchema(map[string]any{"server": map[string]any{"type": "string", "description": "server name from list_servers"}}, []string{"server"}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		m, err := decode(req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		srv, err := str(m, "server")
		if err != nil {
			return nil, err
		}
		return passthrough(r.ListTools(ctx, srv)), nil
	})

	s.AddTool(&mcp.Tool{
		Name:        "call",
		Description: "Call one tool on one fleet server.",
		InputSchema: objSchema(map[string]any{
			"server": map[string]any{"type": "string", "description": "server name from list_servers"},
			"tool":   map[string]any{"type": "string", "description": "tool name from list_tools"},
			"args":   map[string]any{"type": "object", "additionalProperties": map[string]any{}, "description": "tool arguments"},
		}, []string{"server", "tool"}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		m, err := decode(req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		srv, err := str(m, "server")
		if err != nil {
			return nil, err
		}
		tool, err := str(m, "tool")
		if err != nil {
			return nil, err
		}
		var args any
		if v, ok := m["args"]; ok {
			a, ok := v.(map[string]any)
			if !ok {
				return nil, invalid("Invalid arguments: args must be an object")
			}
			args = a
		}
		return passthrough(r.Call(ctx, srv, tool, args)), nil
	})
	return s
}

// Handler serves /health and the stateless Streamable HTTP endpoint /mcp (404 JSON elsewhere).
func Handler(s *mcp.Server) http.Handler {
	mcpH := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, &mcp.StreamableHTTPOptions{Stateless: true, DisableLocalhostProtection: true})
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/health":
			w.WriteHeader(200)
			_, _ = w.Write([]byte("ok"))
		case "/mcp":
			mcpH.ServeHTTP(w, req)
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"Not Found"}`))
		}
	})
}
