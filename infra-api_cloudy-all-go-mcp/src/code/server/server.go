// Package server exposes the router as three MCP tools over stateless Streamable HTTP (and stdio):
// a fresh session per request, no state kept between requests (the router holds none).
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

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

// invalid is an argument-validation failure shaped like the TypeScript SDK's zod error:
// "Input validation error: Invalid arguments for tool <tool>: <detail>"; the middleware below turns it
// into the tool-level error result the TypeScript router returns ("MCP error -32602: ...").
func invalid(tool, detail string) error {
	return &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: fmt.Sprintf("Input validation error: Invalid arguments for tool %s: %s", tool, detail)}
}

func jsType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case []any:
		return "array"
	}
	return "object"
}

// decode parses the tool arguments into a generic object (absent = empty).
func decode(tool string, raw json.RawMessage) (map[string]any, error) {
	m := map[string]any{}
	if len(raw) == 0 || string(raw) == "null" {
		return m, nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, invalid(tool, fmt.Sprintf("Expected object, received %s", jsType(nil)))
	}
	return m, nil
}

func str(tool string, m map[string]any, key string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", invalid(tool, "Required at "+key)
	}
	s, ok := v.(string)
	if !ok {
		return "", invalid(tool, fmt.Sprintf("Expected string, received %s at %s", jsType(v), key))
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
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}, "$schema": "http://json-schema.org/draft-07/schema#"},
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if _, err := decode("list_servers", req.Params.Arguments); err != nil {
			return nil, err
		}
		return text(r.ListServers()), nil
	})

	s.AddTool(&mcp.Tool{
		Name:        "list_tools",
		Description: "List one server's tools with their input schemas. Old cloud-* names work as aliases.",
		InputSchema: objSchema(map[string]any{"server": map[string]any{"type": "string", "description": "server name from list_servers"}}, []string{"server"}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		m, err := decode("list_tools", req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		srv, err := str("list_tools", m, "server")
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
		m, err := decode("call", req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		srv, err := str("call", m, "server")
		if err != nil {
			return nil, err
		}
		tool, err := str("call", m, "tool")
		if err != nil {
			return nil, err
		}
		var args any
		if v, ok := m["args"]; ok {
			a, ok := v.(map[string]any)
			if !ok {
				return nil, invalid("call", fmt.Sprintf("Expected object, received %s at args", jsType(v)))
			}
			args = a
		}
		return passthrough(r.Call(ctx, srv, tool, args)), nil
	})
	s.AddReceivingMiddleware(toolErrors)
	return s
}

// toolErrors makes argument and unknown-tool failures of tools/call tool-level error results, the way the
// TypeScript SDK reports them ({"isError":true,"content":[{"type":"text","text":"MCP error -32602: ..."}]}),
// instead of JSON-RPC errors.
func toolErrors(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		res, err := next(ctx, method, req)
		if method != "tools/call" || err == nil {
			return res, err
		}
		var je *jsonrpc.Error
		if !errors.As(err, &je) || je.Code != jsonrpc.CodeInvalidParams {
			return res, err
		}
		msg := je.Message
		if strings.HasPrefix(msg, "unknown tool") {
			if r, ok := req.(*mcp.CallToolRequest); ok && r.Params != nil {
				msg = fmt.Sprintf("Tool %s not found", r.Params.Name)
			}
		}
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "MCP error -32602: " + msg}}}, nil
	}
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
