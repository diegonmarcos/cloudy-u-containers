// Package gdelt is the Go port of gdelt.ts + server.ts of capital-stack-news-gdelt-api (#1882): a GDELT
// fetch-and-cache worker (SQLite, same schema as the Node service) behind a small read API.
package gdelt

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	_ "modernc.org/sqlite"
)

// Topic is one pre-configured topic.
type Topic struct{ Topic, Label string }

// DefaultTopics are fetched on every cycle.
var DefaultTopics = []Topic{
	{"economy", "Economy"},
	{"technology", "Technology"},
	{"geopolitics", "Geopolitics"},
	{"climate change", "Climate"},
	{"finance markets", "Finance"},
	{"artificial intelligence", "AI"},
	{"energy", "Energy"},
	{"health", "Health"},
}

const maxRecords = 250

// Config of a Store.
type Config struct {
	CacheDir      string
	Base          string        // GDELT doc API base
	FetchInterval time.Duration // freshness window and refresh period
	Pause         time.Duration // pause between the 3 calls of one topic (500 ms upstream)
	TopicPause    time.Duration // pause between topics (2000 ms upstream)
	HTTP          *http.Client
}

// Store owns the SQLite cache and the fetch loop.
type Store struct {
	cfg       Config
	db        *sql.DB
	mu        sync.Mutex
	lastFetch *string
	stop      chan struct{}
	done      sync.WaitGroup
}

// Open creates the cache database (table topics, WAL).
func Open(cfg Config) (*Store, error) {
	if cfg.Base == "" {
		cfg.Base = "https://api.gdeltproject.org/api/v2/doc/doc"
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(cfg.CacheDir, "gdelt-cache.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA journal_mode = WAL"); err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS topics (
      topic TEXT PRIMARY KEY,
      articles TEXT NOT NULL DEFAULT '[]',
      timeline TEXT NOT NULL DEFAULT '[]',
      tone TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL
    )`); err != nil {
		return nil, err
	}
	return &Store{cfg: cfg, db: db, stop: make(chan struct{})}, nil
}

// Close stops the loop and closes the database.
func (s *Store) Close() {
	s.Stop()
	_ = s.db.Close()
}

// ---- JS-compatible coercions (the Node service uses parseFloat / parseInt / ?? on untyped JSON) ----

func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

// ParseFloatJS mimics parseFloat: the longest leading decimal prefix, NaN (ok=false) when none.
func ParseFloatJS(s string) (float64, bool) {
	s = trimJS(s)
	end, seenDigit, seenDot, seenExp := 0, false, false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case (c == '+' || c == '-') && (i == 0 || ((s[i-1] == 'e' || s[i-1] == 'E') && seenExp)):
		case c == '.' && !seenDot && !seenExp:
			seenDot = true
			if seenDigit {
				end = i + 1
			}
		case (c == 'e' || c == 'E') && seenDigit && !seenExp:
			seenExp = true
		default:
			i = len(s)
		}
	}
	if !seenDigit {
		if strings.HasPrefix(s, "Infinity") || strings.HasPrefix(s, "+Infinity") {
			return math.Inf(1), true
		}
		if strings.HasPrefix(s, "-Infinity") {
			return math.Inf(-1), true
		}
		return 0, false
	}
	// trim a dangling exponent marker
	t := s[:end]
	for len(t) > 0 {
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f, true
		}
		t = t[:len(t)-1]
	}
	return 0, false
}

// numOr0 is `parseFloat(String(v ?? 0)) || 0`.
func numOr0(v any) float64 {
	if v == nil {
		return 0
	}
	f, ok := ParseFloatJS(jsString(v))
	if !ok || f == 0 || math.IsNaN(f) {
		return 0
	}
	return f
}

// ParseIntJS mimics parseInt(s, 10): leading integer or NaN (ok=false).
func ParseIntJS(s string) (int, bool) {
	s = trimJS(s)
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	j := i
	for j < len(s) && s[j] >= '0' && s[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	n, err := strconv.Atoi(s[:j])
	if err != nil {
		return 0, false
	}
	return n, true
}

// JSRound is Math.round (halves go up).
func JSRound(x float64) float64 { return math.Floor(x + 0.5) }

// ---- fetching ----

func (s *Store) fetchJSON(ctx context.Context, u string) map[string]any {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err == nil {
		var res *http.Response
		res, err = s.cfg.HTTP.Do(req)
		if err == nil {
			defer res.Body.Close()
			if res.StatusCode < 200 || res.StatusCode > 299 {
				log.Printf("[gdelt] HTTP %d from %s", res.StatusCode, u)
				return nil
			}
			var body []byte
			if body, err = io.ReadAll(res.Body); err == nil {
				var m map[string]any
				if err = json.Unmarshal(body, &m); err == nil {
					return m
				}
			}
		}
	}
	log.Printf("[gdelt] fetch failed: %v url=%s", err, u)
	return nil
}

func (s *Store) buildURL(query, mode string) string {
	// URLSearchParams keeps insertion order: query, mode, maxrecords, format
	return s.cfg.Base + "?" + "query=" + url.QueryEscape(query) + "&mode=" + url.QueryEscape(mode) + "&maxrecords=" + strconv.Itoa(maxRecords) + "&format=json"
}

func sleep(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// Article, TimelinePoint and ToneItem keep each field as the JSON value the upstream sent (JS `?? ""`).
type Article struct {
	URL           any     `json:"url"`
	Title         any     `json:"title"`
	Seendate      any     `json:"seendate"`
	Socialimage   any     `json:"socialimage"`
	Domain        any     `json:"domain"`
	Language      any     `json:"language"`
	Sourcecountry any     `json:"sourcecountry"`
	Tone          float64 `json:"tone"`
}

// TimelinePoint is one timelinevol point.
type TimelinePoint struct {
	Date  any     `json:"date"`
	Value float64 `json:"value"`
}

// ToneItem is one tonechart row.
type ToneItem struct {
	URL    any     `json:"url"`
	Title  any     `json:"title"`
	Tone   float64 `json:"tone"`
	Domain any     `json:"domain"`
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

func asList(v any) []any { l, _ := v.([]any); return l }
func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func (s *Store) fetchTopic(ctx context.Context, topic string) error {
	art := s.fetchJSON(ctx, s.buildURL(topic, "artlist"))
	sleep(ctx, s.cfg.Pause)
	tl := s.fetchJSON(ctx, s.buildURL(topic, "timelinevol"))
	sleep(ctx, s.cfg.Pause)
	tn := s.fetchJSON(ctx, s.buildURL(topic, "tonechart"))
	if art == nil && tl == nil && tn == nil {
		log.Printf("[gdelt] all 3 upstream calls failed for %q - preserving prior cache", topic)
		return nil
	}
	articles := []Article{}
	for _, x := range asList(art["articles"]) {
		a := asMap(x)
		articles = append(articles, Article{orEmpty(a["url"]), orEmpty(a["title"]), orEmpty(a["seendate"]), orEmpty(a["socialimage"]),
			orEmpty(a["domain"]), orEmpty(a["language"]), orEmpty(a["sourcecountry"]), numOr0(a["tone"])})
	}
	timeline := []TimelinePoint{}
	if first := asMap(func() any {
		l := asList(tl["timeline"])
		if len(l) > 0 {
			return l[0]
		}
		return nil
	}()); first != nil {
		for _, x := range asList(first["data"]) {
			d := asMap(x)
			v := d["value"]
			if v == nil {
				v = "0"
			}
			f, ok := ParseFloatJS(jsString(v))
			if !ok || math.IsNaN(f) || f == 0 {
				f = 0
			}
			timeline = append(timeline, TimelinePoint{orEmpty(d["date"]), f})
		}
	}
	tone := []ToneItem{}
	for _, x := range asList(tn["tonechart"]) {
		t := asMap(x)
		tone = append(tone, ToneItem{orEmpty(t["url"]), orEmpty(t["title"]), numOr0(t["tone"]), orEmpty(t["domain"])})
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	ab, _ := marshalNoEscape(articles)
	tb, _ := marshalNoEscape(timeline)
	nb, _ := marshalNoEscape(tone)
	_, err := s.db.ExecContext(ctx, `INSERT INTO topics (topic, articles, timeline, tone, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(topic) DO UPDATE SET
      articles = excluded.articles,
      timeline = excluded.timeline,
      tone = excluded.tone,
      fetched_at = excluded.fetched_at`, topic, ab, tb, nb, now)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.lastFetch = &now
	s.mu.Unlock()
	return nil
}

func (s *Store) fetchAll(ctx context.Context) {
	log.Printf("[gdelt] Fetching %d topics...", len(DefaultTopics))
	for _, t := range DefaultTopics {
		if err := s.fetchTopic(ctx, t.Topic); err != nil {
			log.Printf("[gdelt] x %s: %v", t.Topic, err)
		} else {
			log.Printf("[gdelt] ok %s", t.Topic)
		}
		sleep(ctx, s.cfg.TopicPause)
		if ctx.Err() != nil {
			return
		}
	}
	log.Printf("[gdelt] Fetch complete at %s", s.LastFetch())
}

// LastFetch is the last successful write time or "null".
func (s *Store) LastFetch() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastFetch == nil {
		return "null"
	}
	return *s.lastFetch
}

type row struct{ articles, timeline, tone, fetched string }

func (s *Store) cached(topic string) *row {
	var r row
	err := s.db.QueryRow("SELECT articles, timeline, tone, fetched_at FROM topics WHERE topic = ?", topic).Scan(&r.articles, &r.timeline, &r.tone, &r.fetched)
	if err != nil {
		return nil
	}
	return &r
}

// Articles returns the cached articles of a query, at most limit.
func (s *Store) Articles(q string, limit int) []json.RawMessage {
	r := s.cached(q)
	if r == nil {
		return []json.RawMessage{}
	}
	var all []json.RawMessage
	if json.Unmarshal([]byte(r.articles), &all) != nil {
		return []json.RawMessage{}
	}
	if len(all) > limit {
		all = all[:limit]
	}
	if all == nil {
		all = []json.RawMessage{}
	}
	return all
}

func (s *Store) list(q string, pick func(*row) string) []json.RawMessage {
	r := s.cached(q)
	if r == nil {
		return []json.RawMessage{}
	}
	var all []json.RawMessage
	if json.Unmarshal([]byte(pick(r)), &all) != nil || all == nil {
		return []json.RawMessage{}
	}
	return all
}

// Timeline returns the cached timeline of a query.
func (s *Store) Timeline(q string) []json.RawMessage {
	return s.list(q, func(r *row) string { return r.timeline })
}

// Tone returns the cached tone rows of a query.
func (s *Store) Tone(q string) []json.RawMessage {
	return s.list(q, func(r *row) string { return r.tone })
}

// TopicSummary is one row of /topics. LastFetch is omitted when the topic is cached: the Node service
// reads `row.fetchedAt` from a column named fetched_at, so the key is undefined and JSON.stringify drops it.
type TopicSummary struct {
	Topic        string  `json:"topic"`
	Label        string  `json:"label"`
	ArticleCount int     `json:"articleCount"`
	AvgTone      float64 `json:"avgTone"`
	LastFetch    *string `json:"lastFetch,omitempty"`
}

// Topics reports every default topic with its cache state.
func (s *Store) Topics() []TopicSummary {
	out := []TopicSummary{}
	for _, t := range DefaultTopics {
		r := s.cached(t.Topic)
		if r == nil {
			empty := ""
			out = append(out, TopicSummary{t.Topic, t.Label, 0, 0, &empty})
			continue
		}
		var arts []struct {
			Tone float64 `json:"tone"`
		}
		_ = json.Unmarshal([]byte(r.articles), &arts)
		avg := 0.0
		if len(arts) > 0 {
			sum := 0.0
			for _, a := range arts {
				sum += a.Tone
			}
			avg = sum / float64(len(arts))
		}
		out = append(out, TopicSummary{t.Topic, t.Label, len(arts), JSRound(avg*100) / 100, nil})
	}
	return out
}

// Health is the /health counters.
func (s *Store) Health() (cachedTopics, totalArticles int, lastFetch *string) {
	rows, err := s.db.Query("SELECT articles FROM topics")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			if rows.Scan(&a) == nil {
				var l []json.RawMessage
				_ = json.Unmarshal([]byte(a), &l)
				cachedTopics++
				totalArticles += len(l)
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return cachedTopics, totalArticles, s.lastFetch
}

// FetchOnDemand refreshes a query. The Node service computes the age from `row.fetchedAt` (undefined),
// gets NaN, and so refetches on every request; that behaviour is kept for parity (Fresh=false always).
func (s *Store) FetchOnDemand(ctx context.Context, q string) {
	if err := s.fetchTopic(ctx, q); err != nil {
		log.Printf("[gdelt] on-demand %q: %v", q, err)
	}
}

// Start runs the initial fetch and the periodic refresh.
func (s *Store) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-s.stop; cancel() }()
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		s.fetchAll(ctx)
		if s.cfg.FetchInterval <= 0 {
			return
		}
		tk := time.NewTicker(s.cfg.FetchInterval)
		defer tk.Stop()
		for {
			select {
			case <-tk.C:
				s.fetchAll(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop ends the loop.
func (s *Store) Stop() {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	s.done.Wait()
}

func trimJS(s string) string { return strings.TrimLeftFunc(s, unicode.IsSpace) }

func marshalNoEscape(v any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}
