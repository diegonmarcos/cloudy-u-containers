package gitproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Release metadata (asset name -> id) is cached like the feeds, keyed by (repo, tag); the asset BYTES are
// never cached or staged: they stream.
func (s *Server) cachedRelease(owner, repo, tag string) (map[string]assetMeta, error) {
	key := strings.ToLower(owner+"/"+repo) + "@" + tag
	ttl := time.Duration(s.rt.Feeds.CacheTTLS * float64(time.Second))
	s.relMu.Lock()
	if e, ok := s.releases[key]; ok && time.Since(e.at) < ttl {
		s.relMu.Unlock()
		<-e.ready
		return e.assets, e.err
	}
	e := &relEntry{at: time.Now(), ready: make(chan struct{})}
	s.releases[key] = e
	s.relMu.Unlock()
	go func() {
		defer close(e.ready)
		e.assets, e.err = s.fetchRelease(context.Background(), owner, repo, tag)
		if e.err != nil {
			s.relMu.Lock()
			if s.releases[key] == e {
				delete(s.releases, key)
			}
			s.relMu.Unlock()
		}
	}()
	<-e.ready
	return e.assets, e.err
}

func (s *Server) fetchRelease(ctx context.Context, owner, repo, tag string) (map[string]assetMeta, error) {
	res, cancel, err := s.ghFetch(ctx, ReleaseByTagURL(s.cfg.APIBase, owner, repo, tag), "")
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &upstreamError{status: res.StatusCode, msg: fmt.Sprintf("GitHub returned %d for release %s", res.StatusCode, tag)}
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Assets []struct {
			ID   json.RawMessage `json:"id"`
			Name *string         `json:"name"`
		} `json:"assets"`
	}
	assets := map[string]assetMeta{}
	if json.Unmarshal(body, &doc) != nil {
		return assets, nil
	}
	for _, a := range doc.Assets {
		if a.Name != nil && len(a.ID) > 0 && string(a.ID) != "null" {
			id := strings.Trim(string(a.ID), `"`)
			assets[*a.Name] = assetMeta{ID: id}
		}
	}
	return assets, nil
}

func (s *Server) releaseAsset(w http.ResponseWriter, r *http.Request, c *reqCtx) {
	owner, repo, tag, name := c.params["owner"], c.params["repo"], c.params["tag"], c.params["name"]
	if !ValidName(owner) || !ValidName(repo) {
		s.sendError(w, 400, "bad_repo", "owner and repo must be valid GitHub names")
		return
	}
	if !ValidTag(tag) {
		s.sendError(w, 400, "bad_tag", "tag is not a valid release tag")
		return
	}
	if !ValidName(name) {
		s.sendError(w, 400, "bad_asset", "asset name is not valid")
		return
	}
	if !RepoDeclared(s.rt.Feeds.Repos, owner, repo) {
		s.sendError(w, 403, "repo_not_declared", fmt.Sprintf("%s/%s is not in runtime.feeds.repos", owner, repo))
		return
	}
	rng := r.Header.Get("Range")
	if _, has := r.Header["Range"]; has && !ValidRange(rng) {
		s.sendError(w, 400, "bad_range", "only a single bytes=a-b range is supported")
		return
	}

	// One retry with fresh metadata: `latest` is re-published on every ship, so a cached asset id can go stale.
	var res *http.Response
	var cancel context.CancelFunc
	for attempt := 0; attempt < 2; attempt++ {
		assets, err := s.cachedRelease(owner, repo, tag)
		if err != nil {
			s.releaseFail(w, err)
			return
		}
		asset, found := assets[name]
		if !found {
			if attempt == 0 {
				s.dropRelease(owner, repo, tag)
				continue
			}
			s.sendError(w, 404, "not_found", fmt.Sprintf("%s is not an asset of %s/%s@%s", name, owner, repo, tag))
			return
		}
		if s.cfg.GitHubToken == "" {
			s.fail(w, &upstreamError{status: 503, msg: "no GITHUB_TOKEN configured (shadow stage)"})
			return
		}
		ctx, cn := context.WithCancel(r.Context())
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ReleaseAssetURL(s.cfg.APIBase, owner, repo, asset.ID), nil)
		if err != nil {
			cn()
			s.fail(w, err)
			return
		}
		req.Header = UpstreamHeaders(s.cfg.GitHubToken)
		req.Header.Set("Accept", "application/octet-stream")
		if rng != "" {
			req.Header.Set("Range", strings.TrimSpace(rng))
		}
		// The deadline covers GitHub's HEADERS only; a 400 MB APK streams for minutes. The Go client drops
		// Authorization on the cross-origin redirect to GitHub's object store, so the credential never reaches the CDN.
		res, cancel, err = s.doHeadersDeadline(ctx, cn, req)
		if err != nil {
			s.fail(w, err)
			return
		}
		if res.StatusCode == 404 && attempt == 0 {
			res.Body.Close()
			cancel()
			s.dropRelease(owner, repo, tag)
			continue
		}
		break
	}
	defer cancel()
	defer res.Body.Close()

	if res.StatusCode == 416 {
		if cr := res.Header.Get("Content-Range"); cr != "" {
			w.Header().Set("Content-Range", cr)
		}
		s.sendError(w, 416, "range_not_satisfiable", fmt.Sprintf("range %s is outside %s", rng, name))
		return
	}
	if res.StatusCode != 200 && res.StatusCode != 206 {
		st, code := notFoundOr502(res.StatusCode)
		s.sendError(w, st, code, fmt.Sprintf("GitHub returned %d for %s", res.StatusCode, name))
		return
	}
	h := w.Header()
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	h.Set("Cache-Control", "no-store")
	for _, k := range AssetPassHeaders {
		if v := res.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	if h.Get("Accept-Ranges") == "" {
		h.Set("Accept-Ranges", "bytes")
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

func (s *Server) dropRelease(owner, repo, tag string) {
	s.relMu.Lock()
	delete(s.releases, strings.ToLower(owner+"/"+repo)+"@"+tag)
	s.relMu.Unlock()
}

func (s *Server) releaseFail(w http.ResponseWriter, err error) {
	if ue, ok := err.(*upstreamError); ok && !(ue.status == 503 && s.cfg.GitHubToken == "") {
		st, code := notFoundOr502(ue.status)
		s.sendError(w, st, code, ue.msg)
		return
	}
	s.fail(w, err)
}
