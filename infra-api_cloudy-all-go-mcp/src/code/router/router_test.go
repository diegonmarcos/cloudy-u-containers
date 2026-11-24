package router

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Port of mcp/router.test.ts (infra-api_cloudy-all-mcp): every case of the TypeScript suite.

func entries() []ServerEntry {
	return []ServerEntry{
		{Name: "cloudy-c3-mcp", Aliases: []string{"cloud-infra-mcp"}, Description: "c3", URLs: []string{"http://c3/mcp"}},
		{Name: "cloudy-apps-communication-mcp", Aliases: []string{"cloud-mail-mcp", "cloud-mattermost-mcp"}, Description: "comm", URLs: []string{"http://comm/mcp"}},
		{Name: "cloudy-all-mcp", Description: "self", URLs: []string{"http://self/mcp"}},
	}
}

type call struct {
	s, t string
	a    map[string]any
}

type fakeBackend struct {
	tools map[string][]string
	calls []call
	lists int
}

func (f *fakeBackend) ListTools(_ context.Context, e ServerEntry) ([]ToolInfo, error) {
	f.lists++
	names, ok := f.tools[e.Name]
	if !ok {
		return nil, errors.New("connection refused")
	}
	out := []ToolInfo{}
	for _, n := range names {
		out = append(out, ToolInfo{Name: n, Description: "d " + n})
	}
	return out, nil
}

func (f *fakeBackend) CallTool(_ context.Context, e ServerEntry, t string, a map[string]any) (any, error) {
	f.calls = append(f.calls, call{e.Name, t, a})
	return e.Name + ":" + t, nil
}

func mk(t *testing.T, f *fakeBackend, opts Options) *Router {
	t.Helper()
	r, err := New(entries(), f, opts)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func isFail(v any) *Failure { f, _ := v.(*Failure); return f }

var ctx = context.Background()

func TestListServersNamesEveryServerOnceSortedWithoutURLsAndHidesItself(t *testing.T) {
	r := mk(t, &fakeBackend{}, Options{SelfName: "cloudy-all-mcp"})
	l := r.ListServers()
	if len(l) != 2 || l[0].Name != "cloudy-apps-communication-mcp" || l[1].Name != "cloudy-c3-mcp" {
		t.Fatalf("got %+v", l)
	}
	if !reflect.DeepEqual(l[1].Aliases, []string{"cloud-infra-mcp"}) {
		t.Fatalf("aliases %v", l[1].Aliases)
	}
	if strings.Contains(JSON(l), "http://") {
		t.Fatal("urls leaked into list_servers")
	}
	plain, err := New([]ServerEntry{{Name: "plain-mcp", Description: "p", URLs: []string{"http://p/mcp"}}}, &fakeBackend{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(JSON(plain.ListServers()), `"aliases": []`) {
		t.Fatalf("empty aliases must render as []: %s", JSON(plain.ListServers()))
	}
}

func TestOldNamesResolveAsAliasesCaseInsensitive(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-apps-communication-mcp": {"mail", "mattermost"}}}
	r := mk(t, f, Options{})
	for _, n := range []string{"cloud-mail-mcp", "cloud-mattermost-mcp", "CLOUDY-apps-communication-mcp", "  cloud-mail-mcp "} {
		out, ok := r.ListTools(ctx, n).(*ToolList)
		if !ok || out.Server != "cloudy-apps-communication-mcp" {
			t.Fatalf("%q -> %#v", n, out)
		}
	}
}

func TestUnknownServerListsTheKnownNames(t *testing.T) {
	r := mk(t, &fakeBackend{}, Options{SelfName: "cloudy-all-mcp"})
	f := isFail(r.Call(ctx, "nope", "x", nil))
	if f == nil || !strings.HasPrefix(f.Text, "unknown server 'nope'. Known: ") || !strings.Contains(f.Text, "cloudy-c3-mcp") {
		t.Fatalf("got %+v", f)
	}
	if isFail(r.Call(ctx, nil, "x", nil)) == nil {
		t.Fatal("missing server must fail")
	}
}

func TestTheRouterNeverRoutesToItself(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-all-mcp": {"call"}}}
	r := mk(t, f, Options{SelfName: "cloudy-all-mcp"})
	if isFail(r.Call(ctx, "cloudy-all-mcp", "call", map[string]any{})) == nil || len(f.calls) != 0 {
		t.Fatal("self was routed to")
	}
}

func TestCallForwardsToolAndArgsToTheRightBackendAndReturnsItsResult(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-c3-mcp": {"devops_ssh_exec"}}}
	r := mk(t, f, Options{})
	out := r.Call(ctx, "cloud-infra-mcp", "devops_ssh_exec", map[string]any{"host": "a"})
	if out != "cloudy-c3-mcp:devops_ssh_exec" {
		t.Fatalf("got %#v", out)
	}
	if !reflect.DeepEqual(f.calls, []call{{"cloudy-c3-mcp", "devops_ssh_exec", map[string]any{"host": "a"}}}) {
		t.Fatalf("calls %+v", f.calls)
	}
}

func TestMissingArgsDefaultToEmptyAndNonObjectArgsAreRejectedBeforeAnyBackendCall(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-c3-mcp": {"t"}}}
	r := mk(t, f, Options{})
	r.Call(ctx, "cloudy-c3-mcp", "t", nil)
	if len(f.calls) != 1 || f.calls[0].a == nil || len(f.calls[0].a) != 0 {
		t.Fatalf("calls %+v", f.calls)
	}
	for _, bad := range []any{JSONNull{}, []any{}, "x", 3.0} {
		if isFail(r.Call(ctx, "cloudy-c3-mcp", "t", bad)) == nil {
			t.Fatalf("%#v accepted", bad)
		}
	}
	if len(f.calls) != 1 {
		t.Fatal("a bad args call reached the backend")
	}
}

func TestUnknownToolIsRefusedWithNearMatchesAndNeverReachesCallTool(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-c3-mcp": {"devops_ssh_exec", "devops_ssh_keys", "other"}}}
	r := mk(t, f, Options{})
	fl := isFail(r.Call(ctx, "cloudy-c3-mcp", "devops_ssh", map[string]any{}))
	want := "cloudy-c3-mcp has no tool 'devops_ssh'. Similar: devops_ssh_exec, devops_ssh_keys. Use list_tools."
	if fl == nil || fl.Text != want || len(f.calls) != 0 {
		t.Fatalf("got %+v", fl)
	}
	if isFail(r.Call(ctx, "cloudy-c3-mcp", "", map[string]any{})) == nil {
		t.Fatal("empty tool accepted")
	}
}

func TestToolListsAreCachedForTheTTLAndRefreshedAfterIt(t *testing.T) {
	now := time.Unix(0, 0)
	f := &fakeBackend{tools: map[string][]string{"cloudy-c3-mcp": {"a"}}}
	r := mk(t, f, Options{TTL: time.Second, Now: func() time.Time { return now }})
	r.ListTools(ctx, "cloudy-c3-mcp")
	r.ListTools(ctx, "cloudy-c3-mcp")
	if f.lists != 1 {
		t.Fatalf("lists %d", f.lists)
	}
	now = now.Add(1001 * time.Millisecond)
	r.ListTools(ctx, "cloudy-c3-mcp")
	if f.lists != 2 {
		t.Fatalf("lists %d", f.lists)
	}
}

func TestAStaleCacheIsRefreshedOnceWhenAToolIsMissing(t *testing.T) {
	f := &fakeBackend{tools: map[string][]string{"cloudy-c3-mcp": {"a"}}}
	r := mk(t, f, Options{TTL: 60 * time.Second})
	r.ListTools(ctx, "cloudy-c3-mcp")
	f.tools["cloudy-c3-mcp"] = append(f.tools["cloudy-c3-mcp"], "b") // server gained a tool
	if out := r.Call(ctx, "cloudy-c3-mcp", "b", nil); isFail(out) != nil {
		t.Fatalf("got %+v", out)
	}
	if f.lists != 2 {
		t.Fatalf("lists %d", f.lists)
	}
}

func TestBackendFailuresBecomeFailureResultsNotPanics(t *testing.T) {
	r := mk(t, &fakeBackend{}, Options{})
	lt := isFail(r.ListTools(ctx, "cloudy-c3-mcp"))
	if lt == nil || !strings.Contains(lt.Text, "connection refused") || !strings.Contains(lt.Text, "list_tools failed") {
		t.Fatalf("got %+v", lt)
	}
	if isFail(r.Call(ctx, "cloudy-c3-mcp", "t", map[string]any{})) == nil {
		t.Fatal("call must fail")
	}
}

func TestDuplicateClaimsOnOneNameAreRejectedAtConstruction(t *testing.T) {
	_, err := New([]ServerEntry{
		{Name: "a", Aliases: []string{"x"}},
		{Name: "b", Aliases: []string{"X"}},
	}, &fakeBackend{}, Options{})
	if err == nil || !strings.Contains(err.Error(), "claimed by both") {
		t.Fatalf("err %v", err)
	}
}

func TestDefaultCatalogFinalLayoutAndOldNamesCovered(t *testing.T) {
	cat := DefaultCatalog()
	names := map[string]bool{}
	for _, e := range cat {
		names[e.Name] = true
		if len(e.URLs) == 0 {
			t.Fatalf("%s has no urls", e.Name)
		}
	}
	for _, n := range []string{"cloudy-c3-mcp", "cloudy-android-mcp", "cloudy-apps-communication-mcp", "cloudy-apps-drive-mcp", "cloudy-cgc-pub-mcp", "cloud-me-cgc-pvt-mcp", "google-workspace-mcp", "google-personal-mcp"} {
		if !names[n] {
			t.Fatalf("missing %s", n)
		}
	}
	if names[Self] {
		t.Fatal("self is in its own catalog")
	}
	r, err := New(cat, &fakeBackend{}, Options{SelfName: Self})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range []string{"cloud-infra-mcp", "cloud-superapp-mcp", "cloud-mail-mcp", "cloud-mattermost-mcp", "cloud-vault-mcp", "cloud-drive-mcp", "cloud-cgc-pub-mcp", "cloud-cgc-pvt-mcp", "cloud-services-mcp"} {
		if _, f := r.Resolve(o); f != nil {
			t.Fatalf("alias %s: %s", o, f.Text)
		}
	}
}

func TestRouterServersOverridesTheCatalogAndIsValidated(t *testing.T) {
	envOf := func(v string) func(string) string { return func(string) string { return v } }
	c, err := LoadCatalog(envOf(""))
	if err != nil || !reflect.DeepEqual(c, DefaultCatalog()) {
		t.Fatal("default catalog expected")
	}
	c, err = LoadCatalog(envOf(`[{"name":"x","description":"","urls":["http://x/mcp"]}]`))
	if err != nil || c[0].Name != "x" {
		t.Fatalf("got %v %v", c, err)
	}
	if _, err = LoadCatalog(envOf(`[{"name":"x"}]`)); err == nil || !strings.Contains(err.Error(), "ROUTER_SERVERS") {
		t.Fatalf("err %v", err)
	}
}
