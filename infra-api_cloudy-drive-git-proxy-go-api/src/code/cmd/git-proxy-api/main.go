// git-proxy-api (Go port, shadow stage of #1882): Authelia-fronted read path to GitHub.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"gitproxy-api/gitproxy"
)

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit 0 on a 200 (the distroless image has no curl)")
	flag.Parse()
	if *hc != "" {
		c := http.Client{Timeout: 5 * time.Second}
		res, err := c.Get(*hc)
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	cfg, err := gitproxy.ConfigFromEnv(os.Getenv)
	if err != nil {
		log.Fatalf("FATAL: %v", err)
	}
	srv, err := gitproxy.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8123"
	}
	host := os.Getenv("BIND_HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	addr := host + ":" + port
	hs := &http.Server{Addr: addr, Handler: srv, ReadHeaderTimeout: 15 * time.Second}
	fmt.Printf("git-proxy-api (go) on %s: base_path %s, %d routes\n", addr, cfg.Runtime.BasePath, srv.Routes())
	log.Fatal(hs.ListenAndServe())
}
