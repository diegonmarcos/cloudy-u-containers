{
  # Upstreams use raw WG IPs (not DNS) — Caddy is the *.mesh.diegonmarcos.com target
  @DEBUG_LINE@
  admin @ADMIN_BIND@
  order @ORDER@
  # `error` must run before `handle` like `respond`, so the mesh/WG 403 guards reach handle_errors (shared fallback redirect).
  order error before handle
  auto_https @AUTO_HTTPS@
  # ACME via DNS-01 (Cloudflare) — eliminates port-80 HTTP-01 dependency
  # and supports wildcard certs for *.diegonmarcos.com. Token sourced
  # from .secrets (env_file in compose.nix). Phase 2a of public-surface
  # collapse plan (a0_tasks/TASK-net-20260508-01_collapse-public-to-443.md).
  # resolvers 1.1.1.1: same fix caddy-public got on 2026-06-23, ported here.
  # This host's resolver is Hickory (10.0.0.1), which answers
  # *.diegonmarcos.com → 10.0.0.1 and has NO view of the Cloudflare
  # _acme-challenge TXT. Without it certmagic writes the TXT fine, then polls
  # Hickory, never sees it, and issuance times out ("waiting for record to
  # fully propagate"). caddy-public was patched then; gcp-proxy was not, so
  # every vhost here without a per-site tls{} override never got a cert --
  # mcp.diegonmarcos.com among them, which aborted TLS handshakes with an
  # internal_error alert because Caddy had no certificate to present for that
  # SNI. Only mta-sts and the *.diegonmarcos.com catch-all carried per-site
  # overrides; fixing it globally makes those redundant rather than load-bearing.
  # These are the mta-sts / catch-all per-site values promoted to the default,
  # not a weaker global. Those two blocks are the ONLY vhosts here that kept
  # their certs through the outage, so their settings are the ones with
  # evidence behind them: a second resolver in case 1.1.1.1 is unreachable,
  # and explicit propagation timing so the first poll does not race the TXT
  # write it is polling for. Every vhost now inherits that by default; the
  # per-site tls{} blocks in 90-mta-sts and 99-catch-all become redundant
  # rather than load-bearing, and are left in place only so this change does
  # not touch the two hosts that were already working.
  acme_dns cloudflare {env.CF_API_TOKEN} {
    resolvers 1.1.1.1 8.8.8.8
    propagation_delay 30s
    propagation_timeout 5m
  }
  # caddy-l4 owns :443 (Phase 3): https_port 8443 keeps Caddy HTTPS off
  # the public socket so caddy-l4 SNI mux + fall-through can run.
  https_port 8443
  # Disable HTTP/3 / QUIC — UDP/443 is reserved for WireGuard fallback
  # (firewall.nix on hub redirects udp/443 → udp/51820 for peers behind
  # networks that block 51820/udp). Phase 4 of collapse plan.
  servers {
    protocols h1 h2@TRUSTED_PROXIES@
    # PROXY protocol unwrap for the local caddy-l4 → :8443 hop. caddy-l4
    # owns :443 and pipes TLS to 127.0.0.1:8443 with `proxy_protocol v2`
    # prepended (caddyfile.nix @notmail fall-through). Without this wrapper
    # the HTTP layer saw remote_ip=127.0.0.1 for EVERY request, so the
    # wg-only tier gate (`@not_wg not remote_ip 10.0.0.0/24`) returned
    # Forbidden to legitimate WG clients (vault.diegonmarcos.com regression,
    # 2026-06-12). Order matters: proxy_protocol BEFORE tls — the PP header
    # arrives ahead of the TLS ClientHello. `allow 127.0.0.1/32` restricts
    # PP trust to the local hop; anything else cannot spoof a client IP.
    listener_wrappers {
      proxy_protocol {
        allow 127.0.0.1/32
      }
      tls
    }
  }
  on_demand_tls {
    ask @ODT_ASK_URL@
  }
  # Mesh Root CA (declared in vault, delivered via sops → .secrets.d →
  # /run/secrets). Internal .app/.db certs are issued from THIS root instead
  # of Caddy's runtime-generated local CA, so clients that trust the one
  # mesh-ca.crt (NixOS security.pki on desktop, termux CA store) get valid
  # TLS on every internal name — including HSTS-preloaded TLDs like .app,
  # where browsers refuse untrusted certs with no click-through. Root cause
  # of "snappymail.mesh.diegonmarcos.com unreachable in browsers", 2026-07-10.
  pki {
    ca mesh {
      name "diegonmarcos mesh CA"
      root {
        format pem_file
        cert /run/secrets/MESH_CA_CERT
        key /run/secrets/MESH_CA_KEY
      }
    }
  }
@L4_SECTION@
}
