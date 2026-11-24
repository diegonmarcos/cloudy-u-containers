// ntfy-sidecars is the single Go binary that replaces the six Python ntfy sidecars:
//
//	ntfy-sidecars syslog-bridge | rss-gateway | github-rss | notify-broker | digest [--weekly] | topic-scanner
//	ntfy-sidecars healthcheck URL
//
// Every sender honours NTFY_DRY_RUN=1 (the shadow stage): it logs what it would publish and never reaches a topic.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"ntfy-sidecars/broker"
	"ntfy-sidecars/digest"
	"ntfy-sidecars/ghrss"
	"ntfy-sidecars/ntfyc"
	"ntfy-sidecars/rssgw"
	"ntfy-sidecars/scanner"
	"ntfy-sidecars/syslogbr"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func logf(f string, a ...any) { log.Printf(f, a...) }

func publisher(base string) ntfyc.Publisher {
	if os.Getenv("NTFY_DRY_RUN") == "1" {
		return &ntfyc.DryRun{Logf: logf}
	}
	return &ntfyc.HTTP{Base: base, Client: &http.Client{}, Logf: logf}
}

func serve(addr string, h http.Handler) {
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ntfy-sidecars syslog-bridge|rss-gateway|github-rss|notify-broker|digest|topic-scanner|healthcheck")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "healthcheck":
		if len(os.Args) < 3 {
			os.Exit(2)
		}
		c := &http.Client{Timeout: 5 * time.Second}
		resp, err := c.Get(os.Args[2])
		if err != nil || resp.StatusCode >= 400 {
			os.Exit(1)
		}
	case "topic-scanner":
		s := scanner.New(env("NTFY_DB", "/var/cache/ntfy/cache.db"))
		s.Logf = logf
		s.Refresh()
		stop := make(chan struct{})
		go s.Loop(30*time.Second, stop)
		addr := env("LISTEN", "0.0.0.0:8091")
		logf("[scanner] listening on %s", addr)
		serve(addr, s)
	case "rss-gateway":
		g := rssgw.New()
		g.Logf = logf
		g.NtfyInternal = env("NTFY_URL", g.NtfyInternal)
		g.ProfilesConfig = env("PROFILES_CONFIG", g.ProfilesConfig)
		g.ChannelsConfig = env("CHANNELS_CONFIG", g.ChannelsConfig)
		addr := env("LISTEN", "0.0.0.0:8091")
		logf("RSS gateway listening on %s", addr)
		serve(addr, g)
	case "notify-broker":
		path := env("NOTIFY_POLICY_PATH", "/app/build-notify.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			log.Fatal(err)
		}
		pol, err := broker.ParsePolicy(raw)
		if err != nil {
			log.Fatal(err)
		}
		statePath := env("NOTIFY_STATE_PATH", "")
		if statePath == "" {
			statePath = "/var/cache/ntfy/notify-state.json"
			if st, ok := pol.Raw["state"].(map[string]any); ok {
				if p, ok := st["path"].(string); ok && p != "" {
					statePath = p
				}
			}
		}
		base := "http://10.0.0.6:8090"
		if n, ok := pol.Raw["ntfy"].(map[string]any); ok {
			if u, ok := n["wg_base_url"].(string); ok && u != "" {
				base = u
			}
		}
		d := &broker.Dispatcher{Policy: pol, Ntfy: publisher(base), DryRun: os.Getenv("NTFY_DRY_RUN") == "1", Logf: logf}
		addr := ":" + env("BROKER_PORT", "8092")
		if l := os.Getenv("LISTEN"); l != "" {
			addr = l
		}
		valid, _ := pol.Raw["valid_topics"].([]any)
		logf("[broker] listening on %s - policy topics=%d", addr, len(valid))
		serve(addr, &broker.Server{Policy: pol, StatePath: statePath, Dispatch: d})
	case "digest":
		runDigest(len(os.Args) > 2 && os.Args[2] == "--weekly")
	case "github-rss":
		b := &ghrss.Bridge{
			Feeds:     ghrss.DefaultFeeds,
			StateFile: env("SEEN_FILE", "/var/cache/ntfy/github-seen.json"),
			Pub:       publisher(env("NTFY_URL", "http://ntfy:8090")),
			Logf:      logf,
		}
		interval := 300 * time.Second
		if v, err := strconv.Atoi(os.Getenv("CHECK_INTERVAL_S")); err == nil && v > 0 {
			interval = time.Duration(v) * time.Second
		}
		logf("GitHub RSS to ntfy bridge starting... monitoring %d feeds", len(b.Feeds))
		loop(interval, b.Cycle)
	case "syslog-bridge":
		b := &syslogbr.Bridge{
			SyslogFile: env("SYSLOG_FILE", "/var/log/messages"),
			StateFile:  env("SYSLOG_STATE_FILE", "/var/cache/ntfy/syslog-offset.txt"),
			Pub:        publisher(env("NTFY_URL", "http://ntfy:8090")),
			Logf:       logf,
		}
		for {
			if _, err := os.Stat(b.SyslogFile); err == nil {
				break
			}
			logf("Waiting for %s...", b.SyslogFile)
			time.Sleep(5 * time.Second)
		}
		b.Offset = syslogbr.LoadOffset(b.StateFile)
		logf("Syslog-to-ntfy bridge starting: watching %s from offset %d", b.SyslogFile, b.Offset)
		loop(2*time.Second, b.Pass)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

// loop runs fn now and then every interval until a termination signal.
func loop(interval time.Duration, fn func()) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	t := time.NewTicker(interval)
	defer t.Stop()
	fn()
	for {
		select {
		case <-sig:
			return
		case <-t.C:
			fn()
		}
	}
}

func runDigest(weekly bool) {
	path := env("NOTIFY_POLICY_PATH", "/app/build-notify.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	pol, err := broker.ParsePolicy(raw)
	if err != nil {
		log.Fatal(err)
	}
	dcfg, _ := pol.Raw["digest"].(map[string]any)
	if dcfg == nil {
		dcfg = map[string]any{}
	}
	if e, ok := dcfg["enabled"]; ok && e == false {
		fmt.Println("[digest] disabled in policy - nothing to do")
		return
	}
	now := float64(time.Now().Unix())
	span := 86400.0
	if weekly {
		span = 7 * 86400
	}
	hist := "/opt/health/history/reports.jsonl"
	if h, ok := dcfg["reports_history_jsonl"].(string); ok && h != "" {
		hist = h
	}
	recs := digest.ReadHistory(hist, now-span)
	dg := digest.Summarize(recs, now, weekly)
	topic := "ops_reports"
	if t, ok := dcfg["topic"].(string); ok && t != "" {
		topic = t
	}
	base := "http://10.0.0.6:8090"
	if n, ok := pol.Raw["ntfy"].(map[string]any); ok {
		if u, ok := n["wg_base_url"].(string); ok && u != "" {
			base = u
		}
	}
	d := &broker.Dispatcher{Policy: pol, Ntfy: publisher(base), DryRun: os.Getenv("NTFY_DRY_RUN") == "1", Logf: logf}
	actions := []map[string]any{{"kind": "ntfy", "topic": topic, "severity": "info", "title": dg.Title, "body": dg.Body, "key": "digest", "note": "digest"}}
	if v, ok := dcfg["email"]; ok && v != nil && v != false && v != "" && v != 0.0 {
		actions = append(actions, map[string]any{"kind": "email", "severity": "info", "title": dg.Title, "body": dg.Body, "key": "digest", "note": "digest"})
	}
	sent := 0
	for _, a := range actions {
		if d.Dispatch(a) {
			sent++
		}
	}
	fmt.Printf("[digest] %s - %d records, %d/%d channels sent\n", dg.Stats.Overall, len(recs), sent, len(actions))
}
