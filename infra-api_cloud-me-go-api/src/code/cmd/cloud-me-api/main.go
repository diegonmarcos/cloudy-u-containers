// cloud-me-api (Go port, shadow stage of #1882): read-only, authenticated read path to the owner's private cloud-me-* repos.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"cloudme-api/cmeapi"
)

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit 0 on a 200")
	flag.Parse()
	if *hc != "" {
		c := http.Client{Timeout: 5 * time.Second}
		res, err := c.Get(*hc)
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	cfg, err := cmeapi.ConfigFromEnv(os.Getenv)
	if err != nil {
		log.Fatalf("FATAL: %v", err)
	}
	srv, err := cmeapi.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8124"
	}
	host := os.Getenv("BIND_HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	addr := host + ":" + port
	hs := &http.Server{Addr: addr, Handler: srv, ReadHeaderTimeout: 15 * time.Second}
	fmt.Printf("cloud-me-api (go) on %s: base_path %s, %d routes, %d repos\n", addr, cfg.Runtime.BasePath, srv.Routes(), len(cfg.Runtime.Repos.List))
	srv.StartSync(context.Background())
	log.Fatal(hs.ListenAndServe())
}
