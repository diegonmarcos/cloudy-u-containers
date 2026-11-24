package broker

import (
	"reflect"
	"testing"
)

func kinds(a []M) []string {
	out := []string{}
	for _, x := range a {
		out = append(out, pyStr(x["kind"]))
	}
	return out
}

func notes(a []M) []string {
	out := []string{}
	for _, x := range a {
		out = append(out, pyStr(x["note"]))
	}
	return out
}

func has(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func keyState(s M, k string) M { return asM(asM(s["keys"])[k]) }

func TestSeverityAndCategory(t *testing.T) {
	p := testPolicy(t)
	ev := M{"class": "load_shed", "key": "k1", "unit": "load-shedder", "title": "t"}
	if ResolveSeverity(ev, p) != "crit" || ResolveCategory(ev, p) != "resources" {
		t.Fatal("load_shed")
	}
	if ResolveSeverity(M{"class": "psi_high", "severity": "page"}, p) != "page" {
		t.Fatal("explicit severity must win")
	}
	if ResolveCategory(M{"unit": "wg-quick-wg0"}, p) != "mesh" {
		t.Fatal("glob wg-quick*")
	}
	ev4 := M{"class": "totally_unknown"}
	if ResolveSeverity(ev4, p) != "info" || ResolveCategory(ev4, p) != "default" {
		t.Fatal("unknown defaults")
	}
}

func TestRouting(t *testing.T) {
	p := testPolicy(t)
	a, _ := Decide(M{"class": "load_shed", "key": "r1", "category": "resources", "title": "shed", "body": "b"}, p, M{}, 1000)
	if !reflect.DeepEqual(kinds(a), []string{"ntfy", "matrix"}) {
		t.Fatalf("crit routing %v", kinds(a))
	}
	a2, _ := Decide(M{"class": "deploy_failed", "key": "r2", "category": "resources", "title": "p", "body": "b"}, p, M{}, 1000)
	if !reflect.DeepEqual(kinds(a2), []string{"ntfy", "matrix", "email"}) || a2[0]["topic"] != "health_resources" {
		t.Fatalf("page routing %v", a2)
	}
}

func TestDedup(t *testing.T) {
	p := testPolicy(t)
	ev := M{"class": "load_shed", "key": "d1", "category": "resources", "title": "t", "body": "b"}
	a1, s1 := Decide(ev, p, M{}, 1000)
	if len(a1) == 0 {
		t.Fatal("first fires")
	}
	a2, s2 := Decide(ev, p, s1, 1100)
	if len(a2) != 0 || keyState(s2, "d1")["suppressed_count"] != 1.0 {
		t.Fatalf("repeat within window must be suppressed and counted: %v %v", a2, keyState(s2, "d1"))
	}
	a3, _ := Decide(ev, p, s2, 1500)
	if len(a3) == 0 {
		t.Fatal("fires again after the window")
	}
}

func TestEscalation(t *testing.T) {
	p := testPolicy(t)
	ev := M{"class": "psi_high", "key": "e1", "category": "resources", "title": "t", "body": "b"}
	a1, s1 := Decide(ev, p, M{}, 0)
	if len(a1) == 0 || a1[0]["severity"] != "warn" {
		t.Fatal("initial warn")
	}
	a2, s2 := Decide(ev, p, s1, 901)
	if len(a2) == 0 || a2[0]["severity"] != "crit" || !has(kinds(a2), "matrix") {
		t.Fatalf("warn->crit %v", a2)
	}
	a3, _ := Decide(ev, p, s2, 1801)
	if len(a3) == 0 || a3[0]["severity"] != "page" || !has(kinds(a3), "email") {
		t.Fatalf("crit->page %v", a3)
	}
}

func TestAck(t *testing.T) {
	p := testPolicy(t)
	ev := M{"class": "psi_high", "key": "a1", "category": "resources", "title": "t", "body": "b"}
	_, s1 := Decide(ev, p, M{}, 0)
	a2, s2 := Decide(M{"key": "a1", "ack": true}, p, s1, 10)
	if len(a2) != 0 || keyState(s2, "a1")["acked"] != true {
		t.Fatal("ack emits nothing and sets acked")
	}
	a3, _ := Decide(ev, p, s2, 2000)
	if len(a3) > 0 && a3[0]["severity"] == "page" {
		t.Fatal("acked key must not escalate to page")
	}
}

func TestRecovery(t *testing.T) {
	p := testPolicy(t)
	_, s1 := Decide(M{"class": "load_shed", "key": "rec1", "category": "resources", "title": "shed", "body": "b"}, p, M{}, 1000)
	rec := M{"key": "rec1", "category": "resources", "recovered": true, "title": "shed", "body": "clear"}
	a2, s2 := Decide(rec, p, s1, 1100)
	if !has(notes(a2), "recovery") || a2[0]["title"] != "[RESOLVED] shed" {
		t.Fatalf("resolved notice %v", a2)
	}
	if keyState(s2, "rec1")["active_severity"] != nil {
		t.Fatal("active_severity cleared")
	}
	a3, _ := Decide(rec, p, M{"keys": M{}}, 1200)
	if len(a3) != 0 {
		t.Fatal("recovery on an unknown key is silent")
	}
}

func TestFlap(t *testing.T) {
	p := testPolicy(t)
	state := M{}
	sawFlap := false
	now := 0.0
	for i := 0; i < 8; i++ {
		var ev M
		if i%2 == 0 {
			ev = M{"class": "load_shed", "key": "f1", "category": "resources", "title": "t", "body": "b"}
		} else {
			ev = M{"key": "f1", "category": "resources", "recovered": true, "title": "t", "body": "b"}
		}
		now += 30
		var a []M
		a, state = Decide(ev, p, state, now)
		if has(notes(a), "flap") {
			sawFlap = true
		}
	}
	if !sawFlap {
		t.Fatal("flapping notice emitted")
	}
	if keyState(state, "f1")["flap_muted_until"].(float64) <= now {
		t.Fatal("flap mute window set")
	}
}

func TestDoesNotMutateInput(t *testing.T) {
	p := testPolicy(t)
	_, s1 := Decide(M{"class": "load_shed", "key": "m1", "category": "resources"}, p, M{}, 10)
	before := deepCopy(s1)
	Decide(M{"class": "load_shed", "key": "m1", "category": "resources"}, p, s1, 20)
	if !reflect.DeepEqual(before, deepCopy(s1)) {
		t.Fatal("Decide must be pure: the input state changed")
	}
}

func TestFnmatch(t *testing.T) {
	cases := []struct {
		name, pat string
		want      bool
	}{
		{"wg-quick-wg0", "wg-quick*", true}, {"wg-quick", "wg-quick*", true}, {"wg", "wg-quick*", false},
		{"abc", "a?c", true}, {"ac", "a?c", false}, {"b", "[abc]", true}, {"d", "[!abc]", true}, {"a", "[!abc]", false},
		{"m", "[a-z]", true}, {"M", "[a-z]", false}, {"[", "[", true}, {"a[", "a[", true}, {"x", "*", true}, {"", "*", true},
		{"ab", "*b", true}, {"abc", "*b", false}, {"]", "[]]", true},
	}
	for _, c := range cases {
		if got := fnmatch(c.name, c.pat); got != c.want {
			t.Errorf("fnmatch(%q,%q)=%v want %v", c.name, c.pat, got, c.want)
		}
	}
}

func TestPriorityFor(t *testing.T) {
	p := testPolicy(t)
	for sev, want := range map[string]string{"info": "default", "warn": "high", "crit": "urgent", "page": "urgent", "x": "default"} {
		if PriorityFor(sev, p) != want {
			t.Errorf("priority %s", sev)
		}
	}
	p2, _ := ParsePolicy([]byte(`{"severity_levels":{"warn":{"priority":4}}}`))
	if PriorityFor("warn", p2) != "4" {
		t.Error("severity_levels priority wins")
	}
}
