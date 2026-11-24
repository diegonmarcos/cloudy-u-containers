package ghrss

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ntfy-sidecars/ntfyc"
)

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>1</id><title type="html">diegonmarcos pushed to main in diegonmarcos/cloudy-u-containers</title>
    <link type="text/html" rel="alternate" href="https://github.com/diegonmarcos/cloudy-u-containers/compare/a...b"/>
    <updated>2026-11-24T10:00:00Z</updated>
    <content type="html">&lt;div class="x"&gt;&lt;a href="u"&gt;fix &amp;amp; ship&lt;/a&gt;   it&lt;/div&gt;</content></entry>
  <entry><title>diegonmarcos opened a pull request</title><link href="https://github.com/o/r/pull/1"/></entry>
  <entry><link href="https://github.com/o/r"/></entry>
</feed>`

func TestParseAtom(t *testing.T) {
	es := ParseAtom(sample)
	if len(es) != 3 {
		t.Fatalf("%d entries", len(es))
	}
	if es[0].Title != "diegonmarcos pushed to main in diegonmarcos/cloudy-u-containers" || es[0].Content != "fix & ship it" {
		t.Fatalf("%+v", es[0])
	}
	if es[2].Title != "No title" || es[2].ID != md5hex12("") {
		t.Fatalf("missing title: %+v", es[2])
	}
	if ParseAtom("<feed") != nil {
		t.Fatal("malformed XML yields nothing")
	}
}

func TestClassify(t *testing.T) {
	for title, want := range map[string][2]string{
		"x Pushed to main": {TopicCommits, "push"}, "created branch b": {TopicCommits, "branch"},
		"opened a pull request": {TopicPRs, "pr"}, "merged it": {TopicPRs, "pr"}, "released v1": {TopicOther, "release"},
		"opened an issue": {TopicOther, "issue"}, "starred r": {TopicOther, "social"}, "whatever": {TopicOther, "other"},
	} {
		if tp, ev := Classify(title); tp != want[0] || ev != want[1] {
			t.Errorf("%q -> %s %s", title, tp, ev)
		}
	}
}

func TestBuildNotification(t *testing.T) {
	n := BuildNotification(Entry{Title: "diegonmarcos pushed to main", Link: "https://github.com/o/r/compare/a...b", Content: "msg"}, "octocat")
	if n.Topic != TopicCommits || n.Title != "[PUSH] diegonmarcos pushed to main" || n.Body != "Repo: o/r\nmsg\nLink: https://github.com/o/r/compare/a...b" || strings.Join(n.Tags, ",") != "arrow_up,octocat" {
		t.Fatalf("%+v", n)
	}
}

func TestCyclePublishesOnceAndMirrorsToAll(t *testing.T) {
	dir := t.TempDir()
	pub := &ntfyc.DryRun{}
	b := &Bridge{Feeds: []Feed{{Name: "f", URL: "http://example.invalid/f.atom", Icon: "octocat"}}, StateFile: filepath.Join(dir, "seen.json"), Pub: pub,
		Now: func() time.Time { return time.Unix(1_800_000_000, 0) }, Seen: map[string]float64{}}
	n := BuildNotification(ParseAtom(sample)[0], "octocat")
	if !b.send(n) {
		t.Fatal("send")
	}
	msgs := pub.Messages()
	if len(msgs) != 2 || msgs[0].Topic != TopicCommits || msgs[1].Topic != "all" || strings.Join(msgs[1].Tags, ",") != "arrow_up,octocat,dev_commits" {
		t.Fatalf("%+v", msgs)
	}
	b.Seen["old:x"] = 1
	b.Seen["new:y"] = 1_800_000_000
	b.Feeds = nil
	b.Cycle()
	if _, ok := b.Seen["old:x"]; ok {
		t.Fatal("entries older than 7 days are pruned")
	}
	if _, ok := b.Seen["new:y"]; !ok {
		t.Fatal("recent entries stay")
	}
	raw, _ := os.ReadFile(b.StateFile)
	if !strings.Contains(string(raw), "new:y") {
		t.Fatal("state saved")
	}
}
