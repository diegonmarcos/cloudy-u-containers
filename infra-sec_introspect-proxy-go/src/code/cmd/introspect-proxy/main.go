// introspect-proxy: Caddy forward_auth target for fleet Bearer tokens (Go port of the Flask
// service in infra-sec_introspect-proxy). Same environment variables, same routes, same
// answers; see package proxy for the contract.
//
//	introspect-proxy [-listen 10.0.0.1:4182]     serve
//	introspect-proxy -healthcheck URL            exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"introspect-proxy/proxy"
	"introspect-proxy/shadow"
)

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func healthcheck(u string) int {
	cl := &http.Client{Timeout: 25 * time.Second}
	r, err := cl.Get(u)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		fmt.Fprintln(os.Stderr, "status", r.StatusCode)
		return 1
	}
	return 0
}

func main() {
	listen := flag.String("listen", "", "listen address (default $BIND_HOST:$BIND_PORT, else 127.0.0.1:$PORT)")
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(healthcheck(*hc))
	}

	level := slog.LevelInfo
	if strings.ToLower(env("DEBUG", "false")) == "true" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	cfg, err := proxy.FromEnv(os.LookupEnv, log)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	addr := *listen
	if addr == "" {
		if h := env("BIND_HOST", ""); h != "" {
			addr = h + ":" + env("BIND_PORT", env("PORT", "4182"))
		} else {
			addr = "127.0.0.1:" + env("PORT", "4182")
		}
	}
	h := proxy.Handler(cfg)
	srv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Shadow stage (ticket #1872): compare this implementation's decisions with the live
	// Python one on a fixed fixture set against the real upstreams, and log the verdict.
	if ref := env("SHADOW_COMPARE_URL", ""); ref != "" {
		every, err := time.ParseDuration(env("SHADOW_COMPARE_INTERVAL", "6h"))
		if err != nil || every < time.Minute {
			every = 6 * time.Hour
		}
		go shadow.Loop(ctx, log, "http://"+addr, ref, cfg.Verifier.JWKS.URL, env("ISSUER", "https://auth.diegonmarcos.com"), every)
	}

	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("introspect-proxy listening", "addr", addr, "engine", cfg.Engine != nil, "mcp_oauth", cfg.MCP != nil)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
}
