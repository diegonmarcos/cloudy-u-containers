// security-testing-allowlist.mjs — the ONE enforcement function for the
// owner's security-testing containers. Pure, no I/O: given a target (URL or
// bare host/IP) and the parsed allowlist JSON, returns {allowed, host, reason}.
// Imported by _shared/test-security-testing-allowlist.mjs (guard) and mirrored
// verbatim by the c3 MCP steel/zap tools (infra-api_cloud-infra-mcp). The list
// is default-deny: anything that does not match a rule is refused.

/** Parse "a.b.c.d" → [n,n,n,n] or null. */
function v4ToInt(ip) {
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function v4InCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipN = v4ToInt(ip);
  const netN = v4ToInt(net);
  if (ipN === null || netN === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) === (netN & mask);
}

/** Minimal IPv6 membership: loopback ::1/128 and /64 prefix match on expanded hextets. */
function v6InCidr(ip, cidr) {
  const norm = (s) => s.toLowerCase().replace(/^\[|\]$/g, "");
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const expand = (a) => {
    a = norm(a);
    if (!a.includes(":")) return null;
    const [head, tail = ""] = a.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const fill = 8 - (h.length + t.length);
    if (fill < 0) return null;
    const full = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
    return full.length === 8 ? full : null;
  };
  const a = expand(ip), n = expand(net);
  if (!a || !n) return false;
  let rem = bits;
  for (let i = 0; i < 8 && rem > 0; i++) {
    const take = Math.min(16, rem);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (n[i] & mask)) return false;
    rem -= take;
  }
  return true;
}

/** Extract the bare host from a URL, host:port, or bare host/IP. */
export function targetHost(target) {
  let t = String(target || "").trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try { return new URL(t).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
    catch { return ""; }
  }
  // bare host[:port] or ipv6 [::1]:port
  const m6 = t.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (m6) return m6[1].toLowerCase();
  t = t.replace(/\/.*$/, "");
  if ((t.match(/:/g) || []).length === 1) t = t.split(":")[0]; // host:port (v4/name)
  return t.toLowerCase();
}

/**
 * @param {string} target URL or host
 * @param {object} allowlist parsed security-testing-allowlist.json
 * @returns {{allowed:boolean, host:string, reason:string}}
 */
export function checkTarget(target, allowlist) {
  const host = targetHost(target);
  const rules = (allowlist && allowlist.rules) || {};
  if (!host) return { allowed: false, host: "", reason: "empty or unparseable target" };

  const isV4 = v4ToInt(host) !== null;
  const isV6 = !isV4 && host.includes(":");

  if (isV4 || isV6) {
    for (const ip of rules.exact_ips || []) if (ip.toLowerCase() === host) return { allowed: true, host, reason: `exact fleet IP ${ip}` };
    for (const c of rules.cidrs || []) {
      const hit = c.includes(":") ? v6InCidr(host, c) : v4InCidr(host, c);
      if (hit) return { allowed: true, host, reason: `in fleet CIDR ${c}` };
    }
    return { allowed: false, host, reason: `IP ${host} is not a fleet IP/CIDR (default-deny)` };
  }

  for (const suf of rules.mesh_suffixes || []) if (host === suf.replace(/^\./, "") || host.endsWith(suf)) return { allowed: true, host, reason: `fleet mesh name (${suf})` };
  for (const suf of rules.domain_suffixes || []) {
    const bare = suf.replace(/^\./, "");
    if (host === bare || host.endsWith("." + bare)) return { allowed: true, host, reason: `owner domain (${bare})` };
  }
  return { allowed: false, host, reason: `host ${host} is not an owner domain/mesh name (default-deny)` };
}
