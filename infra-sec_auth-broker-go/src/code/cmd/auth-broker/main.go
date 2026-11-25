// auth-broker: the fleet sign-in broker (Go port of infra-sec_auth-broker). One process serves ONE provider
// (BROKER_PROVIDER) described in build.json (BROKER_CONFIG); secrets come only from the environment. Same
// environment variables, same routes, same session cookie; see package broker.
//
//	auth-broker                  serve $BIND_HOST:$PORT (default 0.0.0.0, the provider's port)
//	auth-broker -healthcheck URL exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"flag"
	"fmt"
	"os"

	"auth-broker/broker"
	"auth-broker/fleetauth"
)

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(fleetauth.Healthcheck(*hc))
	}
	path := os.Getenv("BROKER_CONFIG")
	if path == "" {
		path = "/app/build.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	doc, err := fleetauth.ParseJSON(raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, "build.json:", err)
		os.Exit(1)
	}
	pid, ok := os.LookupEnv("BROKER_PROVIDER")
	if !ok {
		fmt.Fprintln(os.Stderr, "KeyError: BROKER_PROVIDER")
		os.Exit(1)
	}
	b, err := broker.New(broker.Config{Doc: doc, Provider: pid, Env: os.Getenv})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	host, port := "0.0.0.0", b.Port()
	if v, ok := os.LookupEnv("BIND_HOST"); ok {
		host = v
	}
	if v, ok := os.LookupEnv("PORT"); ok {
		port = v
	}
	enabled := "False"
	if b.Enabled() {
		enabled = "True"
	}
	fmt.Printf("auth-broker %s enabled=%s listening %s:%s\n", pid, enabled, host, port)
	if err := fleetauth.Serve(host+":"+port, b.Handler()); err != nil && err.Error() != "http: Server closed" {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
