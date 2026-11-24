package execd

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ResolveToken decides the shared secret callers must send in X-Execd-Token.
//
//   - EXECD_TOKEN set: use it.
//   - else EXECD_TOKEN_FILE set: reuse the file's content if present, otherwise generate 32 random
//     bytes (hex), write the file 0600 (directory 0700) and use that. The caller reads the same
//     file through a read-only bind mount of the directory, so no secret is ever declared in
//     git or passed as an argument, and a host-network neighbour that cannot read the directory
//     cannot call the sidecar.
//   - neither: refuse. The sidecar can run `sh`; "no auth on loopback" is not acceptable.
func ResolveToken(env func(string) string, readFile func(string) ([]byte, error), writeFile func(string, []byte, os.FileMode) error, mkdir func(string, os.FileMode) error, random func([]byte) (int, error)) (string, error) {
	if t := strings.TrimSpace(env("EXECD_TOKEN")); t != "" {
		return t, nil
	}
	f := env("EXECD_TOKEN_FILE")
	if f == "" {
		return "", errors.New("neither EXECD_TOKEN nor EXECD_TOKEN_FILE is set: refusing to serve unauthenticated exec")
	}
	if b, err := readFile(f); err == nil {
		if t := strings.TrimSpace(string(b)); len(t) >= 32 {
			return t, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := random(buf); err != nil {
		return "", err
	}
	t := hex.EncodeToString(buf)
	if err := mkdir(filepath.Dir(f), 0o700); err != nil {
		return "", err
	}
	if err := writeFile(f, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}

// DefaultToken wires ResolveToken to the real environment and filesystem.
func DefaultToken() (string, error) {
	return ResolveToken(os.Getenv, os.ReadFile, os.WriteFile, os.MkdirAll, rand.Read)
}
