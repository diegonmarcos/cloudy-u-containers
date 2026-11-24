// mm-bridge is the Go port of the Mattermost ntfy bridge + C3 command bot (ntfy-bridge.py).
//
//	mm-bridge            run the bridge (bootstrap, slash server, ws bot, ntfy loop)
//	mm-bridge healthcheck URL
//
// MM_BRIDGE_SHADOW=1 runs only the READ side of the bridge against the real stack's ntfy stream and does not touch
// Mattermost at all (see bridge.RunShadow): used while the Python bridge is still the live one.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"mm-bridge/bridge"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if len(os.Args) < 3 {
			os.Exit(2)
		}
		c := &http.Client{Timeout: 5 * time.Second}
		resp, err := c.Get(os.Args[2])
		if err != nil || resp.StatusCode >= 500 {
			os.Exit(1)
		}
		return
	}
	if os.Getenv("MM_BRIDGE_SHADOW") == "1" {
		// The shadow never talks to Mattermost and is given no credentials; the variables the live bridge requires
		// only need to exist.
		for _, k := range []string{"MM_URL", "MM_ADMIN_EMAIL", "MM_ADMIN_USERNAME", "MM_ADMIN_PASSWORD"} {
			if os.Getenv(k) == "" {
				os.Setenv(k, "shadow-unused")
			}
		}
	}
	cfg, err := bridge.ConfigFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	b := bridge.New(cfg)
	b.Logf = log.Printf
	stop := make(chan struct{})
	if os.Getenv("MM_BRIDGE_SHADOW") == "1" {
		bridge.RunShadow(b, stop)
		return
	}
	cfg.C3Token = bridge.FetchOIDCToken(b)
	if cfg.C3Token == "" {
		cfg.C3Token = os.Getenv("C3_API_TOKEN")
	}
	state, err := b.Bootstrap(func() {
		addr := fmt.Sprintf("%s:%d", cfg.C3BindIP, cfg.C3Port)
		log.Printf("C3 command server listening on %s", addr)
		go func() { log.Fatal(http.ListenAndServe(addr, b.SlashHandler())) }()
	})
	if err != nil {
		log.Fatal(err)
	}
	if state.BotUserID != "" {
		go b.WSListener(state.BotUserID, state.BotToken, stop)
	}
	b.BridgeLoop(state.WebhookURL, stop)
}
