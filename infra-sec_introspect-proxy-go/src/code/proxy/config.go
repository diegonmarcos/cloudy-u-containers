package proxy

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"introspect-proxy/fleetauth"
)

// FromEnv reads the same environment variables, with the same defaults, as the Python module
// did at import time. lookup is os.LookupEnv (a map in tests).
func FromEnv(lookup func(string) (string, bool), log *slog.Logger) (*Config, error) {
	get := func(k, def string) string {
		if v, ok := lookup(k); ok {
			return v
		}
		return def
	}
	var errs []error
	num := func(k, def string) float64 {
		v, err := strconv.ParseFloat(strings.TrimSpace(get(k, def)), 64)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", k, err))
		}
		return v
	}
	integer := func(k, def string) int64 {
		v, err := strconv.ParseInt(strings.TrimSpace(get(k, def)), 10, 64)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", k, err))
		}
		return v
	}
	secs := func(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }

	jwksTimeout := num("JWKS_FETCH_TIMEOUT", "3")
	jwksTTL := integer("JWKS_CACHE_TTL", "600")
	mcpTimeout := num("MCP_OAUTH_TIMEOUT", "3")
	mcpTTL := integer("MCP_OAUTH_CACHE_TTL", "30")
	tokTimeout := num("TOKENS_TIMEOUT", "3")
	tokTTL := integer("TOKENS_CACHE_TTL", "30")
	tokStale := integer("TOKENS_STALE_MAX", "300")
	if len(errs) == 0 && jwksTTL <= 0 {
		errs = append(errs, errors.New("JWKS_CACHE_TTL must be > 0")) // PyJWKClientError at import
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	jwks := fleetauth.NewJWKS(get("JWKS_URL", "https://auth.diegonmarcos.com/jwks.json"), time.Duration(jwksTTL)*time.Second, secs(jwksTimeout))
	c := &Config{
		RequiredScope: get("REQUIRED_SCOPE", "authelia.bearer.authz"),
		Verifier:      &fleetauth.Verifier{JWKS: jwks, Issuer: get("ISSUER", "https://auth.diegonmarcos.com")},
		Now:           fleetauth.WallClock,
		Log:           log,
	}
	if u := get("MCP_OAUTH_INTROSPECT_URL", ""); u != "" {
		c.MCP = fleetauth.NewMCPOAuth(u, get("MCP_OAUTH_INTROSPECT_SECRET", ""), secs(mcpTimeout), mcpTTL)
	}
	if u := get("TOKENS_VERIFY_URL", ""); u != "" {
		e := fleetauth.NewEngine(u, get("TOKENS_VERIFY_SECRET", ""), secs(tokTimeout), float64(tokTTL), float64(tokStale))
		e.Log = log
		c.Engine = e
	}
	return c, nil
}
