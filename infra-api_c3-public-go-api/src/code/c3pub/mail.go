package c3pub

import (
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"c3public-api/internal/ojson"
)

var crlfSplit = regexp.MustCompile(`\r?\n`)

// extractHeader is the Node route's RFC 5322 header scan: the header section ends at the first blank line, a header
// continues over lines starting with space or tab.
func extractHeader(body []byte, name string) (string, bool) {
	text := ojson.ReplaceInvalidUTF8(body)
	end := strings.Index(text, "\r\n\r\n")
	if end < 0 {
		end = strings.Index(text, "\n\n")
	}
	section := text
	if end >= 0 {
		section = text[:end]
	}
	target := strings.ToLower(name) + ":"
	found := false
	value := ""
	for _, line := range crlfSplit.Split(section, -1) {
		if found {
			if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
				value += " " + jsTrim(line)
			} else {
				break
			}
		} else if strings.HasPrefix(strings.ToLower(line), target) {
			value = jsTrim(line[len(name)+1:])
			found = true
		}
	}
	return value, found
}

func extractAddress(body []byte, name string) (string, bool) {
	raw, ok := extractHeader(body, name)
	if !ok || raw == "" {
		return "", false
	}
	start, end := strings.LastIndex(raw, "<"), strings.LastIndex(raw, ">")
	if start >= 0 && end > start {
		return raw[start+1 : end], true
	}
	return raw, true
}

// lenientBase64 mirrors Buffer.from(s, "base64"): both alphabets, whitespace and junk skipped, stops at the first "=".
func lenientBase64(s string) []byte {
	var vals []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		var v int
		switch {
		case c >= 'A' && c <= 'Z':
			v = int(c - 'A')
		case c >= 'a' && c <= 'z':
			v = int(c-'a') + 26
		case c >= '0' && c <= '9':
			v = int(c-'0') + 52
		case c == '+' || c == '-':
			v = 62
		case c == '/' || c == '_':
			v = 63
		case c == '=':
			i = len(s)
			continue
		default:
			continue
		}
		vals = append(vals, byte(v))
	}
	var out []byte
	for i := 0; i+1 < len(vals); i += 4 {
		g := vals[i:min(i+4, len(vals))]
		switch len(g) {
		case 4:
			out = append(out, g[0]<<2|g[1]>>4, g[1]<<4|g[2]>>2, g[2]<<6|g[3])
		case 3:
			out = append(out, g[0]<<2|g[1]>>4, g[1]<<4|g[2]>>2)
		case 2:
			out = append(out, g[0]<<2|g[1]>>4)
		}
	}
	return out
}

// decodeBody is decodeBody() of the Node route; the error text is the 400 body's error.
func decodeBody(pb parsedBody) ([]byte, error) {
	if pb.json {
		switch v := pb.val.(type) {
		case *ojson.Obj:
			if raw, ok := v.Vals["raw"].(string); ok && raw != "" {
				return lenientBase64(raw), nil
			}
			return nil, fmt.Errorf("Invalid JSON body: expected { raw: <base64> }")
		case []any:
			return nil, fmt.Errorf("Invalid JSON body: expected { raw: <base64> }")
		case string:
			return []byte(v), nil
		}
		return nil, fmt.Errorf("Missing or unsupported body")
	}
	if pb.present {
		return pb.raw, nil
	}
	return nil, fmt.Errorf("Missing or unsupported body")
}

func (s *Server) mail(w http.ResponseWriter, r *http.Request) {
	pb, st, msg := s.readBody(r)
	if st != 0 {
		s.errorHandler(w, r, st, msg)
		return
	}
	raw, err := decodeBody(pb)
	if err != nil {
		fmt.Fprintf(os.Stderr, "request.bad_body %v\n", err)
		s.sendJSON(w, r, 400, obj("status", "error", "error", err.Error()))
		return
	}
	mailFrom, ok := extractAddress(raw, "From")
	if !ok {
		mailFrom = "cloudflare@localhost"
	}
	mailTo := ""
	if ot := strings.Join(r.Header.Values("X-Original-To"), ", "); ot != "" || len(r.Header.Values("X-Original-To")) > 0 {
		mailTo = ot
	} else if a, ok := extractAddress(raw, "To"); ok {
		mailTo = a
	} else {
		mailTo = s.cfg.DefUser
	}
	msgID, ok := extractHeader(raw, "Message-ID")
	if !ok {
		msgID = "?"
	}
	pick := PickTarget(strings.Join(r.Header.Values("X-Mail-Target"), ", "), s.cfg.Primary, s.cfg.Targets, DeclaredTargets)
	if !pick.OK {
		s.sendJSON(w, r, pick.Code, obj("status", "error", "error", pick.Error))
		return
	}
	smtpTimeout := time.Duration(*s.cfg.Limits.SMTPTimeoutMS) * time.Millisecond
	send := func() error {
		return SendRaw(pick.Host, pick.Port, s.cfg.Helo, mailFrom, []string{mailTo}, raw, smtpTimeout)
	}
	res := s.ledger.Deliver(LedgerKey(pick.Name, msgID, mailTo), send, time.Duration(s.cfg.Limits.RequestTimeoutMS)*time.Millisecond)
	switch res.State {
	case Pending:
		s.sendJSON(w, r, 504, obj("status", "pending", "error", "delivery still in progress; retry joins it", "target", pick.Name))
	case Failed:
		s.sendJSON(w, r, 500, obj("status", "error", "error", res.Error))
	default:
		s.sendJSON(w, r, 200, obj("status", "delivered", "from", mailFrom, "to", mailTo, "target", pick.Name, "deduped", res.Deduped))
	}
}
