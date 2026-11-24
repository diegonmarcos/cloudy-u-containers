// tokens-api: the fleet token engine (Go port of the Flask service in infra-sec_cloudy-ai-tokens-api). Same
// environment variables, same routes, same sqlite file; see package tokensapi.
//
//	tokens-api [-listen 10.0.0.6:4184]    serve
//	tokens-api -healthcheck URL           exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"flag"
	"log/slog"
	"os"

	"tokens-api/fleetauth"
	"tokens-api/tokensapi"
)

func main() {
	listen := flag.String("listen", "", "listen address (default $BIND_HOST:$PORT, else 127.0.0.1:$PORT)")
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(fleetauth.Healthcheck(*hc))
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	cfg, err := tokensapi.FromEnv(os.LookupEnv)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	cfg.Log = log
	app, err := tokensapi.New(cfg)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	defer app.Close()
	addr := *listen
	if addr == "" {
		host, port := "127.0.0.1", "4184"
		if v, ok := os.LookupEnv("BIND_HOST"); ok {
			host = v
		}
		if v, ok := os.LookupEnv("PORT"); ok {
			port = v
		}
		addr = host + ":" + port
	}
	log.Info("tokens-api listening", "addr", addr)
	if err := fleetauth.Serve(addr, app.Handler()); err != nil && err.Error() != "http: Server closed" {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
