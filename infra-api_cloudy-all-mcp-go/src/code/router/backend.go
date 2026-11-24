package router

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ClientBackend is the SDK-backed Backend: one short-lived MCP client per operation, trying each of
// the entry's urls in order (mesh first, public with the bearer second). Stateless on purpose: no
// pooled sessions to go stale.
type ClientBackend struct {
	Timeout time.Duration
	// Bearer returns the public-route bearer ("" = none); read per call like the TS router.
	Bearer func() string
}

// NewClientBackend reads ROUTER_TIMEOUT_MS (default 30000), ROUTER_BEARER / FLEET_BEARER.
func NewClientBackend() *ClientBackend {
	ms := 30000
	if v, err := strconv.Atoi(os.Getenv("ROUTER_TIMEOUT_MS")); err == nil && v > 0 {
		ms = v
	}
	return &ClientBackend{
		Timeout: time.Duration(ms) * time.Millisecond,
		Bearer: func() string {
			if b := os.Getenv("ROUTER_BEARER"); b != "" {
				return b
			}
			return os.Getenv("FLEET_BEARER")
		},
	}
}

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r2)
}

func (c *ClientBackend) withSession(ctx context.Context, e ServerEntry, fn func(context.Context, *mcp.ClientSession) error) error {
	var errs []string
	for _, url := range e.URLs {
		isPublic := strings.HasPrefix(url, "https://")
		tok := c.Bearer()
		if isPublic && tok == "" {
			errs = append(errs, url+": no ROUTER_BEARER for the public route")
			continue
		}
		hc := &http.Client{}
		if isPublic {
			hc.Transport = bearerTransport{token: tok}
		}
		err := func() error {
			cctx, cancel := context.WithTimeout(ctx, c.Timeout)
			defer cancel()
			client := mcp.NewClient(&mcp.Implementation{Name: Self, Version: "1.0.0"}, nil)
			cs, err := client.Connect(cctx, &mcp.StreamableClientTransport{Endpoint: url, HTTPClient: hc, MaxRetries: -1, DisableStandaloneSSE: true}, nil)
			if err != nil {
				return err
			}
			defer cs.Close()
			return fn(cctx, cs)
		}()
		if err == nil {
			return nil
		}
		errs = append(errs, url+": "+err.Error())
	}
	if len(errs) == 0 {
		return errors.New("no endpoint configured")
	}
	return errors.New(strings.Join(errs, " | "))
}

// ListTools pages through the child's tools/list.
func (c *ClientBackend) ListTools(ctx context.Context, e ServerEntry) ([]ToolInfo, error) {
	out := []ToolInfo{}
	err := c.withSession(ctx, e, func(ctx context.Context, cs *mcp.ClientSession) error {
		out = out[:0]
		cursor := ""
		for {
			r, err := cs.ListTools(ctx, &mcp.ListToolsParams{Cursor: cursor})
			if err != nil {
				return err
			}
			for _, t := range r.Tools {
				out = append(out, ToolInfo{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
			}
			if r.NextCursor == "" {
				return nil
			}
			cursor = r.NextCursor
		}
	})
	return out, err
}

// CallTool forwards one tools/call and returns the child's *mcp.CallToolResult untouched.
func (c *ClientBackend) CallTool(ctx context.Context, e ServerEntry, tool string, args map[string]any) (any, error) {
	var res *mcp.CallToolResult
	err := c.withSession(ctx, e, func(ctx context.Context, cs *mcp.ClientSession) error {
		r, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
		res = r
		return err
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}
