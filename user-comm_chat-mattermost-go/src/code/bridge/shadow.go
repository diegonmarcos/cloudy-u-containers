package bridge

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// RunShadow is the shadow stage: it never talks to Mattermost and holds no credentials. It serves the /c3 slash
// handler read-only (every mutating C3 call is refused locally) and follows the ntfy stream, formatting every message
// exactly as the live bridge would and only LOGGING the webhook post it would have made.
func RunShadow(b *Bridge, stop <-chan struct{}) {
	b.ReadOnly = true
	var seen atomic.Int64
	addr := fmt.Sprintf("%s:%d", b.Cfg.C3BindIP, b.Cfg.C3Port)
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/", b.SlashHandler())
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ok": true, "shadow": true, "ntfy_messages_seen": %d}`, seen.Load())
		})
		b.logf("shadow: C3 command server (read-only) listening on %s", addr)
		srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		b.logf("shadow: server stopped: %v", srv.ListenAndServe())
	}()
	// The webhook is a local sink that counts the posts instead of Mattermost (see countingTransport).
	b.HTTP = &http.Client{Transport: &countingTransport{inner: http.DefaultTransport, seen: &seen, logf: b.logf}}
	b.BridgeLoop("http://shadow-webhook.invalid/hooks/shadow", stop)
}

// countingTransport answers the webhook post locally with 200 (and counts it) and passes every other request on.
type countingTransport struct {
	inner http.RoundTripper
	seen  *atomic.Int64
	logf  func(string, ...any)
}

func (t *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == "shadow-webhook.invalid" {
		t.seen.Add(1)
		t.logf("shadow dry-run webhook post #%d", t.seen.Load())
		return &http.Response{StatusCode: 200, Status: "200 OK", Body: http.NoBody, Header: http.Header{}, Request: r}, nil
	}
	return t.inner.RoundTrip(r)
}
