// jev-gate: the Jev pre-flight gate as one static binary (Go port of _shared/jev-gate/jev_gate.py, #1879).
//
//	jev-gate claude | goose | goose-prompt   agent hooks (stdin JSON)
//	jev-gate decide --use <name>             {state, questions} on stdin -> verdict JSON
//	jev-gate outcome --use U --call C --label JSON | precision
//	jev-gate serve                           the sidecar: POST /decide/<use>, POST /outcome/<use>, GET /health, /precision
//	jev-gate healthcheck URL                 exit 0 when URL answers 2xx (distroless has no curl)
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"jev-gate/gate"
)

func main() {
	if len(os.Args) > 2 && os.Args[1] == "healthcheck" {
		c := &http.Client{Timeout: 5 * time.Second}
		resp, err := c.Get(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			os.Exit(1)
		}
		return
	}
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	var rest []string
	if len(os.Args) > 2 {
		rest = os.Args[2:]
	}
	stdin := func() string { b, _ := io.ReadAll(os.Stdin); return string(b) }
	os.Exit(gate.Main(mode, rest, stdin, os.Stdout))
}
