// c3-public-api (Go port, shadow stage of #1882): analytics passthrough, mail bridge, SuperApp config, Profile > Connect.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"c3public-api/c3pub"
)

func main() {
	hc := flag.String("healthcheck", "", "probe this URL and exit 0 on a 200 (the image has no curl)")
	flag.Parse()
	if *hc != "" {
		c := http.Client{Timeout: 5 * time.Second}
		res, err := c.Get(*hc)
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	cfg, err := c3pub.LoadConfig(os.Getenv)
	if err != nil {
		log.Fatalf("Fatal: %v", err)
	}
	srv := c3pub.New(cfg)
	addr := cfg.Host + ":" + strconv.Itoa(cfg.Port)
	hs := &http.Server{Addr: addr, Handler: srv, ReadHeaderTimeout: 15 * time.Second}
	fmt.Printf("c3-public-api (go) ready on %s: base_path %s, %d analytics backends, mail primary %s:%d\n", addr, cfg.BasePath, len(cfg.Backends), cfg.Primary.Host, int(cfg.Primary.Port))
	log.Fatal(hs.ListenAndServe())
}
