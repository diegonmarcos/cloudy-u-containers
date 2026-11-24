package bridge

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// FetchOIDCToken gets a C3 API bearer via the client_credentials grant; empty when unconfigured or failing
// (the caller then falls back to C3_API_TOKEN), exactly like fetch_oidc_token().
func FetchOIDCToken(b *Bridge) string {
	id, secret, tokenURL := os.Getenv("AUTHELIA_OIDC_CLIENT_ID"), os.Getenv("AUTHELIA_OIDC_CLIENT_SECRET"), os.Getenv("AUTHELIA_TOKEN_URL")
	if id == "" || secret == "" || tokenURL == "" {
		return ""
	}
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {"authelia.bearer.authz"}}
	req, err := http.NewRequest(http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		b.logf("OIDC token fetch failed: %v", err)
		return ""
	}
	req.SetBasicAuth(id, secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	c := *b.HTTP
	c.Timeout = 10 * time.Second
	resp, err := c.Do(req)
	if err != nil {
		b.logf("OIDC token fetch failed: %v", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b.logf("OIDC token fetch failed: HTTP %d", resp.StatusCode)
		return ""
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil {
		return ""
	}
	if out.AccessToken != "" {
		b.logf("OIDC token acquired via client_credentials (%d chars)", len(out.AccessToken))
	}
	return out.AccessToken
}
