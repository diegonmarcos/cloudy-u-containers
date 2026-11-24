// c3-execd: loopback exec / pooled ssh / docker sidecar for the Node fleet tools (#1875).
//
//	c3-execd [-listen 127.0.0.1:4187]     serve
//	c3-execd -healthcheck URL             exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"c3-execd/execd"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func healthcheck(u string) int {
	r, err := (&http.Client{Timeout: 10 * time.Second}).Get(u)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return 1
	}
	return 0
}

func main() {
	listen := flag.String("listen", env("EXECD_LISTEN", "127.0.0.1:4187"), "listen address")
	hc := flag.String("healthcheck", "", "probe this URL and exit")
	flag.Parse()
	if *hc != "" {
		os.Exit(healthcheck(*hc))
	}
	home := env("HOME", "/root")
	cfgPath := env("SSH_CONFIG", filepath.Join(home, ".ssh/config"))
	cfg, err := execd.LoadSSHConfig(cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ssh config:", err, "- ssh aliases unavailable")
		cfg = execd.ParseSSHConfig("")
	}
	token, err := execd.DefaultToken()
	if err != nil {
		fmt.Fprintln(os.Stderr, "auth:", err)
		os.Exit(2)
	}
	pool := execd.NewPool(cfg, home)
	defer pool.Close()
	s := &execd.Server{
		Token: token,
		Pool:  pool,
		Dock:  execd.NewDocker(env("DOCKER_SOCK", "/var/run/docker.sock")),
		Audit: execd.NewAuditor(os.Stderr),
		Home:  home,
	}
	srv := &http.Server{Addr: *listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 64 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Fprintln(os.Stderr, "c3-execd listening on", *listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
