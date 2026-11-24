package gitproxy

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Redacted replaces any secret found in an outbound body (distinct and greppable).
const Redacted = "[redacted]"

func validUTF8(s string) bool { return utf8.ValidString(s) }

// encodeURIComponent mirrors JS: unreserved A-Za-z0-9 - _ . ! ~ * ' ( ) stay, everything else is %XX (UTF-8).
func encodeURIComponent(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(c)+256, 16)[1:]))
		}
	}
	return b.String()
}

func seg(owner, repo string) string {
	return encodeURIComponent(owner) + "/" + encodeURIComponent(repo)
}

// UpstreamHeaders are the outbound headers for api.github.com; the one function that embeds the token.
func UpstreamHeaders(token string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	h.Set("Accept", "application/vnd.github+json")
	h.Set("X-GitHub-Api-Version", "2022-11-28")
	h.Set("User-Agent", "git-proxy-api")
	return h
}

// GitPassHeaders are the only caller headers carried to GitHub's smart-HTTP endpoint: never Cookie, never the fleet bearer.
var GitPassHeaders = []string{"Content-Type", "Accept", "Git-Protocol", "Content-Encoding", "User-Agent"}

// GitUpstreamHeaders: the token goes to GitHub as the Basic password.
func GitUpstreamHeaders(token string, req http.Header) http.Header {
	out := http.Header{}
	for _, k := range GitPassHeaders {
		if v := req.Get(k); v != "" {
			out.Set(k, v)
		}
	}
	if out.Get("User-Agent") == "" {
		out.Set("User-Agent", "git-proxy-api")
	}
	out.Set("Accept-Encoding", "identity")
	out.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)))
	return out
}

func GitURL(gitBase, owner, repo, suffix string) string {
	return gitBase + "/" + seg(owner, repo) + ".git/" + suffix
}

// RedactSecrets removes every configured secret (>= 8 chars, longest first) from a string.
func RedactSecrets(out string, secrets []string) string {
	var list []string
	for _, s := range secrets {
		if len(s) >= 8 {
			list = append(list, s)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	for _, s := range list {
		out = strings.ReplaceAll(out, s, Redacted)
	}
	return out
}

func ReposURL(apiBase string, page int) string {
	if page < 1 {
		page = 1
	}
	return apiBase + "/user/repos?per_page=100&page=" + strconv.Itoa(page) + "&affiliation=owner,collaborator,organization_member"
}

func TarballURL(apiBase, owner, repo, ref string) string {
	if ref != "" {
		return apiBase + "/repos/" + seg(owner, repo) + "/tarball/" + encodeURIComponent(ref)
	}
	return apiBase + "/repos/" + seg(owner, repo) + "/tarball"
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

func ValidName(s string) bool { return nameRe.MatchString(s) && s != "." && s != ".." }

var refRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

// ValidRef: empty is valid (default branch); never `..`, a leading dash or slash.
func ValidRef(s string) bool {
	if s == "" {
		return true
	}
	if len(s) > 255 || strings.Contains(s, "..") || strings.HasPrefix(s, "-") || strings.HasPrefix(s, "/") {
		return false
	}
	return refRe.MatchString(s)
}

func RepoDeclared(repos []string, owner, repo string) bool {
	want := strings.ToLower(owner + "/" + repo)
	for _, r := range repos {
		if strings.ToLower(r) == want {
			return true
		}
	}
	return false
}

// jsParseInt mirrors Number.parseInt(raw, 10): leading whitespace, optional sign, leading digits, rest ignored.
func jsParseInt(s string) (int, bool) {
	s = strings.TrimLeft(s, " \t\n\v\f\r\u00a0\ufeff\u2028\u2029")
	i := 0
	neg := false
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		neg = s[i] == '-'
		i++
	}
	st := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == st {
		return 0, false
	}
	n, err := strconv.ParseFloat(s[st:i], 64)
	if err != nil {
		return 0, false
	}
	if n > 1e9 {
		n = 1e9
	}
	v := int(n)
	if neg {
		v = -v
	}
	return v, true
}

// ClampPerPage: per_page clamped to 1..max, default min(5, max).
func ClampPerPage(raw string, max int) int {
	n, ok := jsParseInt(raw)
	if !ok {
		if 5 < max {
			return 5
		}
		return max
	}
	if n < 1 {
		n = 1
	}
	if n > max {
		n = max
	}
	return n
}

var feedPath = map[string]string{"commits": "commits", "runs": "actions/runs"}

func FeedURL(apiBase, owner, repo, kind string, perPage int) string {
	return apiBase + "/repos/" + seg(owner, repo) + "/" + feedPath[kind] + "?per_page=" + strconv.Itoa(perPage)
}

// ---- projections: a projection, never a passthrough; absent upstream fields are omitted like undefined ----

type raw = json.RawMessage

// pick walks a JSON path with optional-chaining semantics: absent / non-object => nil (undefined); null stays "null".
func pick(v raw, path ...string) raw {
	cur := v
	for _, k := range path {
		if len(cur) == 0 {
			return nil
		}
		var m map[string]raw
		if err := json.Unmarshal(cur, &m); err != nil || m == nil {
			return nil
		}
		nxt, ok := m[k]
		if !ok {
			return nil
		}
		cur = nxt
	}
	return cur
}

// truthy mirrors JS `!!x` for a decoded JSON value.
func truthy(v raw) bool {
	if len(v) == 0 {
		return false
	}
	var x any
	if json.Unmarshal(v, &x) != nil {
		return false
	}
	switch t := x.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	}
	return true
}

type repoOut struct {
	FullName      raw  `json:"full_name,omitempty"`
	Owner         raw  `json:"owner,omitempty"`
	Name          raw  `json:"name,omitempty"`
	Private       bool `json:"private"`
	DefaultBranch raw  `json:"default_branch,omitempty"`
	UpdatedAt     raw  `json:"updated_at,omitempty"`
	SizeKB        raw  `json:"size_kb,omitempty"`
}

func ProjectRepo(r raw) repoOut {
	return repoOut{
		FullName: pick(r, "full_name"), Owner: pick(r, "owner", "login"), Name: pick(r, "name"),
		Private: truthy(pick(r, "private")), DefaultBranch: pick(r, "default_branch"),
		UpdatedAt: pick(r, "updated_at"), SizeKB: pick(r, "size"),
	}
}

type commitOut struct {
	SHA     raw `json:"sha,omitempty"`
	Message raw `json:"message,omitempty"`
	Author  raw `json:"author,omitempty"`
	Date    raw `json:"date,omitempty"`
	HTMLURL raw `json:"html_url,omitempty"`
}

func ProjectCommit(c raw) commitOut {
	return commitOut{
		SHA: pick(c, "sha"), Message: pick(c, "commit", "message"), Author: pick(c, "commit", "author", "name"),
		Date: pick(c, "commit", "author", "date"), HTMLURL: pick(c, "html_url"),
	}
}

type runOut struct {
	Name         raw `json:"name,omitempty"`
	DisplayTitle raw `json:"display_title,omitempty"`
	Status       raw `json:"status,omitempty"`
	Conclusion   raw `json:"conclusion,omitempty"`
	CreatedAt    raw `json:"created_at,omitempty"`
	HTMLURL      raw `json:"html_url,omitempty"`
	Path         raw `json:"path,omitempty"`
}

func ProjectRun(r raw) runOut {
	return runOut{
		Name: pick(r, "name"), DisplayTitle: pick(r, "display_title"), Status: pick(r, "status"),
		Conclusion: pick(r, "conclusion"), CreatedAt: pick(r, "created_at"), HTMLURL: pick(r, "html_url"), Path: pick(r, "path"),
	}
}

// ---- release assets (#837) ----

func ReleaseByTagURL(apiBase, owner, repo, tag string) string {
	return apiBase + "/repos/" + seg(owner, repo) + "/releases/tags/" + encodeURIComponent(tag)
}

func ReleaseAssetURL(apiBase, owner, repo string, id string) string {
	return apiBase + "/repos/" + seg(owner, repo) + "/releases/assets/" + encodeURIComponent(id)
}

func ValidTag(s string) bool { return s != "" && !strings.Contains(s, "/") && ValidRef(s) }

// AssetPassHeaders are the only transfer headers a resumable download needs.
var AssetPassHeaders = []string{"Content-Length", "Content-Range", "Accept-Ranges", "Etag", "Last-Modified"}

var rangeRe = regexp.MustCompile(`^bytes=(\d+-\d*|-\d+)$`)

func ValidRange(h string) bool { return rangeRe.MatchString(strings.TrimSpace(h)) }
