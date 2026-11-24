package gdelt

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseFloatJS(t *testing.T) {
	for in, want := range map[string]float64{"1.5": 1.5, "  -2.25abc": -2.25, "3": 3, ".5": 0.5, "5.": 5, "1e3": 1000, "1e": 1, "-0.5e-1x": -0.05, "12 34": 12} {
		got, ok := ParseFloatJS(in)
		if !ok || got != want {
			t.Errorf("ParseFloatJS(%q) = %v,%v want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "abc", "-", ".", "e5", "+"} {
		if _, ok := ParseFloatJS(in); ok {
			t.Errorf("ParseFloatJS(%q) must be NaN", in)
		}
	}
}

func TestParseIntJS(t *testing.T) {
	for in, want := range map[string]int{"12": 12, "12abc": 12, " -5": -5, "+7": 7, "0": 0, "3.9": 3} {
		got, ok := ParseIntJS(in)
		if !ok || got != want {
			t.Errorf("ParseIntJS(%q) = %v,%v want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "abc", "-", "x1"} {
		if _, ok := ParseIntJS(in); ok {
			t.Errorf("ParseIntJS(%q) must be NaN", in)
		}
	}
}

func TestJSRoundHalvesGoUp(t *testing.T) {
	for in, want := range map[float64]float64{2.5: 3, -2.5: -2, 1.4: 1, -1.6: -2, 0: 0} {
		if got := JSRound(in); got != want {
			t.Errorf("JSRound(%v) = %v want %v", in, got, want)
		}
	}
}

type upstream struct {
	hits    atomic.Int64
	failAll atomic.Bool
	failTL  atomic.Bool
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.hits.Add(1)
	q := r.URL.Query()
	if u.failAll.Load() || (u.failTL.Load() && q.Get("mode") == "timelinevol") {
		http.Error(w, "nope", 500)
		return
	}
	switch q.Get("mode") {
	case "artlist":
		io.WriteString(w, `{"articles":[{"url":"u1","title":"<b>T&1</b>","tone":"-2.5","domain":"d"},{"url":"u2","tone":4},{"title":"no tone"}]}`)
	case "timelinevol":
		io.WriteString(w, `{"timeline":[{"data":[{"date":"d1","value":12.5},{"date":"d2","value":"3"},{"date":"d3"}]}]}`)
	case "tonechart":
		io.WriteString(w, `{"tonechart":[{"url":"x","title":"y","tone":"1.5","domain":"z"}]}`)
	}
}

func newStore(t *testing.T, base string) *Store {
	s, err := Open(Config{CacheDir: t.TempDir(), Base: base, FetchInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func get(t *testing.T, h http.Handler, method, target string) (int, http.Header, string) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec.Code, rec.Header(), rec.Body.String()
}

func TestFetchTopicCoercesAndCaches(t *testing.T) {
	up := &upstream{}
	ts := httptest.NewServer(up)
	defer ts.Close()
	s := newStore(t, ts.URL)
	if err := s.fetchTopic(context.Background(), "economy"); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(s.Articles("economy", 10))
	want := `[{"url":"u1","title":"<b>T&amp;1</b>"`
	_ = want
	if !strings.Contains(string(b), `"tone":-2.5`) || !strings.Contains(string(b), `"url":""`) {
		t.Fatalf("articles %s", b)
	}
	if got := len(s.Articles("economy", 2)); got != 2 {
		t.Fatalf("limit not applied: %d", got)
	}
	tl, _ := json.Marshal(s.Timeline("economy"))
	if string(tl) != `[{"date":"d1","value":12.5},{"date":"d2","value":3},{"date":"d3","value":0}]` {
		t.Fatalf("timeline %s", tl)
	}
	tn, _ := json.Marshal(s.Tone("economy"))
	if string(tn) != `[{"url":"x","title":"y","tone":1.5,"domain":"z"}]` {
		t.Fatalf("tone %s", tn)
	}
	if n, total, last := s.Health(); n != 1 || total != 3 || last == nil {
		t.Fatalf("health %d %d %v", n, total, last)
	}
}

func TestAllThreeFailuresPreserveThePriorCache(t *testing.T) {
	up := &upstream{}
	ts := httptest.NewServer(up)
	defer ts.Close()
	s := newStore(t, ts.URL)
	_ = s.fetchTopic(context.Background(), "economy")
	up.failAll.Store(true)
	if err := s.fetchTopic(context.Background(), "economy"); err != nil {
		t.Fatal(err)
	}
	if len(s.Articles("economy", 10)) != 3 {
		t.Fatal("cache was wiped by a total upstream failure")
	}
}

func TestAPartialFailureStoresTheRest(t *testing.T) {
	up := &upstream{}
	up.failTL.Store(true)
	ts := httptest.NewServer(up)
	defer ts.Close()
	s := newStore(t, ts.URL)
	_ = s.fetchTopic(context.Background(), "economy")
	if len(s.Articles("economy", 10)) != 3 || len(s.Timeline("economy")) != 0 || len(s.Tone("economy")) != 1 {
		t.Fatal("partial failure must keep the calls that worked")
	}
}

func TestUpstreamURLShape(t *testing.T) {
	s := &Store{cfg: Config{Base: "http://x/doc"}}
	if got := s.buildURL("climate change", "artlist"); got != "http://x/doc?query=climate+change&mode=artlist&maxrecords=250&format=json" {
		t.Fatal(got)
	}
}

func TestHTTPSurface(t *testing.T) {
	up := &upstream{}
	ts := httptest.NewServer(up)
	defer ts.Close()
	s := newStore(t, ts.URL)
	srv := &Server{Store: s, BasePath: "/news", Started: time.Now()}

	code, h, body := get(t, srv, "GET", "/health")
	if code != 200 || !strings.HasPrefix(body, `{"status":"ok","cachedTopics":0,"totalArticles":0,"lastFetch":null,"uptime":`) {
		t.Fatalf("health %d %s", code, body)
	}
	if h.Get("Access-Control-Allow-Origin") != "*" || h.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("headers %v", h)
	}

	code, _, body = get(t, srv, "GET", "/news/articles?q=economy&limit=2")
	if code != 200 || !strings.HasPrefix(body, `{"query":"economy","count":2,"articles":[`) {
		t.Fatalf("articles %d %s", code, body)
	}
	// limit clamps: 0 -> 50, -5 -> 1, 9999 -> 250, junk -> 50
	for q, want := range map[string]int{"0": 3, "-5": 1, "9999": 3, "abc": 3} {
		_, _, body = get(t, srv, "GET", "/news/articles?q=economy&limit="+q)
		var o struct{ Count int }
		_ = json.Unmarshal([]byte(body), &o)
		if o.Count != want {
			t.Errorf("limit=%s count %d want %d", q, o.Count, want)
		}
	}
	_, _, body = get(t, srv, "GET", "/news/timeline")
	if !strings.HasPrefix(body, `{"query":"economy","points":3,"timeline":[`) {
		t.Fatal(body)
	}
	_, _, body = get(t, srv, "GET", "/news/tone?q=energy")
	if !strings.HasPrefix(body, `{"query":"energy","count":1,"tone":[`) {
		t.Fatal(body)
	}
	_, _, body = get(t, srv, "GET", "/news/topics")
	if !strings.HasPrefix(body, `{"topics":[{"topic":"economy","label":"Economy","articleCount":3,"avgTone":0.5}`) || strings.Contains(strings.SplitN(body, `{"topic":"technology"`, 2)[0], "lastFetch") {
		t.Fatalf("topics %s", body)
	}
	if !strings.Contains(body, `{"topic":"technology","label":"Technology","articleCount":0,"avgTone":0,"lastFetch":""}`) {
		t.Fatalf("uncached topic %s", body)
	}

	code, _, body = get(t, srv, "GET", "/nope?x=1")
	if code != 404 || body != `{"message":"Route GET:/nope?x=1 not found","error":"Not Found","statusCode":404}` {
		t.Fatalf("404 %d %s", code, body)
	}
	code, h, body = get(t, srv, "OPTIONS", "/anything")
	if code != 204 || body != "" || h.Get("Access-Control-Allow-Methods") != "GET, OPTIONS" {
		t.Fatalf("options %d %v", code, h)
	}
}

func TestOnDemandRefetchesEveryTimeLikeTheNodeService(t *testing.T) {
	up := &upstream{}
	ts := httptest.NewServer(up)
	defer ts.Close()
	s := newStore(t, ts.URL)
	s.FetchOnDemand(context.Background(), "economy")
	first := up.hits.Load()
	s.FetchOnDemand(context.Background(), "economy")
	if up.hits.Load() != 2*first || first != 3 {
		t.Fatalf("hits %d then %d: the Node age check is NaN so every request refetches", first, up.hits.Load())
	}
}
