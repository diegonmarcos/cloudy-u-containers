//! `maddy-sorter deliver ACCOUNT SENDER RCPT [SUBJECT]` — the Rust port of mail-sieve-subset-delivery-time.sh,
//! Maddy's per-message `imap_filter { command ... }` hook.
//!
//! Contract (unchanged from the shell script): the RFC 822 message is on stdin, argv carries
//! `{account_name} {sender} {rcpt_to} {subject}`; stdout is the destination folder on the first line followed by
//! one IMAP flag per line, without a trailing newline. Exit 0 with EMPTY stdout when the rules schema is not 2
//! (Maddy then keeps the default INBOX delivery); a non-zero exit means "the filter failed" and Maddy also keeps
//! INBOX, exactly as with the shell script (jq errors there end in exit 5, mirrored here).
//!
//! The port is deliberately a line-for-line behavioural copy, quirks included, because it is proven against the
//! shell script by a parity harness (test-deliver-parity.sh) before it may replace it:
//! - the header block is awk's paragraph-mode first record (CRLF lines keep their `\r`);
//! - the awk `get_header` (From, To, Cc, Bcc, Reply-To, Subject, List-Id) takes the LAST matching header and
//!   appends folded continuation lines, while the jq `get_hdr` used by `header_*` predicates takes the FIRST
//!   matching line and ignores continuations;
//! - RFC 2047 words are decoded byte-wise, charset ignored, adjacent words are not joined;
//! - only the first line of a decoded word survives (the shell reads it with `getline`).
//! No SQLite, no sqlite3 CLI, no jq, no awk, no xxd.

use regex::bytes::Regex as BRegex;
use regex::Regex;
use serde_json::Value;

/// What the process must do after evaluating a message.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Print this to stdout (no trailing newline) and exit 0.
    Print(String),
    /// Schema pin failed: print nothing, exit 0 (Maddy keeps INBOX).
    Silent(String),
}

/// A jq runtime error in the shell script; the process exits 5 like jq did.
#[derive(Debug)]
pub struct EvalError(pub String);

type Res<T> = Result<T, EvalError>;

fn err<T>(m: impl Into<String>) -> Res<T> {
    Err(EvalError(m.into()))
}

/// awk RS="" first record, then `$(...)` stripping trailing newlines.
pub fn header_block(input: &[u8]) -> Vec<u8> {
    let mut start = 0;
    while start < input.len() && input[start] == b'\n' {
        start += 1;
    }
    let s = &input[start..];
    let end = match s.windows(2).position(|w| w == b"\n\n") {
        Some(i) => i,
        None => s.len(),
    };
    let mut rec = &s[..end];
    while let Some((&b'\n', rest)) = rec.split_last() {
        rec = rest;
    }
    rec.to_vec()
}

fn lower(b: &[u8]) -> Vec<u8> {
    b.to_ascii_lowercase()
}

/// The awk `get_header`: LAST header with this name wins, continuation lines are appended with one leading space.
pub fn get_header_awk(headers: &[u8], name: &str) -> Vec<u8> {
    let lname = lower(name.as_bytes());
    let ln = lname.len() + 1;
    let mut want = lname.clone();
    want.push(b':');
    let mut val: Vec<u8> = Vec::new();
    let mut capture = false;
    for line in headers.split(|&c| c == b'\n') {
        if line.first() == Some(&b' ') || line.first() == Some(&b'\t') {
            if capture {
                let rest = trim_start_blank(line);
                val.push(b' ');
                val.extend_from_slice(rest);
            }
            continue;
        }
        capture = false;
        if line.len() >= ln && lower(&line[..ln]) == want {
            val = trim_start_blank(&line[ln..]).to_vec();
            capture = true;
        }
    }
    val
}

fn trim_start_blank(b: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    &b[i..]
}

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// `printf %s data | base64 -d` read with `getline`: GNU semantics (newlines skipped, decoding stops at the first
/// invalid group, an incomplete last group is dropped), then only the first output line is kept.
pub fn b64_getline(data: &[u8]) -> Vec<u8> {
    let clean: Vec<u8> = data.iter().copied().filter(|&c| c != b'\n').collect();
    let mut out: Vec<u8> = Vec::new();
    for g in clean.chunks(4) {
        if g.len() < 4 {
            break;
        }
        let (a, b) = match (b64_val(g[0]), b64_val(g[1])) {
            (Some(a), Some(b)) => (a, b),
            _ => break,
        };
        if g[2] == b'=' {
            if g[3] != b'=' {
                break;
            }
            out.push((a << 2) | (b >> 4));
            break;
        }
        let c = match b64_val(g[2]) {
            Some(c) => c,
            None => break,
        };
        if g[3] == b'=' {
            out.push((a << 2) | (b >> 4));
            out.push((b << 4) | (c >> 2));
            break;
        }
        let d = match b64_val(g[3]) {
            Some(d) => d,
            None => break,
        };
        out.push((a << 2) | (b >> 4));
        out.push((b << 4) | (c >> 2));
        out.push((c << 6) | d);
    }
    match out.iter().position(|&c| c == b'\n') {
        Some(i) => out[..i].to_vec(),
        None => out,
    }
}

fn hex_val(c: u8) -> Option<u32> {
    (c as char).to_digit(16)
}

/// The awk `qpdec`: `_` becomes a space, `=XX` becomes the byte XX; anything else is copied.
pub fn qp_decode(data: &[u8]) -> Vec<u8> {
    let s: Vec<u8> = data.iter().map(|&c| if c == b'_' { b' ' } else { c }).collect();
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'=' && i + 2 < s.len() {
            if let (Some(h), Some(l)) = (hex_val(s[i + 1]), hex_val(s[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// RFC 2047 decoding exactly as the shell's awk loop does it.
pub fn decode_2047(input: &[u8]) -> Vec<u8> {
    let re = BRegex::new(r"(?-u)=\?[^?]+\?[BbQq]\?[^?]*\?=").expect("static regex");
    let mut s: Vec<u8> = input.to_vec();
    loop {
        let (start, end) = match re.find(&s) {
            Some(m) => (m.start(), m.end()),
            None => break,
        };
        let word = s[start..end].to_vec();
        let parts: Vec<&[u8]> = word.split(|&c| c == b'?').collect();
        let enc = parts[2].to_ascii_lowercase();
        let data = parts[3];
        let decoded = if enc == b"b" { b64_getline(data) } else { qp_decode(data) };
        let mut next = s[..start].to_vec();
        next.extend_from_slice(&decoded);
        next.extend_from_slice(&s[end..]);
        s = next;
    }
    s
}

/// The awk `addr_from_header`: the first `<addr>` or the first field containing `@` (with `<>,;"` removed).
pub fn addr_from_header(hdr: &[u8], sender: &[u8]) -> Vec<u8> {
    let hdr: &[u8] = if hdr.is_empty() { sender } else { hdr };
    let angle = BRegex::new(r"(?-u)<[^>]+>").expect("static regex");
    for line in hdr.split(|&c| c == b'\n') {
        if let Some(m) = angle.find(line) {
            return line[m.start() + 1..m.end() - 1].to_vec();
        }
        for field in line.split(|&c| c == b' ' || c == b'\t').filter(|f| !f.is_empty()) {
            if field.contains(&b'@') {
                return field.iter().copied().filter(|c| !b"<>,;\"".contains(c)).collect();
            }
        }
    }
    Vec::new()
}

/// Everything a predicate can look at, as the shell builds it before calling jq.
pub struct Ctx {
    pub account: String,
    pub from_domain: String,
    pub from_address: String,
    pub to_hdr: String,
    pub cc_hdr: String,
    pub bcc_hdr: String,
    pub reply_to_hdr: String,
    pub subject_hdr: String,
    pub list_id_hdr: String,
    pub headers: String,
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

fn lc(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// jq `get_hdr`: first line matching `^NAME:` (NAME is used as a regex, case-insensitive), value without the
/// `name:` prefix and the whitespace after it. No continuation handling.
fn get_hdr_jq(headers: &str, name: &str) -> Res<String> {
    let re = match Regex::new(&format!("(?i)^{}:", name)) {
        Ok(r) => r,
        Err(e) => return err(format!("invalid header name regex {name:?}: {e}")),
    };
    for line in headers.split('\n') {
        if re.is_match(line) {
            let after = match line.find(':') {
                Some(i) => &line[i + 1..],
                None => line,
            };
            return Ok(after.trim_start_matches(|c: char| c.is_whitespace()).to_string());
        }
    }
    Ok(String::new())
}

fn str_list<'a>(v: &'a Value, what: &str) -> Res<Vec<&'a Value>> {
    match v.get("values") {
        Some(Value::Array(a)) => Ok(a.iter().collect()),
        _ => err(format!("{what}: cannot iterate over values")),
    }
}

/// jq `lc($s)`: `($s // "") | ascii_downcase`; non-string, non-null input is a jq error.
fn lc_value(v: &Value) -> Res<String> {
    match v {
        Value::Null => Ok(String::new()),
        Value::String(s) => Ok(lc(s)),
        other => err(format!("cannot lowercase {other}")),
    }
}

fn any_value(p: &Value, f: impl Fn(&str) -> bool) -> Res<bool> {
    for v in str_list(p, "predicate")? {
        if f(&lc_value(v)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn atom_match(p: &Value, c: &Ctx) -> Res<bool> {
    let obj = match p.as_object() {
        Some(o) => o,
        None => return err("predicate is not an object"),
    };
    let t = match obj.get("type") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => return err(format!("predicate type {other} is not a string")),
    };
    match t.as_str() {
        "from_domain" => any_value(p, |s| s == c.from_domain),
        "from_domain_suffix" => any_value(p, |s| c.from_domain.ends_with(s)),
        "from_address" => any_value(p, |s| s == c.from_address),
        "to_contains" => {
            let h = lc(&c.to_hdr);
            any_value(p, |s| h.contains(s))
        }
        "reply_to_contains" => {
            let h = lc(&c.reply_to_hdr);
            any_value(p, |s| h.contains(s))
        }
        "subject_contains" => {
            let h = lc(&c.subject_hdr);
            any_value(p, |s| h.contains(s))
        }
        "list_id_contains" => {
            let h = lc(&c.list_id_hdr);
            any_value(p, |s| h.contains(s))
        }
        "header_contains" => {
            let name = match obj.get("header") {
                Some(Value::String(s)) => s.clone(),
                other => return err(format!("header_contains: bad header {other:?}")),
            };
            let hv = lc(&get_hdr_jq(&c.headers, &name)?);
            any_value(p, |s| hv.contains(s))
        }
        "header_exists" => {
            let name = match obj.get("header") {
                Some(Value::String(s)) => s.clone(),
                other => return err(format!("header_exists: bad header {other:?}")),
            };
            Ok(!get_hdr_jq(&c.headers, &name)?.is_empty())
        }
        "header_regex" => {
            let name = match obj.get("header") {
                Some(Value::String(s)) => s.clone(),
                other => return err(format!("header_regex: bad header {other:?}")),
            };
            let pat = match obj.get("regex") {
                Some(Value::String(s)) => s.clone(),
                other => return err(format!("header_regex: bad regex {other:?}")),
            };
            let re = match Regex::new(&pat) {
                Ok(r) => r,
                Err(e) => return err(format!("header_regex: {e}")),
            };
            Ok(re.is_match(&get_hdr_jq(&c.headers, &name)?))
        }
        "has_cc" => Ok(!c.cc_hdr.is_empty()),
        "has_bcc" => Ok(!c.bcc_hdr.is_empty()),
        "list_header" => Ok(!c.list_id_hdr.is_empty()),
        "self_sent" => Ok(lc(&c.from_address) == lc(&c.account)),
        other => {
            eprintln!("[\"DEBUG:\",\"UNKNOWN_PRED: {other}\"]");
            Ok(false)
        }
    }
}

fn match_when(w: &Value, c: &Ctx) -> Res<bool> {
    let obj = match w.as_object() {
        Some(o) => o,
        None => return err(format!("cannot check whether {w} has a key")),
    };
    if let Some(v) = obj.get("any_of") {
        for e in iterate(v)? {
            if match_when(e, c)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if let Some(v) = obj.get("all_of") {
        for e in iterate(v)? {
            if !match_when(e, c)? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    if let Some(v) = obj.get("not") {
        return Ok(!match_when(v, c)?);
    }
    atom_match(w, c)
}

fn iterate(v: &Value) -> Res<Vec<&Value>> {
    match v {
        Value::Array(a) => Ok(a.iter().collect()),
        Value::Object(o) => Ok(o.values().collect()),
        other => err(format!("cannot iterate over {other}")),
    }
}

fn join_item(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn truthy_or<'a>(v: Option<&'a Value>, default: &'a Value) -> &'a Value {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => default,
        Some(x) => x,
    }
}

/// Evaluate one message. `env_strategy` is `MAIL_SIEVE_STRATEGY` when the variable is set (even to the empty string).
pub fn evaluate(rules_doc: &Value, ctx: &Ctx, env_strategy: Option<&str>) -> Res<String> {
    let null = Value::Null;
    let empty_arr = Value::Array(vec![]);
    let empty_str = Value::String(String::new());
    let rules_v = truthy_or(rules_doc.get("rules"), &empty_arr);
    let all_rules = iterate(rules_v)?;
    let mut matched: Vec<&Value> = Vec::new();
    for r in all_rules {
        let axis = match r.get("axis") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => "sender".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        };
        if axis != "sender" {
            continue;
        }
        let when = r.get("when").unwrap_or(&null);
        if match_when(when, ctx)? {
            matched.push(r);
        }
    }
    let folder = matched
        .iter()
        .filter_map(|r| match r.get("folder") {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(Value::Null) | None => None,
            Some(Value::String(_)) => None,
            Some(other) => Some(join_item(other)),
        })
        .next()
        .unwrap_or_default();
    let mut rule_flags: Vec<String> = Vec::new();
    for r in &matched {
        if let Some(Value::Array(a)) = r.get("flags") {
            rule_flags.extend(a.iter().map(join_item));
        }
    }
    let default = join_item(truthy_or(rules_doc.get("routing_default"), &empty_str));
    let json_strategy = join_item(truthy_or(rules_doc.get("delivery_strategy"), &Value::String("unified-inbox".into())));
    let strategy = match env_strategy {
        Some(s) => s.to_string(),
        None => json_strategy,
    };
    let default_flags = Value::Array(vec![Value::String("\\Seen".into())]);
    let inbox_flags: Vec<String> = match truthy_or(rules_doc.get("inbox_copy_flags"), &default_flags) {
        Value::Array(a) => a.iter().map(join_item).collect(),
        other => return err(format!("inbox_copy_flags {other} is not an array")),
    };
    let split = strategy == "split";
    let dest = if split {
        if folder.is_empty() {
            default
        } else {
            folder
        }
    } else {
        "INBOX".to_string()
    };
    let mut flags: Vec<String> = if split {
        rule_flags
    } else {
        let mut f = inbox_flags;
        f.extend(rule_flags);
        f
    };
    flags.sort();
    flags.dedup();
    let out = format!("{}\n{}", dest, flags.join("\n"));
    Ok(out.trim_end_matches('\n').to_string())
}

/// Run the whole filter for one message.
pub fn run(
    account: &str,
    sender: &str,
    rules_path: &str,
    stdin: &[u8],
    env_strategy: Option<&str>,
) -> Result<Outcome, EvalError> {
    let raw = std::fs::read_to_string(rules_path).ok();
    let doc: Option<Value> = raw.as_deref().and_then(|r| serde_json::from_str(r).ok());
    let schema_ok = match doc.as_ref().and_then(|d| d.get("schema_version")) {
        // jq -r prints the literal: `2` passes, `2.0` does not (jq 1.7 keeps the literal), exactly as the shell pin compares strings.
        Some(Value::Number(n)) => n.to_string() == "2",
        Some(Value::String(s)) => s == "2",
        _ => false,
    };
    let doc = match (doc, schema_ok) {
        (Some(d), true) => d,
        (d, _) => {
            let seen = d
                .as_ref()
                .and_then(|d| d.get("schema_version"))
                .map(|v| v.to_string())
                .unwrap_or_else(|| "0".to_string());
            return Ok(Outcome::Silent(format!("rules schema_version='{seen}', expected 2 — refusing to run")));
        }
    };

    let headers = header_block(stdin);
    let from_hdr = get_header_awk(&headers, "From");
    let to_hdr = get_header_awk(&headers, "To");
    let cc_hdr = get_header_awk(&headers, "Cc");
    let bcc_hdr = get_header_awk(&headers, "Bcc");
    let reply_to = get_header_awk(&headers, "Reply-To");
    let subject = decode_2047(&get_header_awk(&headers, "Subject"));
    let list_id = get_header_awk(&headers, "List-Id");
    let from_addr = addr_from_header(&from_hdr, sender.as_bytes());
    let from_addr_s = String::from_utf8_lossy(&from_addr).to_string();
    let domain = match from_addr_s.rfind('@') {
        Some(i) => from_addr_s[i + 1..].to_string(),
        None => from_addr_s.clone(),
    };
    let ctx = Ctx {
        account: account.to_string(),
        from_domain: lc(&domain),
        from_address: lc(&from_addr_s),
        to_hdr: lossy(&to_hdr),
        cc_hdr: lossy(&cc_hdr),
        bcc_hdr: lossy(&bcc_hdr),
        reply_to_hdr: lossy(&reply_to),
        subject_hdr: lossy(&subject),
        list_id_hdr: lossy(&list_id),
        headers: lossy(&headers),
    };
    let out = evaluate(&doc, &ctx, env_strategy)?;
    Ok(Outcome::Print(out))
}

/// Entry point for `maddy-sorter deliver ...`; returns the process exit code.
pub fn main(args: &[String]) -> i32 {
    use std::io::{Read, Write};
    let account = args.first().map(String::as_str).unwrap_or("");
    let sender = args.get(1).map(String::as_str).unwrap_or("");
    let rules_path = std::env::var("RULES_PATH").unwrap_or_else(|_| "/data/mail-rules.json".into());
    let env_strategy = std::env::var("MAIL_SIEVE_STRATEGY").ok();
    let mut input = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut input);
    match run(account, sender, &rules_path, &input, env_strategy.as_deref()) {
        Ok(Outcome::Print(out)) => {
            let mut so = std::io::stdout().lock();
            let _ = so.write_all(out.as_bytes());
            let _ = so.flush();
            0
        }
        Ok(Outcome::Silent(msg)) => {
            eprintln!("[mail-sieve] ERROR: {msg}");
            0
        }
        Err(EvalError(m)) => {
            eprintln!("jq: error: {m}");
            5
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(from: &str) -> Ctx {
        let dom = from.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
        Ctx {
            account: "me@example.org".into(),
            from_domain: dom,
            from_address: from.to_ascii_lowercase(),
            to_hdr: "me@example.org".into(),
            cc_hdr: String::new(),
            bcc_hdr: String::new(),
            reply_to_hdr: String::new(),
            subject_hdr: "Invoice 42".into(),
            list_id_hdr: String::new(),
            headers: "From: a@b\nX-Dup: first\nX-Dup: second".into(),
        }
    }

    #[test]
    fn header_block_is_awk_paragraph_mode() {
        assert_eq!(header_block(b"\n\nA: 1\nB: 2\n\nbody\n"), b"A: 1\nB: 2".to_vec());
        assert_eq!(header_block(b"A: 1\nB: 2\n"), b"A: 1\nB: 2".to_vec());
        assert_eq!(header_block(b"A: 1\r\n\r\nbody"), b"A: 1\r\n\r\nbody".to_vec(), "CRLF blank lines are not blank to awk");
        assert_eq!(header_block(b""), Vec::<u8>::new());
    }

    #[test]
    fn awk_get_header_last_wins_and_folds() {
        let h = b"From: first@a\nFrom: Name\n  <last@b>\nX: y";
        assert_eq!(get_header_awk(h, "from"), b"Name <last@b>".to_vec());
        assert_eq!(get_header_awk(h, "Missing"), Vec::<u8>::new());
        assert_eq!(get_header_awk(b"Subject:   spaced", "Subject"), b"spaced".to_vec());
    }

    #[test]
    fn base64_follows_gnu_decoder_and_getline() {
        assert_eq!(b64_getline(b"SGVsbG8="), b"Hello".to_vec());
        assert_eq!(b64_getline(b"QQ=="), b"A".to_vec());
        assert_eq!(b64_getline(b"QUI="), b"AB".to_vec());
        assert_eq!(b64_getline(b"QUJDRA"), b"ABC".to_vec(), "incomplete last group is dropped");
        assert_eq!(b64_getline(b"!!!!"), Vec::<u8>::new());
        assert_eq!(b64_getline(b"bGluZTEKbGluZTI="), b"line1".to_vec(), "only the first line survives getline");
    }

    #[test]
    fn quoted_printable_words() {
        assert_eq!(qp_decode(b"Re=3A_Your_order_=2312345"), b"Re: Your order #12345".to_vec());
        assert_eq!(qp_decode(b"caf=E9"), vec![b'c', b'a', b'f', 0xE9]);
        assert_eq!(qp_decode(b"a=ZZ=4"), b"a=ZZ=4".to_vec());
    }

    #[test]
    fn rfc2047_words_are_decoded_in_place_without_joining() {
        let out = decode_2047(b"Re: =?UTF-8?B?c2FsZQ==?= now =?utf-8?Q?a_b?=");
        assert_eq!(out, b"Re: sale now a b".to_vec());
        assert_eq!(decode_2047(b"=?A?B?SGk=?= =?A?B?SGk=?="), b"Hi Hi".to_vec());
        assert_eq!(decode_2047(b"plain"), b"plain".to_vec());
    }

    #[test]
    fn from_address_forms() {
        assert_eq!(addr_from_header(b"Alice <alice@Example.COM>", b"s@x"), b"alice@Example.COM".to_vec());
        assert_eq!(addr_from_header(b"bob@example.org", b"s@x"), b"bob@example.org".to_vec());
        assert_eq!(addr_from_header(b"weird;@semi.example, other@x.y", b"s@x"), b"weird@semi.example".to_vec());
        assert_eq!(addr_from_header(b"", b"envelope@s.example"), b"envelope@s.example".to_vec());
        assert_eq!(addr_from_header(b"nobody", b"s@x"), Vec::<u8>::new());
    }

    #[test]
    fn evaluate_unified_and_split() {
        let rules = json!({
            "schema_version": 2, "account": "me@example.org", "routing_default": "Others",
            "rules": [
                {"id": "r1", "when": {"type": "from_domain", "values": ["example.com"]}, "folder": "A", "flags": ["$a"]},
                {"id": "r2", "when": {"type": "subject_contains", "values": ["invoice"]}, "flags": ["$inv", "\\Seen"]},
                {"id": "r3", "axis": "auth", "when": {"type": "from_domain", "values": ["example.com"]}, "folder": "Auth"}
            ]
        });
        let c = ctx("alice@example.com");
        assert_eq!(evaluate(&rules, &c, None).unwrap(), "INBOX\n$a\n$inv\n\\Seen");
        assert_eq!(evaluate(&rules, &c, Some("split")).unwrap(), "A\n$a\n$inv\n\\Seen");
        assert_eq!(evaluate(&rules, &c, Some("")).unwrap(), "INBOX\n$a\n$inv\n\\Seen", "empty env value is not 'split'");
        let nomatch = ctx("x@nowhere.invalid");
        assert_eq!(evaluate(&rules, &nomatch, Some("split")).unwrap(), "Others\n$inv\n\\Seen");
    }

    #[test]
    fn evaluate_combinators_and_unknown_predicates() {
        let rules = json!({"schema_version": 2, "routing_default": "D", "delivery_strategy": "split", "rules": [
            {"when": {"all_of": []}, "folder": "AllEmpty"},
            {"when": {"any_of": []}, "folder": "AnyEmpty"},
            {"when": {"type": "size_over", "values": [1]}, "folder": "Big"}
        ]});
        assert_eq!(evaluate(&rules, &ctx("a@b.c"), None).unwrap(), "AllEmpty");
    }

    #[test]
    fn first_header_wins_in_jq_predicates() {
        let rules = json!({"schema_version": 2, "delivery_strategy": "split", "routing_default": "D", "rules": [
            {"when": {"type": "header_contains", "header": "X-Dup", "values": ["second"]}, "folder": "Second"},
            {"when": {"type": "header_contains", "header": "X-Dup", "values": ["first"]}, "folder": "First"}
        ]});
        assert_eq!(evaluate(&rules, &ctx("a@b.c"), None).unwrap(), "First");
    }

    #[test]
    fn jq_errors_become_exit_5_cases() {
        let bad_regex = json!({"schema_version": 2, "rules": [{"when": {"type": "header_regex", "header": "X", "regex": "("}}]});
        assert!(evaluate(&bad_regex, &ctx("a@b.c"), None).is_err());
        let no_values = json!({"schema_version": 2, "rules": [{"when": {"type": "from_domain"}}]});
        assert!(evaluate(&no_values, &ctx("a@b.c"), None).is_err());
        let no_when = json!({"schema_version": 2, "rules": [{"folder": "X"}]});
        assert!(evaluate(&no_when, &ctx("a@b.c"), None).is_err());
    }

    #[test]
    fn schema_pin_is_silent_exit_zero() {
        let dir = std::env::temp_dir().join(format!("deliver-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rules.json");
        std::fs::write(&p, r#"{"schema_version": 1, "rules": []}"#).unwrap();
        let out = run("me@example.org", "s@x", p.to_str().unwrap(), b"From: a@b\n\n", None).unwrap();
        assert!(matches!(out, Outcome::Silent(_)));
        let missing = run("me@example.org", "s@x", dir.join("nope.json").to_str().unwrap(), b"", None).unwrap();
        assert!(matches!(missing, Outcome::Silent(_)));
        std::fs::write(&p, r#"{"schema_version": 2.0, "rules": []}"#).unwrap();
        let float = run("me@example.org", "s@x", p.to_str().unwrap(), b"From: a@b\n\n", None).unwrap();
        assert!(matches!(float, Outcome::Silent(_)), "2.0 is not the string 2 for the shell pin");
        std::fs::write(&p, r#"{"schema_version": 2, "routing_default": "Z", "delivery_strategy": "split", "rules": []}"#).unwrap();
        let ok = run("me@example.org", "s@x", p.to_str().unwrap(), b"From: a@b\n\n", None).unwrap();
        assert_eq!(ok, Outcome::Print("Z".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
