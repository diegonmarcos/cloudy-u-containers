// gdelt-api: GDELT news aggregator (fetch + SQLite cache + read API), Go port of capital-stack-news-gdelt-api.
//
//	gdelt-api                    serve on MCP_HTTP_HOST:PORT (default 127.0.0.1:3019), base path BASE_PATH (/news)
//	gdelt-api -healthcheck URL   exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"gdelt-api/gdelt"
)

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envMs(k string, def int) time.Duration {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n >= 0 {
		return time.Duration(n) * time.Millisecond
	}
	return time.Duration(def) * time.Millisecond
}

func healthcheck(u string) int {
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get(u)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return 1
	}
	return 0
}

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(healthcheck(*hc))
	}
	interval := 900
	if n, ok := gdelt.ParseIntJS(getenv("FETCH_INTERVAL", "900")); ok {
		interval = n
	}
	store, err := gdelt.Open(gdelt.Config{
		CacheDir:      getenv("CACHE_DIR", "/app/cache"),
		Base:          os.Getenv("GDELT_BASE"),
		FetchInterval: time.Duration(interval) * time.Second,
		Pause:         envMs("GDELT_PAUSE_MS", 500),
		TopicPause:    envMs("GDELT_TOPIC_PAUSE_MS", 2000),
	})
	if err != nil {
		log.Fatalf("[news-gdelt] open cache: %v", err)
	}
	base := getenv("BASE_PATH", "/news")
	srv := &gdelt.Server{Store: store, BasePath: strings.TrimSuffix(base, "/"), Started: time.Now()}
	host := strings.TrimSpace(os.Getenv("MCP_HTTP_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}
	port := getenv("PORT", "3019")
	addr := net.JoinHostPort(host, port)
	store.Start()
	hs := &http.Server{Addr: addr, Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		store.Stop()
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sc)
	}()
	log.Printf("[news-gdelt] Listening on %s, base path: %s", addr, base)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[news-gdelt] %v", err)
	}
	store.Close()
}
