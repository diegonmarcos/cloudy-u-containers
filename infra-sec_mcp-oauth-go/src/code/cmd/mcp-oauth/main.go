// mcp-oauth: the MCP OAuth 2.1 authorization server (Go port of the Flask service in infra-sec_mcp-oauth). Same
// environment variables, same routes, same sqlite file; see package mcpoauth.
//
//	mcp-oauth [-listen 10.0.0.1:4189]    serve
//	mcp-oauth -healthcheck URL           exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"flag"
	"log/slog"
	"os"

	"mcp-oauth/fleetauth"
	"mcp-oauth/mcpoauth"
)

func main() {
	listen := flag.String("listen", "", "listen address (default $BIND:$PORT, else 127.0.0.1:$PORT)")
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(fleetauth.Healthcheck(*hc))
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	cfg, err := mcpoauth.FromEnv(os.LookupEnv)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	cfg.Log = log
	app, err := mcpoauth.New(cfg)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	defer app.Close()
	addr := *listen
	if addr == "" {
		host, port := "127.0.0.1", "4183"
		if v, ok := os.LookupEnv("BIND"); ok {
			host = v
		}
		if v, ok := os.LookupEnv("PORT"); ok {
			port = v
		}
		addr = host + ":" + port
	}
	log.Info("mcp-oauth listening", "addr", addr)
	if err := fleetauth.Serve(addr, app.Handler()); err != nil && err.Error() != "http: Server closed" {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
