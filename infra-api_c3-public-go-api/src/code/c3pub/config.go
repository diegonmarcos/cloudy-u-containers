// Package c3pub is the Go port of infra-api_c3-public-api (ticket #1882): the public API on oci-apps with the analytics
// passthrough (/analytics/<slug>), the Bearer-gated mail bridge (/mail/http-to-smtp), the SuperApp config artifact and
// Profile > Connect (bearer + mailed one-time code). Behaviour of the Fastify stack (404 shapes, CORS, rate limit, HEAD
// routes, error envelopes) is reproduced and pinned by the parity harness against the real Node service.
package c3pub

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Backend is one analytics upstream (BACKENDS_JSON, resolved by compose at render time).
type Backend struct {
	URL           string   `json:"url"`
	Service       string   `json:"service"`
	Methods       []string `json:"methods"`
	AuthHeaderEnv *string  `json:"auth_header_env"`
}

// Limits is LIMITS_JSON.
type Limits struct {
	MaxBodyBytes     float64  `json:"max_body_bytes"`
	MaxIngestLines   float64  `json:"max_ingest_lines"`
	RatePerIPPerMin  float64  `json:"rate_per_ip_per_min"`
	RatePerSIDPerMin float64  `json:"rate_per_sid_per_min"`
	RequestTimeoutMS float64  `json:"request_timeout_ms"`
	SMTPTimeoutMS    *float64 `json:"smtp_timeout_ms"`
	DedupeTTLMS      *float64 `json:"dedupe_ttl_ms"`
}

// MailTarget is one SMTP store.
type MailTarget struct {
	Host string  `json:"host"`
	Port float64 `json:"port"`
}

// ProfileCfg is the Profile > Connect configuration.
type ProfileCfg struct {
	MailTo          string
	MailFrom        string
	CodeTTLS        int
	ResendCooldownS int
	MaxAttempts     int
	BundleDir       string
	BundleFile      string
	SchemaFile      string
}

// Config is everything the process reads from its environment.
type Config struct {
	Host     string
	Port     int
	BasePath string
	Backends map[string]Backend
	Limits   Limits
	Primary  MailTarget
	Targets  map[string]MailTarget
	Helo     string
	DefUser  string
	Profile  ProfileCfg
	Auth     map[string]string // resolved analytics Authorization headers by slug
	// SuperappDirs are searched in order for build-cloud-superapp-<user>.json (the Node service uses cwd, then a repo-relative dir).
	SuperappDirs []string
}

func readJSON(getenv func(string) string, name string, into any) error {
	raw := getenv(name)
	if raw == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), into); err != nil {
		return fmt.Errorf("%s env var is not valid JSON: %v", name, err)
	}
	return nil
}

func readInt(getenv func(string) string, name string, def int) (int, error) {
	raw := getenv(name)
	if raw == "" {
		return def, nil
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0, fmt.Errorf("%s env var is not a number: %s", name, raw)
	}
	return int(f), nil
}

func or(getenv func(string) string, k, d string) string {
	if v := getenv(k); v != "" {
		return v
	}
	return d
}

// LoadConfig mirrors shared/config.ts loadConfig.
func LoadConfig(getenv func(string) string) (*Config, error) {
	cfg := &Config{Backends: map[string]Backend{}, Targets: map[string]MailTarget{}, Auth: map[string]string{}}
	if err := readJSON(getenv, "BACKENDS_JSON", &cfg.Backends); err != nil {
		return nil, err
	}
	cfg.Limits = Limits{MaxBodyBytes: 104857600, MaxIngestLines: 5000, RatePerIPPerMin: 60, RatePerSIDPerMin: 1000, RequestTimeoutMS: 5000}
	d1, d2 := 120000.0, 1800000.0
	cfg.Limits.SMTPTimeoutMS, cfg.Limits.DedupeTTLMS = &d1, &d2
	if raw := getenv("LIMITS_JSON"); raw != "" {
		cfg.Limits = Limits{}
		if err := readJSON(getenv, "LIMITS_JSON", &cfg.Limits); err != nil {
			return nil, err
		}
		// #1819: older LIMITS_JSON without the two new keys keeps working.
		if cfg.Limits.SMTPTimeoutMS == nil {
			v := cfg.Limits.RequestTimeoutMS
			if v < 120000 {
				v = 120000
			}
			cfg.Limits.SMTPTimeoutMS = &v
		}
		if cfg.Limits.DedupeTTLMS == nil {
			v := 1800000.0
			cfg.Limits.DedupeTTLMS = &v
		}
	}
	for slug, b := range cfg.Backends {
		if b.AuthHeaderEnv != nil && *b.AuthHeaderEnv != "" {
			if v := getenv(*b.AuthHeaderEnv); v != "" {
				cfg.Auth[slug] = v
			}
		}
	}
	port, err := readInt(getenv, "SMTP_PORT", 25)
	if err != nil {
		return nil, err
	}
	cfg.Primary = MailTarget{Host: getenv("SMTP_HOST"), Port: float64(port)}
	if err := readJSON(getenv, "MAIL_TARGETS_JSON", &cfg.Targets); err != nil {
		return nil, err
	}
	cfg.Helo = or(getenv, "SMTP_HELO_DOMAIN", "c3-public-api.local")
	cfg.DefUser = or(getenv, "SMTP_USER", "cloudflare@localhost")

	pc := &cfg.Profile
	pc.MailTo, pc.MailFrom = getenv("PROFILE_CONNECT_MAIL_TO"), getenv("PROFILE_CONNECT_MAIL_FROM")
	if pc.CodeTTLS, err = readInt(getenv, "PROFILE_CONNECT_CODE_TTL_S", 600); err != nil {
		return nil, err
	}
	if pc.ResendCooldownS, err = readInt(getenv, "PROFILE_CONNECT_RESEND_COOLDOWN_S", 60); err != nil {
		return nil, err
	}
	if pc.MaxAttempts, err = readInt(getenv, "PROFILE_CONNECT_MAX_ATTEMPTS", 5); err != nil {
		return nil, err
	}
	pc.BundleDir = getenv("PROFILE_CONNECT_BUNDLE_DIR")
	pc.BundleFile = or(getenv, "PROFILE_CONNECT_BUNDLE_FILE", "profile-secrets.json")
	pc.SchemaFile = or(getenv, "PROFILE_CONNECT_SCHEMA_FILE", "schema.json")

	cfg.Host = or(getenv, "HOST", "0.0.0.0")
	if cfg.Port, err = readInt(getenv, "PORT", 8087); err != nil {
		return nil, err
	}
	cfg.BasePath = or(getenv, "BASE_PATH", "/c3-public-api")
	if d := getenv("SUPERAPP_DIR"); d != "" {
		cfg.SuperappDirs = []string{d}
	} else {
		cfg.SuperappDirs = []string{"."}
	}
	return cfg, nil
}
