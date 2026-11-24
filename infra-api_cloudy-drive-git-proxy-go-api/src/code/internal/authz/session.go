package authz

import (
	"fmt"
	"net/http"
	"time"
)

// SessionVerifier asks Authelia's auth-request endpoint the question the edge's forward_auth asks: is this
// cookie a live session its access rules admit for this URL? It reads X-Original-URL (the hub's auth vhost
// passes it through untouched). Never cached: a logout must take effect at once.
type SessionVerifier struct {
	VerifyURL string        // runtime.authelia.session.verify_url
	PublicURL string        // runtime.authelia.session.public_url (origin)
	BasePath  string        // runtime.base_path
	Timeout   time.Duration // runtime.authelia.session.timeout_ms
	Client    *http.Client  // optional
}

// Verify returns the Authelia username for the cookie. method and path are the ones of the request being
// judged (path is the local path, as the Node service passes it). ErrSessionUnavailable when Authelia
// cannot answer or answers 5xx; any other error for a dead or insufficient session.
func (v *SessionVerifier) Verify(cookie, method, path string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, v.VerifyURL, nil)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrSessionUnavailable, err)
	}
	req.Header.Set("Cookie", cookie)
	req.Header.Set("X-Original-Url", v.PublicURL+v.BasePath+path)
	req.Header.Set("X-Original-Method", method)
	req.Header.Set("Accept", "application/json")
	c := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if v.Client != nil {
		c = *v.Client
		c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	if v.Timeout > 0 {
		c.Timeout = v.Timeout
	}
	res, err := c.Do(req)
	if err != nil {
		return "", ErrSessionUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode == 200 {
		if user := res.Header.Get("Remote-User"); user != "" {
			return user, nil
		}
	}
	if res.StatusCode >= 500 {
		return "", ErrSessionUnavailable
	}
	return "", fmt.Errorf("session refused (%d)", res.StatusCode)
}
