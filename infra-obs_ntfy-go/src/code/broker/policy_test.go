package broker

import "testing"

// testPolicyJSON is the inline policy test_notify_broker.py falls back to; the same document is used by the
// parity harness so both implementations are exercised on identical input.
const testPolicyJSON = `{
 "severity_map": {"default": "info", "by_class": {"load_shed": "crit", "psi_high": "warn", "deploy_failed": "page", "recovered": "info"}},
 "category_by_unit": {"load-shedder": "resources", "caddy": "endpoints", "wg-quick*": "mesh"},
 "routing": {"rules": [
  {"match": "category:resources", "channels": {
    "info": [{"kind": "ntfy", "topic": "health_resources"}],
    "warn": [{"kind": "ntfy", "topic": "health_resources"}],
    "crit": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}],
    "page": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}, {"kind": "email"}]}},
  {"match": "category:mesh", "channels": {
    "page": [{"kind": "ntfy", "topic": "health_mesh"}, {"kind": "matrix"}, {"kind": "email"}]}},
  {"match": "default", "channels": {
    "info": [{"kind": "ntfy", "topic": "health_resources"}],
    "crit": [{"kind": "ntfy", "topic": "health_resources"}, {"kind": "matrix"}]}}]},
 "dedup": {"window_secs": 300, "by_key": {}},
 "flap": {"enabled": true, "transitions": 4, "window_secs": 900, "mute_after_flap_secs": 1800},
 "escalation": {"enabled": true, "warn_to_crit_secs": 900, "crit_to_page_secs": 1800},
 "recovery": {"enabled": true, "notice_severity": "info"}
}`

func testPolicy(t testing.TB) *Policy {
	t.Helper()
	p, err := ParsePolicy([]byte(testPolicyJSON))
	if err != nil {
		t.Fatal(err)
	}
	return p
}
