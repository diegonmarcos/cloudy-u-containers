package gate

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"

	"jev-gate/pyjson"
)

const maxBody = 65536

var postRe = regexp.MustCompile(`^/(decide|outcome)/([A-Za-z0-9_.-]{1,64})$`)

func send(w http.ResponseWriter, code int, obj any) {
	body := pyjson.DumpsDefault(obj)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(code)
	_, _ = io.WriteString(w, body)
}

// Handler is make_handler(): GET /health, GET /precision, POST /decide/<use>, POST /outcome/<use>.
func Handler(cfg Config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.RequestURI()
		switch r.Method {
		case http.MethodGet:
			switch path {
			case "/health":
				send(w, 200, pyjson.Obj("ok", true, "uses", GenericUseNames(cfg), "key", HasKey(cfg)))
			case "/precision":
				send(w, 200, PrecisionReport(cfg))
			default:
				send(w, 404, pyjson.Obj("ok", false, "reason", "not_found"))
			}
		case http.MethodPost:
			m := postRe.FindStringSubmatch(path)
			if m == nil {
				send(w, 404, pyjson.Obj("ok", false, "reason", "not_found"))
				return
			}
			n := int64(0)
			if h := r.Header.Get("Content-Length"); h != "" {
				v, err := strconv.ParseInt(h, 10, 64)
				if err != nil {
					v = -1
				}
				n = v
			}
			if !(n > 0 && n <= maxBody) {
				code := 400
				if n > maxBody {
					code = 413
				}
				send(w, code, pyjson.Obj("ok", false, "reason", "bad_request"))
				return
			}
			raw := make([]byte, n)
			if _, err := io.ReadFull(r.Body, raw); err != nil {
				send(w, 400, pyjson.Obj("ok", false, "reason", "bad_request"))
				return
			}
			payload, err := pyjson.Parse(raw)
			if err != nil {
				send(w, 400, pyjson.Obj("ok", false, "reason", "bad_request"))
				return
			}
			if m[1] == "outcome" {
				pm := pyjson.AsMap(payload)
				if pm == nil {
					send(w, 200, pyjson.Obj("ok", false, "reason", "bad_request"))
					return
				}
				send(w, 200, Outcome(cfg, m[2], pm.M["call"], pm.M["label"]))
				return
			}
			send(w, 200, RunUse(m[2], payload, cfg))
		default:
			http.Error(w, "Unsupported method", http.StatusNotImplemented)
		}
	})
}

// Serve is serve(): the oci-apps sidecar. It blocks.
func Serve(cfg Config) error {
	JournalStdout = true
	bind := os.Getenv("JEV_GATE_BIND")
	if bind == "" {
		bind = str(get(cfg, "sidecar", "bind"))
		if bind == "" {
			bind = "127.0.0.1"
		}
	}
	port := os.Getenv("JEV_GATE_PORT")
	if port == "" {
		if f, ok := pyjson.AsNum(get(cfg, "sidecar", "port")); ok {
			port = strconv.Itoa(int(f))
		} else {
			port = "3110"
		}
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(bind, port))
	if err != nil {
		return err
	}
	fmt.Printf("jev-gate sidecar listening on %s\n", ln.Addr().String())
	return http.Serve(ln, Handler(cfg))
}

// Main is main(argv) for the CLI modes; it returns the exit status.
func Main(mode string, args []string, stdin func() string, stdout io.Writer) int {
	emit := func(v any) { fmt.Fprintln(stdout, pyjson.DumpsDefault(v)) }
	switch mode {
	case "decide":
		// prints a verdict or {"ok": false, "reason": ...}; the exit status stays 0
		var out any
		cfg, err := LoadConfig("")
		if err != nil {
			out = pyjson.Obj("ok", false, "reason", "exception:"+ErrName(err))
		} else {
			out = DecideCLI(args, stdin(), cfg)
		}
		emit(out)
		return 0
	case "outcome", "precision":
		var out any
		cfg, err := LoadConfig("")
		if err != nil {
			out = pyjson.Obj("ok", false, "reason", "exception:"+ErrName(err))
		} else if mode == "precision" {
			out = PrecisionReport(cfg)
		} else {
			opt := func(n string) (string, bool) {
				for i := 0; i+1 < len(args); i++ {
					if args[i] == n {
						return args[i+1], true
					}
				}
				return "", false
			}
			var label any
			if l, ok := opt("--label"); ok {
				if v, err := pyjson.Parse([]byte(l)); err == nil {
					label = v
				} else {
					label = l
				}
			}
			var use, call any
			if u, ok := opt("--use"); ok {
				use = u
			}
			if c, ok := opt("--call"); ok {
				call = c
			}
			out = Outcome(cfg, use, call, label)
		}
		emit(out)
		return 0
	case "serve":
		cfg, err := LoadConfig("")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if err := Serve(cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	// hook modes: a broken gate must never change the host's behaviour
	var out any
	func() {
		defer func() { _ = recover() }()
		cfg, err := LoadConfig("")
		if err != nil {
			return
		}
		v, err := pyjson.Parse([]byte(stdin()))
		if err != nil {
			return
		}
		event := pyjson.AsMap(v)
		if event == nil {
			return
		}
		switch mode {
		case "claude":
			out = ClaudeHook(event, cfg)
		case "goose":
			out = GooseHook(event, cfg)
		case "goose-prompt":
			out = GoosePromptHook(event, cfg)
		}
	}()
	if out != nil {
		emit(out)
	}
	return 0
}
