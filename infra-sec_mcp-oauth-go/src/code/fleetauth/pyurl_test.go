package fleetauth

import "testing"

func TestPyURLSplitMatchesPython(t *testing.T) {
	for _, c := range []struct {
		uri  string
		ok   bool
		host string
	}{
		{"http://LOCALHOST:80/x", true, "localhost"},
		{"http://[::1]:8080/x", true, "::1"},
		{"http://user@127.0.0.1/x", true, "127.0.0.1"},
		{"http://[::1/x", false, ""},
		{"http://[nope]/x", false, ""},
		{"http://[127.0.0.1]/x", false, ""},
		{"http://localhost:abc/x", false, ""},
		{"http://localhost:70000/x", false, ""},
		{"  http://localhost/x", true, "localhost"},
		{"ht\ttp://localhost/x", true, "localhost"},
	} {
		u, err := PyURLSplit(c.uri)
		ok := err == nil && u.PortOK()
		if ok != c.ok || (ok && u.Hostname() != c.host) {
			t.Errorf("%q: ok=%v host=%q, want ok=%v host=%q", c.uri, ok, u.Hostname(), c.ok, c.host)
		}
	}
	u, _ := PyURLSplit("//evil.example/oauth2/google/auth?rd=%2Fx&a=1#frag")
	if u.Netloc != "evil.example" || u.Path != "/oauth2/google/auth" || u.Query != "rd=%2Fx&a=1" || u.Fragment != "frag" {
		t.Errorf("split: %+v", u)
	}
	u, _ = PyURLSplit("/a/%61?q")
	if u.Path != "/a/%61" || u.Query != "q" {
		t.Errorf("plain path: %+v", u)
	}
}

func TestParseQSDropsBlanks(t *testing.T) {
	keys, vals := ParseQS("rd=%2Fhome&empty=&flag&a=1&a=2&sp=x+y&bad=%zz")
	if len(keys) != 4 || keys[0] != "rd" || vals["rd"][0] != "/home" || len(vals["a"]) != 2 || vals["sp"][0] != "x y" || vals["bad"][0] != "%zz" {
		t.Errorf("parse_qs: %v %v", keys, vals)
	}
}

func TestB64StdDecodeMatchesPython(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{"YWI6Y2Q=", "ab:cd", true},
		{"YWI6Y2Q", "", false}, // incorrect padding
		{"***", "", true},      // skipped characters
		{"YW Ji", "abb", true},
		{"-_-_", "", true}, // not the standard alphabet: skipped
	} {
		got, err := B64StdDecode([]byte(c.in))
		if (err == nil) != c.ok || (c.ok && string(got) != c.want) {
			t.Errorf("%q: %q %v", c.in, got, err)
		}
	}
}
