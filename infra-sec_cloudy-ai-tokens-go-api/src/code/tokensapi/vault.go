package tokensapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"tokens-api/fleetauth"
)

// Vault encrypts token values (AES-256-GCM, the token id as associated data) and derives their lookup index
// (HMAC-SHA256) from one fleet key. Same derivation, same bytes on disk as the Python service.
type Vault struct{ enc, idx []byte }

func derive(raw []byte, label string) []byte {
	m := hmac.New(sha256.New, raw)
	m.Write([]byte(label))
	return m.Sum(nil)
}

// NewVault parses TOKENS_FLEET_KEY: urlsafe base64 (Python's lenient decoder), at least 32 bytes.
func NewVault(fleetKeyB64 string) (*Vault, error) {
	k := fleetauth.PyStrip(fleetKeyB64)
	k += strings.Repeat("=", (4-fleetauth.CPLen(k)%4)%4)
	raw, err := fleetauth.B64URLDecode([]byte(k))
	if err != nil {
		return nil, errors.New("TOKENS_FLEET_KEY is not base64")
	}
	if len(raw) < 32 {
		return nil, errors.New("TOKENS_FLEET_KEY must decode to at least 32 bytes")
	}
	return &Vault{enc: derive(raw, "tokens-api/enc/v1"), idx: derive(raw, "tokens-api/idx/v1")}, nil
}

func mustEncode(s string) []byte {
	if fleetauth.HasSurrogate(s) {
		panic("UnicodeEncodeError: surrogates not allowed")
	}
	return []byte(s)
}

// Index is the HMAC lookup key of a token value.
func (v *Vault) Index(value string) string {
	m := hmac.New(sha256.New, v.idx)
	m.Write(mustEncode(value))
	return hex.EncodeToString(m.Sum(nil))
}

func (v *Vault) gcm() cipher.AEAD {
	b, err := aes.NewCipher(v.enc)
	if err != nil {
		panic(err)
	}
	g, err := cipher.NewGCM(b)
	if err != nil {
		panic(err)
	}
	return g
}

// Seal returns a fresh random nonce and the ciphertext (with the GCM tag appended, like cryptography's AESGCM).
func (v *Vault) Seal(tokenID, value string) (nonce, ct []byte) {
	nonce = make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return nonce, v.gcm().Seal(nil, nonce, mustEncode(value), mustEncode(tokenID))
}

// SealWith is Seal with a caller-chosen nonce (test vectors).
func (v *Vault) SealWith(nonce []byte, tokenID, value string) []byte {
	return v.gcm().Seal(nil, nonce, mustEncode(value), mustEncode(tokenID))
}

// Open decrypts a stored value; any failure (wrong key, wrong id, tampered ciphertext) is an error.
func (v *Vault) Open(tokenID string, nonce, ct []byte) (string, error) {
	if len(nonce) != 12 {
		return "", errors.New("bad nonce")
	}
	pt, err := v.gcm().Open(nil, nonce, ct, mustEncode(tokenID))
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
