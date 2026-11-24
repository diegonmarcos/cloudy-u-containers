// Package fakeup is the fake GitHub + Authelia + object store the git-proxy tests (unit and parity) run against.
// It mirrors the stub of the Node tester (test-contract-and-authz.mjs) route for route, so the Node service and the Go
// port can be driven against two identical instances and their upstream-visible behaviour compared. Test-only:
// nothing in the shipped binary imports it.
package fakeup

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	KID        = "test-kid"
	Owner      = "me@diegonmarcos.com"
	Issuer     = "https://auth.diegonmarcos.com"
	FakeToken  = "ghp_FAKEFAKEFAKEFAKEFAKE1234567890abcd"
	AssetBytes = 1000
)

// Fake is one upstream instance.
type Fake struct {
	Key      *rsa.PrivateKey
	Impostor *rsa.PrivateKey
	Srv      *httptest.Server
	CDN      *httptest.Server

	mu       sync.Mutex
	Hits     map[string]int
	Session  []string
	Git      []string
	GitBody  []string
	Assets   []string
	CDNHits  []string
	assetBuf []byte
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func jwk(k *rsa.PublicKey, kid string) map[string]string {
	e := []byte{byte(k.E >> 16), byte(k.E >> 8), byte(k.E)}
	for len(e) > 1 && e[0] == 0 {
		e = e[1:]
	}
	return map[string]string{"kty": "RSA", "kid": kid, "n": b64(k.N.Bytes()), "e": b64(e), "alg": "RS256", "use": "sig"}
}

// Mint signs claims (RS256, kid KID) with key; alg "none" yields an unsigned token.
func Mint(key *rsa.PrivateKey, alg string, claims map[string]any) string {
	hb, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT", "kid": KID})
	pb, _ := json.Marshal(claims)
	h, p := b64(hb), b64(pb)
	if alg == "none" || key == nil {
		return h + "." + p + "."
	}
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	return h + "." + p + "." + b64(sig)
}

// Tamper keeps the signature of tok but swaps the payload.
func Tamper(tok string, claims map[string]any) string {
	parts := strings.Split(tok, ".")
	pb, _ := json.Marshal(claims)
	return parts[0] + "." + b64(pb) + "." + parts[2]
}

var assetRe = regexp.MustCompile(`^/repos/diegonmarcos/cloudy-u-android/releases/assets/(\d+)$`)
var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

func New(key, impostor *rsa.PrivateKey) *Fake {
	f := &Fake{Key: key, Impostor: impostor, Hits: map[string]int{}}
	f.assetBuf = make([]byte, AssetBytes)
	for i := range f.assetBuf {
		f.assetBuf[i] = byte(i % 251)
	}
	sidecars := map[string]string{"12": strings.Repeat("a", 64) + "  App.apk\n", "13": "sha=deadbeef run=1\n"}

	f.CDN = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		f.mu.Lock()
		f.CDNHits = append(f.CDNHits, fmt.Sprintf("%s|%s|%s", id, r.Header.Get("Authorization"), r.Header.Get("Range")))
		f.mu.Unlock()
		if id != "11" {
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, sidecars[id])
			return
		}
		m := rangeRe.FindStringSubmatch(r.Header.Get("Range"))
		n := len(f.assetBuf)
		if m == nil {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", strconv.Itoa(n))
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Etag", `"e1"`)
			w.Write(f.assetBuf)
			return
		}
		num := func(s string) int { v, _ := strconv.Atoi(s); return v }
		var start, end int
		if m[1] == "" {
			start = n - num(m[2])
		} else {
			start = num(m[1])
		}
		if m[1] == "" || m[2] == "" {
			end = n - 1
		} else {
			end = num(m[2])
			if end > n-1 {
				end = n - 1
			}
		}
		if start >= n {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", n))
			w.WriteHeader(416)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, n))
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Etag", `"e1"`)
		w.WriteHeader(206)
		w.Write(f.assetBuf[start : end+1])
	}))
	cdnBase := strings.Replace(f.CDN.URL, "127.0.0.1", "localhost", 1)

	f.Srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bare := r.URL.Path
		f.mu.Lock()
		f.Hits[bare]++
		f.mu.Unlock()
		js := func(v any) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(v)
		}
		switch {
		case bare == "/repos/diegonmarcos/cloudy-t-infra/commits":
			var l []any
			for i := 0; i < 7; i++ {
				l = append(l, map[string]any{
					"sha": fmt.Sprintf("sha%d", i), "html_url": fmt.Sprintf("https://github.com/c/%d", i),
					"commit":   map[string]any{"message": fmt.Sprintf("msg %d", i), "author": map[string]any{"name": "diego", "date": "2026-09-29T00:00:00Z"}},
					"smuggled": FakeToken,
				})
			}
			js(l)
		case bare == "/repos/diegonmarcos/cloudy-t-infra/actions/runs":
			time.Sleep(150 * time.Millisecond) // slow on purpose so concurrent callers overlap the miss
			js(map[string]any{"total_count": 1, "workflow_runs": []any{map[string]any{
				"name": "ship", "display_title": "t", "status": "completed", "conclusion": "success",
				"created_at": "2026-09-29T00:00:00Z", "html_url": "https://github.com/r/1",
				"path": ".github/workflows/ship.yml", "smuggled": FakeToken}}})
		case bare == "/repos/diegonmarcos/cloudy-u-android/releases/tags/latest":
			js(map[string]any{"tag_name": "latest", "assets": []any{
				map[string]any{"id": 11, "name": "App.apk", "size": AssetBytes},
				map[string]any{"id": 12, "name": "App.apk.sha256", "size": 80},
				map[string]any{"id": 13, "name": "App.apk.source", "size": 40},
				map[string]any{"id": 14, "name": "Gone.apk", "size": 1}}})
		case assetRe.MatchString(bare):
			id := assetRe.FindStringSubmatch(bare)[1]
			f.mu.Lock()
			f.Assets = append(f.Assets, fmt.Sprintf("%s|%s|%s", id, r.Header.Get("Accept"), r.Header.Get("Range")))
			f.mu.Unlock()
			if id == "14" {
				w.WriteHeader(404)
				io.WriteString(w, "{}")
				return
			}
			http.Redirect(w, r, cdnBase+"/blob/"+id, 302)
		case bare == "/repos/diegonmarcos/cloudy-u-android/releases/tags/nope":
			w.WriteHeader(404)
			io.WriteString(w, "{}")
		case bare == "/repos/diegonmarcos/cloudy-u-linux/commits":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(500)
			io.WriteString(w, "upstream exploded with "+r.Header.Get("Authorization"))
		case bare == "/repos/diegonmarcos/front-data/runs" || bare == "/repos/diegonmarcos/front-data/actions/runs":
			w.WriteHeader(404)
			io.WriteString(w, "{}")
		case bare == "/api/authz/auth-request":
			f.mu.Lock()
			f.Session = append(f.Session, r.Header.Get("X-Original-Url")+"|"+r.Header.Get("X-Original-Method"))
			f.mu.Unlock()
			switch r.Header.Get("Cookie") {
			case "authelia_session=owner":
				w.Header().Set("Remote-User", Owner)
				w.WriteHeader(200)
			case "authelia_session=guest":
				w.Header().Set("Remote-User", "guest@example.invalid")
				w.WriteHeader(200)
			default:
				w.WriteHeader(401)
				io.WriteString(w, "Unauthorized")
			}
		case strings.HasPrefix(bare, "/diegonmarcos/cloudy-t-infra.git/"):
			f.mu.Lock()
			f.Git = append(f.Git, fmt.Sprintf("%s|%s|%s|%s", r.URL.RequestURI(), r.Method, r.Header.Get("Authorization"), r.Header.Get("Cookie")))
			f.mu.Unlock()
			if strings.HasSuffix(bare, "/info/refs") {
				w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
				io.WriteString(w, "001e# service=git-upload-pack\n0000advert-sentinel")
				return
			}
			b, _ := io.ReadAll(r.Body)
			f.mu.Lock()
			f.GitBody = append(f.GitBody, string(b))
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			io.WriteString(w, "PACK-for:"+string(b))
		case bare == "/jwks.json":
			js(map[string]any{"keys": []any{
				func() map[string]string { m := jwk(&f.Impostor.PublicKey, "some-other-kid"); return m }(),
				jwk(&f.Key.PublicKey, KID)}})
		case strings.HasPrefix(r.URL.RequestURI(), "/user/repos"):
			js([]any{map[string]any{
				"full_name": "diegonmarcos/cloudy-t-infra", "owner": map[string]any{"login": "diegonmarcos"},
				"name": "cloudy-t-infra", "private": true, "default_branch": "main",
				"updated_at": "2026-09-29T00:00:00Z", "size": 42, "smuggled": FakeToken}})
		case strings.Contains(r.URL.RequestURI(), "/tarball"):
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(500)
			io.WriteString(w, "upstream exploded with "+r.Header.Get("Authorization"))
		default:
			w.WriteHeader(404)
			io.WriteString(w, "{}")
		}
	}))
	return f
}

func (f *Fake) URL() string { return f.Srv.URL }

func (f *Fake) Close() { f.Srv.Close(); f.CDN.Close() }

// Snapshot is the upstream-visible record of everything the service did, in a comparable (order-insensitive) form.
func (f *Fake) Snapshot() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	srt := func(in []string) []string { o := append([]string{}, in...); sort.Strings(o); return o }
	return map[string]any{
		"hits": f.Hits, "session": srt(f.Session), "git": srt(f.Git), "gitBodies": srt(f.GitBody),
		"assets": srt(f.Assets), "cdn": srt(f.CDNHits),
	}
}

// Env is the environment that points a service at this fake.
func (f *Fake) Env() map[string]string {
	return map[string]string{
		"GITHUB_TOKEN": FakeToken, "GITHUB_API_BASE": f.URL(), "GITHUB_GIT_BASE": f.URL(),
		"AUTHELIA_VERIFY_URL": f.URL() + "/api/authz/auth-request", "JWKS_URL": f.URL() + "/jwks.json",
		"ISSUER": Issuer, "UPSTREAM_TIMEOUT_MS": "5000",
	}
}
