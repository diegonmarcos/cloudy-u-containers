// cloudy-all-mcp: fleet MCP router (list_servers, list_tools, call). Go port of the TypeScript router.
//
//	cloudy-all-mcp --http                 stateless Streamable HTTP on MCP_HTTP_PORT|PORT (default 3112)
//	cloudy-all-mcp                        stdio
//	cloudy-all-mcp -healthcheck URL       exit 0 when URL answers 2xx (distroless has no curl)
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
	"syscall"
	"time"

	"cloudy-all-mcp/router"
	"cloudy-all-mcp/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

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

func env(k string) string { return os.Getenv(k) }

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	httpMode := flag.Bool("http", false, "serve stateless Streamable HTTP instead of stdio")
	flag.Parse()
	if *hc != "" {
		os.Exit(healthcheck(*hc))
	}
	logger := log.New(os.Stderr, "[cloudy-all-mcp] ", 0)
	cat, err := router.LoadCatalog(env)
	if err != nil {
		logger.Fatalf("Fatal: %v", err)
	}
	r, err := router.New(cat, router.NewClientBackend(), router.Options{SelfName: router.Self})
	if err != nil {
		logger.Fatalf("Fatal: %v", err)
	}
	srv := server.New(r)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if !*httpMode {
		if err := srv.Run(ctx, &mcp.StdioTransport{}); err != nil {
			logger.Fatalf("Fatal: %v", err)
		}
		return
	}
	port := firstNonEmpty(env("MCP_HTTP_PORT"), env("PORT"), "3112")
	addr := net.JoinHostPort(firstNonEmpty(env("MCP_HTTP_HOST"), "0.0.0.0"), port)
	hs := &http.Server{Addr: addr, Handler: server.Handler(srv), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sc)
	}()
	logger.Printf("listening on %s", addr)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("Fatal: %v", err)
	}
}
