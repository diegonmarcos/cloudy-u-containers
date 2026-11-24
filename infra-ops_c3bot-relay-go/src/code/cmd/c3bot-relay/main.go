// c3bot-relay: Telegram <-> c3 over WebSocket (/ws), SSE (/events) and long-poll (/poll); outbound POST /send; session
// lease POST /claim, /release. Go port of the Node service in infra-ops_c3bot-relay (same environment, same routes).
//
//	c3bot-relay [-listen HOST:PORT]     serve (default $HTTP_HOST:$PORT)
//	c3bot-relay -healthcheck URL        exit 0 when URL answers 2xx (distroless has no curl)
//
// SHADOW_EPHEMERAL=1 (shadow stage, ticket #1873): no secret is mounted; the bearer and webhook secret are random
// per process (nothing can call the API), the bot token is ignored (never talks to Telegram) and the process logs a
// periodic self-check of its own contract.
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
	"strconv"
	"strings"
	"syscall"
	"time"

	"c3bot-relay/relay"
	"c3bot-relay/server"
	"c3bot-relay/shadow"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envNum(k string, def float64) float64 {
	if f, err := strconv.ParseFloat(os.Getenv(k), 64); err == nil && f != 0 {
		return f
	}
	return def
}

func healthcheck(u string) int {
	r, err := (&http.Client{Timeout: 8 * time.Second}).Get(u)
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
	listen := flag.String("listen", "", "listen address (default $HTTP_HOST:$PORT)")
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(healthcheck(*hc))
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))

	shadowMode := env("SHADOW_EPHEMERAL", "") == "1"
	token, whSecret, botToken := os.Getenv("C3BOT_RELAY_TOKEN"), os.Getenv("C3BOT_WEBHOOK_SECRET"), os.Getenv("C3BOT_A_BOT_TOKEN")
	if shadowMode {
		token, whSecret, botToken = server.NewEphemeralSecret(), server.NewEphemeralSecret(), ""
	}
	// Fail loudly: a missing bearer must stop the container (health and Ship go red), never serve open.
	if token == "" {
		log.Error("FATAL: C3BOT_RELAY_TOKEN is not set (vault secret not mounted); refusing to start")
		os.Exit(78)
	}
	addr := *listen
	if addr == "" {
		addr = env("HTTP_HOST", "127.0.0.1") + ":" + env("PORT", "3119")
	}
	var allowed []string
	for _, s := range strings.Split(os.Getenv("C3BOT_ALLOWED_FROM"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			allowed = append(allowed, s)
		}
	}
	rl := relay.New(relay.Options{BufferSize: int(envNum("BUFFER_SIZE", 500)), AllowedFrom: allowed, StatePath: os.Getenv("RELAY_STATE_FILE")})
	bot := relay.NewTelegram(botToken, os.Getenv("TELEGRAM_API_BASE"))
	whURL := env("C3BOT_WEBHOOK_URL", "https://c3-pub.diegonmarcos.com/c3bot-webhook")
	fo := relay.NewFailover(time.Duration(envNum("HEALTH_WINDOW_S", 600))*time.Second, bot.Configured() && whSecret != "", nil)
	srv := server.New(server.Config{Base: env("BASE_PATH", "/c3bot-relay"), Token: token, MaxClients: int(envNum("MAX_CLIENTS", 32)),
		PollMaxWaitS: envNum("POLL_MAX_WAIT_S", 50), DefaultChat: firstOf(allowed), WebhookSecret: whSecret, WebhookURL: whURL},
		rl, bot, fo, relay.NewLease(envNum("LEASE_TTL_S", 900)))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	hs := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 64 << 10}

	go bot.Loop(ctx, func(u map[string]any) { rl.IngestUpdate(u, "P") }, 50, 5*time.Second, 2*time.Second,
		func() bool { return srv.PollEnabled() && fo.Polling() })
	if !shadowMode {
		every := time.Duration(envNum("CHECK_INTERVAL_S", 60)) * time.Second
		go func() {
			srv.HealthTick(ctx, nil)
			for t := time.NewTicker(every); ; {
				select {
				case <-t.C:
					srv.HealthTick(ctx, nil)
				case <-ctx.Done():
					return
				}
			}
		}()
	} else if d, err := time.ParseDuration(env("SHADOW_CHECK_INTERVAL", "1h")); err == nil && d >= time.Minute {
		go shadow.Loop(ctx, log, "http://"+addr, env("BASE_PATH", "/c3bot-relay"), token, whSecret, d)
	}
	go func() {
		<-ctx.Done()
		rl.Flush()
		bot.Stop()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	log.Info("c3bot-relay listening", "addr", addr, "botA", bot.Configured(), "webhookSecret", whSecret != "", "shadow", shadowMode)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
}

func firstOf(s []string) string {
	if len(s) > 0 {
		return s[0]
	}
	return ""
}
