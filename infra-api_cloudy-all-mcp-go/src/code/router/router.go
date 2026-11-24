// Package router is the whole router contract with no MCP SDK import, so it is unit-testable
// (the Go port of mcp/router.ts of infra-api_cloudy-all-mcp, ticket #1874).
//
// Three operations (exposed as MCP tools by the server package):
//
//	ListServers()               the fleet servers, names + one-line purpose
//	ListTools(server)           that server's tool list (name, description, inputSchema)
//	Call(server, tool, args)    run one tool on that server
//
// Old names (cloud-mail-mcp, cloud-infra-mcp, ...) resolve through Aliases.
package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ServerEntry is one fronted MCP server. URLs are tried in order: mesh first, public (bearer) second.
type ServerEntry struct {
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases,omitempty"`
	Description string   `json:"description"`
	URLs        []string `json:"urls"`
}

// ToolInfo is one tool of a child server.
type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	InputSchema any    `json:"inputSchema,omitempty"`
}

// Backend talks to the child servers. CallTool returns the child's own result untouched (opaque to
// this package; the server package passes a CallToolResult through as is).
type Backend interface {
	ListTools(ctx context.Context, e ServerEntry) ([]ToolInfo, error)
	CallTool(ctx context.Context, e ServerEntry, tool string, args map[string]any) (any, error)
}

// Failure is the router's error result: {isError:true, content:[{type:text,text}]}.
type Failure struct{ Text string }

func fail(format string, a ...any) *Failure { return &Failure{Text: fmt.Sprintf(format, a...)} }

// JSONNull marks an explicit JSON null argument (as opposed to an absent one, which is Go nil).
type JSONNull struct{}

// ServerSummary is one row of list_servers.
type ServerSummary struct {
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases"`
	Description string   `json:"description"`
}

// ToolList is the list_tools result.
type ToolList struct {
	Server string     `json:"server"`
	Tools  []ToolInfo `json:"tools"`
}

// Options of a Router.
type Options struct {
	// TTL is the tool-list cache lifetime; zero means the default 60 s, negative disables the cache.
	TTL time.Duration
	Now func() time.Time
	// SelfName is this router's own name: never routed to (no recursion).
	SelfName string
}

type cacheHit struct {
	at    time.Time
	tools []ToolInfo
}

// Router resolves names and fans out to the backend.
type Router struct {
	mu      sync.Mutex
	byKey   map[string]*ServerEntry
	cache   map[string]cacheHit
	ttl     time.Duration
	now     func() time.Time
	backend Backend
}

// New builds a Router; two entries claiming one name (case-insensitive) is an error.
func New(entries []ServerEntry, backend Backend, opts Options) (*Router, error) {
	r := &Router{byKey: map[string]*ServerEntry{}, cache: map[string]cacheHit{}, backend: backend, ttl: opts.TTL, now: opts.Now}
	if r.ttl == 0 {
		r.ttl = 60 * time.Second
	}
	if r.now == nil {
		r.now = time.Now
	}
	for i := range entries {
		e := &entries[i]
		if e.Name == opts.SelfName {
			continue
		}
		for _, k := range append([]string{e.Name}, e.Aliases...) {
			key := strings.ToLower(k)
			if prev, ok := r.byKey[key]; ok && prev != e {
				return nil, fmt.Errorf("router: name '%s' is claimed by both '%s' and '%s'", k, prev.Name, e.Name)
			}
			r.byKey[key] = e
		}
	}
	return r, nil
}

// ListServers returns every server once, sorted by name, without urls.
func (r *Router) ListServers() []ServerSummary {
	seen := map[*ServerEntry]bool{}
	out := []ServerSummary{}
	for _, e := range r.byKey {
		if seen[e] {
			continue
		}
		seen[e] = true
		al := e.Aliases
		if al == nil {
			al = []string{}
		}
		out = append(out, ServerSummary{Name: e.Name, Aliases: al, Description: e.Description})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Resolve maps a server argument (name or alias, any case, surrounding space ignored) to its entry.
func (r *Router) Resolve(server any) (*ServerEntry, *Failure) {
	s, ok := server.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return nil, fail("server is required (see list_servers)")
	}
	if e, ok := r.byKey[strings.ToLower(strings.TrimSpace(s))]; ok {
		return e, nil
	}
	names := []string{}
	for _, x := range r.ListServers() {
		names = append(names, x.Name)
	}
	return nil, fail("unknown server '%s'. Known: %s", s, strings.Join(names, ", "))
}

// ListTools returns *ToolList or *Failure.
func (r *Router) ListTools(ctx context.Context, server any) any {
	e, f := r.Resolve(server)
	if f != nil {
		return f
	}
	tools, err := r.tools(ctx, e, false)
	if err != nil {
		return fail("%s: list_tools failed: %s", e.Name, err.Error())
	}
	return &ToolList{Server: e.Name, Tools: tools}
}

// Call runs one tool; returns the backend's opaque result or *Failure. args: nil = absent,
// JSONNull{} = explicit null, otherwise the decoded JSON value.
func (r *Router) Call(ctx context.Context, server, tool, args any) any {
	e, f := r.Resolve(server)
	if f != nil {
		return f
	}
	t, ok := tool.(string)
	if !ok || strings.TrimSpace(t) == "" {
		return fail("tool is required (see list_tools)")
	}
	a := map[string]any{}
	switch v := args.(type) {
	case nil:
	case map[string]any:
		a = v
	default:
		return fail("args must be an object")
	}
	tools, err := r.tools(ctx, e, false)
	if err == nil && !has(tools, t) {
		tools, err = r.tools(ctx, e, true) // maybe a stale cache
	}
	if err != nil {
		return fail("%s.%s failed: %s", e.Name, t, err.Error())
	}
	if !has(tools, t) {
		near := []string{}
		for _, x := range tools {
			if strings.Contains(x.Name, t) || strings.Contains(t, x.Name) {
				near = append(near, x.Name)
			}
		}
		if len(near) > 8 {
			near = near[:8]
		}
		sim := ""
		if len(near) > 0 {
			sim = " Similar: " + strings.Join(near, ", ") + "."
		}
		return fail("%s has no tool '%s'.%s Use list_tools.", e.Name, t, sim)
	}
	res, err := r.backend.CallTool(ctx, *e, t, a)
	if err != nil {
		return fail("%s.%s failed: %s", e.Name, t, err.Error())
	}
	return res
}

func has(tools []ToolInfo, name string) bool {
	for _, t := range tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

func (r *Router) tools(ctx context.Context, e *ServerEntry, force bool) ([]ToolInfo, error) {
	r.mu.Lock()
	hit, ok := r.cache[e.Name]
	r.mu.Unlock()
	if !force && ok && r.ttl > 0 && r.now().Sub(hit.at) < r.ttl {
		return hit.tools, nil
	}
	tools, err := r.backend.ListTools(ctx, *e)
	if err != nil {
		return nil, err
	}
	if tools == nil {
		tools = []ToolInfo{}
	}
	r.mu.Lock()
	r.cache[e.Name] = cacheHit{at: r.now(), tools: tools}
	r.mu.Unlock()
	return tools, nil
}

// JSON renders v like JSON.stringify(v, null, 2): two-space indent, no HTML escaping.
func JSON(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(b.String(), "\n")
}
