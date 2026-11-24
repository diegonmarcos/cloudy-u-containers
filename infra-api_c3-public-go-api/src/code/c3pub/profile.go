package c3pub

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"c3public-api/internal/ojson"
)

// Identity is the bearer identity Caddy stamped (introspect-proxy -> X-Auth-User; the Authelia cookie path -> Remote-User).
// "" means the request did not come through the gate; a mesh source address does NOT substitute for it here.
func Identity(h http.Header) string {
	v := h.Get("X-Auth-User")
	if v == "" {
		v = h.Get("Remote-User")
	}
	return jsTrim(v)
}

type pending struct {
	hash         [32]byte
	expiresAt    time.Time
	issuedAt     time.Time
	attemptsLeft int
}

// CodeStore is the in-memory, per-identity one-time code store. One live code per identity; single use; dies on success,
// expiry, or maxAttempts wrong guesses.
type CodeStore struct {
	mu       sync.Mutex
	pending  map[string]*pending
	ttl      time.Duration
	cooldown time.Duration
	max      int
	ttlS     int
}

func NewCodeStore(c ProfileCfg) *CodeStore {
	return &CodeStore{pending: map[string]*pending{}, ttl: time.Duration(c.CodeTTLS) * time.Second, cooldown: time.Duration(c.ResendCooldownS) * time.Second, max: c.MaxAttempts, ttlS: c.CodeTTLS}
}

type IssueResult struct {
	OK         bool
	Code       string
	ExpiresIn  int
	RetryAfter int
}

func (s *CodeStore) Issue(user string, now time.Time) IssueResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.pending[user]; ok && now.Before(cur.expiresAt) {
		wait := cur.issuedAt.Add(s.cooldown).Sub(now)
		if wait > 0 {
			return IssueResult{RetryAfter: int((wait + time.Second - 1) / time.Second)}
		}
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(1_000_000))
	code := fmt.Sprintf("%06d", n.Int64())
	s.pending[user] = &pending{hash: sha256.Sum256([]byte(code)), issuedAt: now, expiresAt: now.Add(s.ttl), attemptsLeft: s.max}
	return IssueResult{OK: true, Code: code, ExpiresIn: s.ttlS}
}

func (s *CodeStore) Revoke(user string) { s.mu.Lock(); delete(s.pending, user); s.mu.Unlock() }

type VerifyResult struct {
	OK           bool
	Err          string
	AttemptsLeft int
}

func (s *CodeStore) Verify(user, code string, now time.Time) VerifyResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.pending[user]
	if !ok {
		return VerifyResult{Err: "no_code"}
	}
	if !now.Before(cur.expiresAt) {
		delete(s.pending, user)
		return VerifyResult{Err: "expired"}
	}
	h := sha256.Sum256([]byte(jsTrim(code)))
	if subtle.ConstantTimeCompare(cur.hash[:], h[:]) == 1 {
		delete(s.pending, user) // single use
		return VerifyResult{OK: true}
	}
	cur.attemptsLeft--
	if cur.attemptsLeft <= 0 {
		delete(s.pending, user)
		return VerifyResult{Err: "too_many_attempts"}
	}
	return VerifyResult{Err: "bad_code", AttemptsLeft: cur.attemptsLeft}
}

// MaskAddress: "me@diegonmarcos.com" -> "m•@diegonmarcos.com".
func MaskAddress(addr string) string {
	at := strings.LastIndex(addr, "@")
	if at < 1 {
		return "•"
	}
	r := []rune(addr)
	return string(r[0]) + "•" + addr[at:]
}

// CodeMail is the RFC 5322 message carrying the code. The code is the whole body.
func CodeMail(c ProfileCfg, code, user string, now time.Time) string {
	dom := "localhost"
	if parts := strings.SplitN(c.MailFrom, "@", 2); len(parts) == 2 {
		dom = parts[1]
	}
	mins := int(float64(c.CodeTTLS)/60 + 0.5)
	return strings.Join([]string{
		"From: Cloud SuperApp <" + c.MailFrom + ">",
		"To: <" + c.MailTo + ">",
		"Subject: SuperApp Connect code: " + code,
		"Date: " + now.UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT"),
		fmt.Sprintf("Message-ID: <profile-connect-%d@%s>", now.UnixMilli(), dom),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Your Cloud SuperApp Connect code is " + code + ".",
		"",
		fmt.Sprintf("It expires in %d minutes and works once.", mins),
		"Requested by bearer identity: " + user,
		"If you did not ask for it, someone holds a valid Authelia bearer — revoke it.",
		"",
	}, "\r\n")
}

// MissingParts names exactly the declared parts absent on this host. Empty = ready to serve.
func MissingParts(c ProfileCfg) []string {
	miss := []string{}
	if c.MailTo == "" {
		miss = append(miss, "mail_to")
	}
	exists := func(f string) bool {
		if c.BundleDir == "" {
			return false
		}
		_, err := os.Stat(filepath.Join(c.BundleDir, f))
		return err == nil
	}
	if !exists(c.BundleFile) {
		miss = append(miss, "bundle")
	}
	if !exists(c.SchemaFile) {
		miss = append(miss, "schema")
	}
	return miss
}

// BundleError: the mounted bundle is not the plaintext export the phone can read.
type BundleError struct{ Msg string }

func (e *BundleError) Error() string { return e.Msg }

// LoadBundle reads the bundle and its schema from the mount. A still sops-encrypted file is refused (#585/#589).
func LoadBundle(c ProfileCfg) (schema, bundle any, err error) {
	b, rerr := os.ReadFile(filepath.Join(c.BundleDir, c.BundleFile))
	if rerr != nil {
		return nil, nil, &BundleError{"bundle unreadable: " + jsErrText(rerr)}
	}
	bv, perr := ojson.Parse([]byte(ojson.ReplaceInvalidUTF8(b)))
	if perr != nil {
		return nil, nil, &BundleError{"bundle unreadable: " + perr.Error()}
	}
	root, ok := bv.(*ojson.Obj)
	if !ok {
		return nil, nil, &BundleError{"bundle is not a JSON object"}
	}
	if _, has := root.Get("sops"); has {
		return nil, nil, &BundleError{"bundle is sops-encrypted (sops root) — the vault emits plaintext since #589; re-sync the mount"}
	}
	if _, has := root.Get("schema_version"); !has {
		return nil, nil, &BundleError{"bundle has no schema_version"}
	}
	sb, rerr := os.ReadFile(filepath.Join(c.BundleDir, c.SchemaFile))
	if rerr != nil {
		return nil, nil, rerr
	}
	sv, perr := ojson.Parse([]byte(ojson.ReplaceInvalidUTF8(sb)))
	if perr != nil {
		return nil, nil, perr
	}
	return sv, bv, nil
}

func jsErrText(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return err.Error()
	}
	return err.Error()
}
