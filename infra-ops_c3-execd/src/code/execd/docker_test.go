package execd

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func fakeDocker(t *testing.T) (*Docker, *atomic.Int32, *[]string) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	var seen []string
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		w.Write([]byte(`[{"Names":["/caddy"]}]`))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return NewDocker(sock), &hits, &seen
}

func TestDockerAllowlist(t *testing.T) {
	d, hits, seen := fakeDocker(t)
	ctx := context.Background()
	allowed := []DockerRequest{
		{Method: "GET", Path: "/_ping"},
		{Method: "GET", Path: "/containers/json", Query: "all=true"},
		{Method: "GET", Path: "/v1.43/containers/json"},
		{Method: "GET", Path: "/containers/caddy/logs", Query: "stdout=1&tail=50"},
		{Method: "GET", Path: "/containers/my_ctr-1.x/json"},
		{Method: "POST", Path: "/containers/caddy/restart", Query: "t=10"},
		{Method: "POST", Path: "/containers/caddy/stop"},
		{Method: "POST", Path: "/containers/caddy/start"},
	}
	for _, r := range allowed {
		resp, err := d.Do(ctx, r)
		if err != nil || resp.Status != 200 {
			t.Errorf("%v: %v %+v", r, err, resp)
		}
	}
	if int(hits.Load()) != len(allowed) {
		t.Fatalf("hits %d", hits.Load())
	}
	if (*seen)[1] != "GET /containers/json?all=true" {
		t.Fatalf("query not forwarded: %v", *seen)
	}
	denied := []DockerRequest{
		{Method: "DELETE", Path: "/containers/caddy"},
		{Method: "POST", Path: "/containers/caddy/kill"},
		{Method: "POST", Path: "/containers/caddy/exec"},
		{Method: "POST", Path: "/containers/create"},
		{Method: "POST", Path: "/containers/prune"},
		{Method: "POST", Path: "/images/prune"},
		{Method: "GET", Path: "/containers/../info"},
		{Method: "GET", Path: "/containers/a%2Fb/json"},
		{Method: "GET", Path: "/containers/a b/json"},
		{Method: "GET", Path: "/containers//json"},
		{Method: "GET", Path: "/containers/caddy/archive"},
		{Method: "POST", Path: "/containers/caddy/restart?x=1"},
		{Method: "POST", Path: "/_ping"},
		{Method: "get", Path: "/_ping"},
		{Method: "POST", Path: "/containers/-bad/start"},
	}
	before := hits.Load()
	for _, r := range denied {
		if _, err := d.Do(ctx, r); err == nil {
			t.Errorf("%v must be denied", r)
		}
	}
	if hits.Load() != before {
		t.Fatal("a denied call reached the docker socket")
	}
}

// Mutation proof: with the rule table's anchoring removed the denied set would pass.
func TestDockerRuleMutantCaught(t *testing.T) {
	loose := dockerRule{"POST", mustRe(`containers/.*/(start|stop|restart)`)}
	if !loose.path.MatchString("/containers/a/../../x/start") {
		t.Fatal("mutant should accept traversal, proving the anchored table is what blocks it")
	}
	if CheckDocker("POST", "/containers/a/../../x/start") == nil {
		t.Fatal("real table accepted traversal")
	}
}
