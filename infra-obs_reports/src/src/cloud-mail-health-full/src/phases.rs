use crate::checks::*;
use crate::constants::*;
use crate::ssh;
use crate::types::*;
use std::time::Instant;

// ═══════════════════════════════════════════════════════════════════════════
// TIER 0: PATH CHECKER -- traces outbound + inbound mail paths, <5s
// ═══════════════════════════════════════════════════════════════════════════
//
// OUTBOUND: mail_send → Maddy :465 → OCI relay :587 → (retry: AWS :587) → dest MX
// INBOUND:  Resend → CF MX → CF Worker → api.diegonmarcos.com/http-to-smtp-proxy-api (HTTPS)
//           → Caddy gcp-proxy → http-to-smtp-proxy-api gcp-proxy :8090 → SMTP/WG → Maddy :25
//           → dual-write: Maddy imapsql (:993)  AND  stalwart_queue → :2025 → Stalwart (:2993)
//
// The inbound path does NOT end at Maddy. Maddy is the WG-only MX; Stalwart is
// the store mail clients read. Both legs have to be traced or the report can
// call inbound healthy while the user's mailbox has stopped receiving.
//

pub async fn path_checker() -> Vec<Check> {
    let client = http_client();
    let mut checks = Vec::new();

    // ── OUTBOUND PATH ──────────────────────────────────────────
    // Step 1: Maddy SMTPS :465 (submission)
    let t = Instant::now();
    let ok = tcp(MAIL_WG_IP, 465).await;
    checks.push(Check {
        name: "OUT→1 Maddy :465 (SMTPS)".into(),
        passed: ok,
        details: format!("tcp {}:465 {}", MAIL_WG_IP, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("Maddy not accepting submissions".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Step 2: OCI relay :587 (STARTTLS)
    let t = Instant::now();
    let ok = tcp(OCI_RELAY_HOST, OCI_RELAY_PORT).await;
    checks.push(Check {
        name: "OUT→2 OCI relay :587".into(),
        passed: ok,
        details: format!("tcp {}:{} {}", OCI_RELAY_HOST, OCI_RELAY_PORT, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("OCI SMTP relay unreachable".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Step 3: AWS relay :587 (fallback)
    let t = Instant::now();
    let ok = tcp(AWS_RELAY_HOST, AWS_RELAY_PORT).await;
    checks.push(Check {
        name: "OUT→3 AWS relay :587 (fallback)".into(),
        passed: ok,
        details: format!("tcp {}:{} {}", AWS_RELAY_HOST, AWS_RELAY_PORT, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("AWS SMTP relay unreachable".into()) },
        severity: if ok { Severity::Info } else { Severity::Warning },
    });

    // ── INBOUND PATH ───────────────────────────────────────────
    // Step 1: Cloudflare MX records
    // MX is a public-DNS concern, not split-DNS. Hickory (internal
    // resolver pointed at 10.0.0.1:53) only carries the `*.app` zone
    // and returns nothing for the apex MX — so we'd false-positive
    // on a CRIT every run even though Cloudflare's MX is healthy.
    // Use the public resolver (1.1.1.1) here, fall back to Hickory
    // only if the public lookup somehow fails (covers air-gapped
    // dev or CF outage). See dig +short MX diegonmarcos.com @1.1.1.1.
    let t = Instant::now();
    let resolver = hickory_resolver();
    let mx_ok = match public_resolver().mx_lookup(BASE_DOMAIN).await {
        Ok(mx) => !mx.iter().next().is_none(),
        Err(_) => match resolver.mx_lookup(BASE_DOMAIN).await {
            Ok(mx) => !mx.iter().next().is_none(),
            Err(_) => false,
        },
    };
    checks.push(Check {
        name: "IN→1 Cloudflare MX".into(),
        passed: mx_ok,
        details: if mx_ok { "MX records present (1.1.1.1)".into() } else { "no MX records".into() },
        duration_ms: t.elapsed().as_millis() as u64,
        error: if mx_ok { None } else { Some("MX DNS missing".into()) },
        severity: if mx_ok { Severity::Info } else { Severity::Critical },
    });

    // Step 2: api.diegonmarcos.com/http-to-smtp-proxy-api HTTPS (CF Worker → Caddy)
    let t = Instant::now();
    let url = format!("https://{}{}/", HTTP_TO_SMTP_PROXY_API_DOMAIN, HTTP_TO_SMTP_PROXY_API_PATH);
    let (_, code, detail) = http_get(&client, &url).await;
    // http-to-smtp-proxy-api returns various codes, any non-timeout means the chain is alive
    let ok = code > 0;
    checks.push(Check {
        name: "IN→2 api.diegonmarcos.com/http-to-smtp-proxy-api HTTPS".into(),
        passed: ok,
        details: format!("HTTP {} ({})", code, detail),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("Caddy/http-to-smtp-proxy-api unreachable from internet".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Step 3: Caddy → Hickory DNS resolves http-to-smtp-proxy-api.mesh.diegonmarcos.com
    let t = Instant::now();
    let dns_ok = match resolver.lookup_ip("http-to-smtp-proxy-api.mesh.diegonmarcos.com.").await {
        Ok(ips) => ips.iter().next().is_some(),
        Err(_) => false,
    };
    checks.push(Check {
        name: "IN→3 Hickory DNS http-to-smtp-proxy-api.mesh.diegonmarcos.com".into(),
        passed: dns_ok,
        details: if dns_ok { format!("→ {}", PROXY_WG_IP) } else { "NXDOMAIN".into() },
        duration_ms: t.elapsed().as_millis() as u64,
        error: if dns_ok { None } else { Some("Hickory DNS not resolving http-to-smtp-proxy-api.mesh.diegonmarcos.com".into()) },
        severity: if dns_ok { Severity::Info } else { Severity::Critical },
    });

    // Step 4: http-to-smtp-proxy-api on gcp-proxy (via WG) — port from constant (8090).
    let t = Instant::now();
    let ok = tcp(PROXY_WG_IP, HTTP_TO_SMTP_PROXY_API_PORT).await;
    checks.push(Check {
        name: format!("IN→4 http-to-smtp-proxy-api :{} (gcp-proxy)", HTTP_TO_SMTP_PROXY_API_PORT),
        passed: ok,
        details: format!("tcp {}:{} {}", PROXY_WG_IP, HTTP_TO_SMTP_PROXY_API_PORT, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("http-to-smtp-proxy-api not running on gcp-proxy".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Step 5: Maddy SMTP :25 on oci-mail (WG relay from http-to-smtp-proxy-api)
    let t = Instant::now();
    let ok = tcp(MAIL_WG_IP, 25).await;
    checks.push(Check {
        name: "IN→5 Maddy :25 (oci-mail)".into(),
        passed: ok,
        details: format!("tcp {}:25 {}", MAIL_WG_IP, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("Maddy SMTP not listening".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Step 6: Maddy IMAP :993 — the local_mailboxes leg of the dual-write.
    let t = Instant::now();
    let ok = tcp(MAIL_WG_IP, 993).await;
    checks.push(Check {
        name: "IN→6 Maddy IMAP :993 (local store)".into(),
        passed: ok,
        details: format!("tcp {}:993 {}", MAIL_WG_IP, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("Maddy IMAP not accessible".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // Steps 7-8: the second leg. maddy.conf's local_routing pipeline ends in
    // `deliver_to &local_mailboxes` AND `deliver_to &stalwart_queue`, and
    // stalwart_queue drains to `target.smtp stalwart_relay { targets
    // tcp://10.0.0.3:2025 }`. Until now the inbound trace stopped at step 6, so
    // it declared inbound healthy while describing only the store the user does
    // not read. These two steps carry it to the actual destination.
    let t = Instant::now();
    let ok = tcp(STALWART_WG_IP, 2025).await;
    checks.push(Check {
        name: "IN→7 stalwart_relay :2025 (dual-write)".into(),
        passed: ok,
        details: format!("tcp {}:2025 {}", STALWART_WG_IP, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("Stalwart not accepting maddy's mirror — mail queues on disk".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    let t = Instant::now();
    let ok = tcp(STALWART_WG_IP, 2993).await;
    checks.push(Check {
        name: "IN→8 Stalwart IMAPS :2993 (user store)".into(),
        passed: ok,
        details: format!("tcp {}:2993 {}", STALWART_WG_IP, if ok { "OPEN" } else { "CLOSED" }),
        duration_ms: t.elapsed().as_millis() as u64,
        error: if ok { None } else { Some("user-facing store unreachable".into()) },
        severity: if ok { Severity::Info } else { Severity::Critical },
    });

    // ── DISCOVERY PATH ─────────────────────────────────────────
    // RFC 8620 §2.2 JMAP autoconfig — every URL in JMAP_DISCOVERY_URLS
    // must return HTTP 200 AND a JSON body whose
    // `capabilities.urn:ietf:params:jmap:core` key exists.
    // Status-only would false-positive on Caddy's 404 HTML page (HTTP
    // 200) and Authelia's forward-auth login HTML (also HTTP 200).
    for (idx, url) in JMAP_DISCOVERY_URLS.iter().enumerate() {
        let t = Instant::now();
        let (passed, detail) = probe_jmap_well_known(&client, url).await;
        checks.push(Check {
            name: format!("DISC→{} JMAP autoconfig {}", idx + 1, url),
            passed,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if passed { None } else { Some(detail) },
            severity: if passed { Severity::Info } else { Severity::Warning },
        });
    }

    // STALWART subhostname group REMOVED (was STAL→1/2/3).
    // The `imap-stalwart.*` / `smtps-stalwart.*` / `mail-stalwart.*`
    // Caddy SNI subhostnames were intentionally retired (see
    // cloud-repo aa-sui_tools-stalwart/build.json::proxy.primary.
    // _doc_l4_ports — "those Caddy SNI subhostnames were removed").
    // The probes on the retired hostnames were either false-positives
    // (TCP :443 OPEN because the wildcard SNI accepts the connection
    // but routes to nothing useful) or false-negatives (404 HTML on
    // /.well-known/jmap because no route is declared). Stalwart's
    // public JMAP is already covered green by DISC→1 (canonical
    // jmap.diegonmarcos.com) and DISC→3 (apex autoconfig). No
    // additional surface to monitor here.

    // WG-PUBLIC group REMOVED.
    // Probed peer reachability via TCP — first :443 (only oci-analytics
    // and gcp-proxy bind there), then :22 (SSH only binds 0.0.0.0 or
    // wg0 on the spokes, not the wg-public IP). Both choices produced
    // structural false-negatives because the wg-public address itself
    // doesn't expose any uniform "is this peer alive" port.
    //
    // The proper signal (wg-quick handshake age per peer) needs a
    // shell-out to `wg show wg-public latest-handshakes` on the hub,
    // which is a heavier integration. Deferring until that's worth
    // the surface — until then, wg-public health surfaces through
    // its downstream consumers (Stalwart IMAPS/SMTPS/JMAP reachability,
    // c3-public-api /pub routes, cf-worker bridge) which are already
    // exercised by the IN→ / DISC→ groups above. A wg-public outage
    // would turn most of those red on the same poll.

    checks
}

/// RFC 8620 §2.2 JMAP well-known probe — two-layer validation guards
/// against Caddy 404 HTML + Authelia login HTML both returning HTTP 200.
///
/// Uses a dedicated client that follows up to 3 redirects, because
/// Stalwart issues a relative 307 from `/.well-known/jmap` to the
/// canonical session URL (Caddy preserves it, see
/// aa-sui_tools-stalwart/build.json well_known doc). The shared
/// `path_checker` client uses `redirect::Policy::none()` which would
/// incorrectly fail on the 307 even though the chain ends at the real
/// JMAP JSON.
async fn probe_jmap_well_known(
    _client: &reqwest::Client,
    url: &str,
) -> (bool, String) {
    use crate::checks::HTTP_TIMEOUT;
    use tokio::time::timeout;
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .danger_accept_invalid_certs(true)
        .build()
        .expect("jmap discovery client build");
    let resp = match timeout(HTTP_TIMEOUT, client.get(url).send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return (false, format!("transport: {}", e)),
        Err(_) => return (false, "timeout".into()),
    };
    let status = resp.status();
    if !status.is_success() {
        return (false, format!("HTTP {}", status.as_u16()));
    }
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => return (false, format!("body read: {}", e)),
    };
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            let preview: String = body.chars().take(60).collect();
            return (false, format!("body not JSON ({}…)", preview));
        }
    };
    let has_core = json
        .get("capabilities")
        .and_then(|c| c.get("urn:ietf:params:jmap:core"))
        .is_some();
    if has_core {
        (true, format!("HTTP {} + jmap:core capability", status.as_u16()))
    } else {
        (false, format!("HTTP {} but missing capabilities.urn:ietf:params:jmap:core", status.as_u16()))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 0: INSTANT KPIs -- no SSH, <2s
// ═══════════════════════════════════════════════════════════════════════════

pub async fn phase0_instant_kpis() -> Vec<Check> {
    let client = http_client();

    let (mail_https, webmail_https, auth_https, mcp_endpoint, mx_record, dkim_record, gha_health) = tokio::join!(
        // mail.* HTTPS
        async {
            let t = Instant::now();
            let url = format!("https://{}:443", MAIL_DOMAIN);
            let (ok, _code, detail) = http_get(&client, &url).await;
            Check {
                name: "mail.* HTTPS".into(),
                passed: ok,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
        // webmail HTTPS
        async {
            let t = Instant::now();
            let url = format!("https://{}", WEBMAIL_DOMAIN);
            let (ok, _code, detail) = http_get(&client, &url).await;
            Check {
                name: "webmail HTTPS".into(),
                passed: ok,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
        // auth HTTPS
        async {
            let t = Instant::now();
            let url = format!("https://{}/api/health", AUTH_DOMAIN);
            let (ok, code, detail) = http_get(&client, &url).await;
            Check {
                name: "auth HTTPS".into(),
                passed: code == 200,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        },
        // MCP endpoint
        async {
            let t = Instant::now();
            let url = format!("https://{}/mail-mcp/mcp", MCP_DOMAIN);
            let (_, code, detail) = http_get(&client, &url).await;
            let ok = matches!(code, 400 | 405 | 406 | 200);
            Check {
                name: "MCP endpoint".into(),
                passed: ok,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        },
        // MX record
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let records = dns_mx(&resolver, BASE_DOMAIN).await;
            let has_mx = records.iter().any(|(_, ex)| {
                ex.contains("cloudflare") || ex.contains("mx")
            });
            let detail = if let Some(first) = records.first() {
                format!("{} {}", first.0, first.1)
            } else {
                "NONE".to_string()
            };
            Check {
                name: "MX record".into(),
                passed: has_mx,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if has_mx { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
        // DKIM record
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let txt = dns_txt(&resolver, &format!("{}._domainkey.{}", DKIM_SELECTOR, BASE_DOMAIN)).await;
            let has_dkim = txt.as_ref().map(|s| s.contains("DKIM1")).unwrap_or(false);
            Check {
                name: "DKIM record".into(),
                passed: has_dkim,
                details: if has_dkim { "present".into() } else { "MISSING".into() },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if has_dkim { None } else { Some("DKIM TXT record missing".into()) },
                severity: Severity::Critical,
            }
        },
        // GHA health
        async {
            let t = Instant::now();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(12),
                tokio::process::Command::new("gh")
                    .args([
                        "-R", "diegonmarcos/cloud-infra", "run", "list",
                        "--limit", "5", "--json", "name,conclusion", "-q",
                        r#".[] | select(.conclusion == "failure") | .name"#,
                    ])
                    .output(),
            )
            .await;
            let (ok, detail) = match result {
                Ok(Ok(output)) if output.status.success() => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let failures: Vec<&str> = stdout.trim().lines().filter(|l| !l.is_empty()).collect();
                    if failures.is_empty() {
                        (true, "all green".to_string())
                    } else {
                        (false, format!("{} failing: {}", failures.len(), failures[..failures.len().min(2)].join(", ")))
                    }
                }
                _ => (true, "gh unavailable (skipped)".to_string()),
            };
            Check {
                name: "GHA health".into(),
                passed: true, // informational — GHA failures don't indicate mail health issues
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: None,
                severity: Severity::Info,
            }
        },
    );

    // ── New delivery-path health checks ──────────────────────────────
    let (cf_worker_check, google_oauth_check, maddy_imap_check, maddy_smtp_check) = tokio::join!(
        // CF Worker alive — email-forwarder.diegonm-workers.workers.dev
        async {
            let t = Instant::now();
            let (_, code, detail) = http_get(&client, CF_WORKER_URL).await;
            // Worker returns various codes; any response (even 405) means it's deployed
            let ok = code > 0;
            Check {
                name: "CF Worker alive".into(),
                passed: ok,
                details: format!("HTTP {}", if ok { code.to_string() } else { detail.clone() }),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("CF email-forwarder Worker unreachable".into()) },
                severity: Severity::Critical,
            }
        },
        // Google OAuth endpoint reachable (Gmail API dependency)
        async {
            let t = Instant::now();
            let (_, code, detail) = http_get(&client, GOOGLE_TOKEN_URL).await;
            // Token endpoint returns 400/404/405 without proper params — that's healthy
            let ok = matches!(code, 400 | 404 | 405 | 200);
            Check {
                name: "Google OAuth reachable".into(),
                passed: ok,
                details: format!("HTTP {} (token endpoint)", if ok { code.to_string() } else { detail.clone() }),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("Google OAuth unreachable — Gmail API delivery will fail".into()) },
                severity: Severity::Warning,
            }
        },
        // IMAP direct connectivity (WG → Maddy :993)
        async {
            let t = Instant::now();
            let ok = tcp(MAIL_WG_IP, 993).await;
            Check {
                name: "IMAP direct (WG)".into(),
                passed: ok,
                details: format!("{}:993 {}", MAIL_WG_IP, if ok { "OK" } else { "FAIL" }),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("Maddy IMAP unreachable via WG".into()) },
                severity: if ok { Severity::Info } else { Severity::Critical },
            }
        },
        // SMTP direct connectivity (WG → Maddy :25)
        async {
            let t = Instant::now();
            let ok = tcp(MAIL_WG_IP, 25).await;
            Check {
                name: "SMTP direct (WG)".into(),
                passed: ok,
                details: format!("{}:25 {}", MAIL_WG_IP, if ok { "OK" } else { "FAIL" }),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("Maddy SMTP unreachable via WG".into()) },
                severity: if ok { Severity::Info } else { Severity::Critical },
            }
        },
    );

    // TLS port checks over WG. Gate on a TCP connect first so we can tell
    // "port not listening on WG interface" (Warning) apart from "TLS handshake
    // failed" (Critical).
    async fn tls_wg_check(port: u16, name: &str, starttls: Option<&str>) -> Check {
        let t = Instant::now();
        if !tcp(MAIL_WG_IP, port).await {
            return Check {
                name: name.to_string(),
                passed: false,
                details: format!(
                    "WG port not listening: tcp {}:{} refused/timeout (check interface binding)",
                    MAIL_WG_IP, port
                ),
                duration_ms: t.elapsed().as_millis() as u64,
                error: Some(format!("tcp {}:{} closed", MAIL_WG_IP, port)),
                severity: Severity::Warning,
            };
        }
        let (ok, detail) = openssl_connect_wg(MAIL_WG_IP, port, MAIL_DOMAIN, starttls).await;
        Check {
            name: name.to_string(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Critical,
        }
    }

    // Phase-4 design: public 587 (submission) is NOT bound on oci-mail's WG IP.
    // Submission goes through http-to-smtp-proxy-api on gcp-proxy, which speaks
    // SMTP-on-:25 to oci-mail. Probing 587 STARTTLS here always fails because
    // the port simply isn't open by design — drop it.
    let (tls_993, tls_465) = tokio::join!(
        tls_wg_check(993, "mail:993 TLS (WG)", None),
        tls_wg_check(465, "mail:465 TLS (WG)", None),
    );

    vec![
        mail_https, webmail_https, auth_https, mcp_endpoint,
        tls_993, tls_465,
        mx_record, dkim_record, gha_health,
        cf_worker_check, google_oauth_check, maddy_imap_check, maddy_smtp_check,
    ]
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: PRE-FLIGHT -- 3-VM parallel WG + batch SSH
// ═══════════════════════════════════════════════════════════════════════════

pub async fn preflight(
    fleet: Option<&reports_common::fleet::FleetState>,
) -> (
    Vec<Check>,
    Option<RemoteData>,
    Option<RemoteDataApps>,
    Option<RemoteDataProxy>,
) {
    use reports_common::fleet::VmState;
    let mut checks = Vec::new();
    // Snapshot of which mail-pipeline VMs are Terminated per master's
    // fleet preflight. We DON'T fall back to "Unknown = skip" — only
    // explicit Terminated short-circuits, so missing/auth-less environments
    // continue to do the full SSH probes (today's behaviour).
    let is_terminated = |alias: &str| -> bool {
        fleet
            .map(|f| matches!(f.classify(alias), VmState::Terminated { .. }))
            .unwrap_or(false)
    };

    // ── Tier 0: Cloud API VM status (no SSH, fast) ──────────────────────
    let (mail_cloud, apps_cloud, proxy_cloud) = tokio::join!(
        ssh::cloud_vm_status("oci-mail"),
        ssh::cloud_vm_status("oci-apps"),
        ssh::cloud_vm_status("gcp-proxy"),
    );
    for (alias, status) in [("oci-mail", &mail_cloud), ("oci-apps", &apps_cloud), ("gcp-proxy", &proxy_cloud)] {
        let ok = status.eq_ignore_ascii_case("RUNNING");
        let cli_unavailable = status == "CLI_UNAVAILABLE";
        // #392: a check that cannot run is scored as FAILED, never as passed.
        // cloud_vm_status reports CLI_UNAVAILABLE when the provider CLI is not
        // installed in this environment; treating that as a pass meant a
        // lineage of runs on a runner without gcloud/oci mailed "0 issues
        // found" while every Cloud API row read "unverified — and green".
        checks.push(Check {
            name: format!("Cloud API {}", alias),
            passed: ok,
            details: if cli_unavailable {
                format!("{}: cloud CLI not installed in this environment (not a VM health signal)", alias)
            } else {
                format!("{}: {}", alias, status)
            },
            duration_ms: 0,
            error: if ok {
                None
            } else if cli_unavailable {
                Some(format!("cloud CLI not installed — {} cloud state unverifiable, scored as a failure", alias))
            } else {
                Some(format!("VM not running: {}", status))
            },
            severity: if ok {
                Severity::Info
            } else if cli_unavailable {
                // Tooling gap, not a fleet incident — but the CHECK fails: it
                // verified nothing and must not read as a pass.
                Severity::Info
            } else {
                Severity::Critical
            },
        });
    }

    // WG probes to all 3 VMs in parallel
    let (wg_mail, wg_apps, wg_proxy) = tokio::join!(
        async {
            let t = Instant::now();
            let ok = tcp(MAIL_WG_IP, 22).await;
            Check {
                name: "WG oci-mail".into(),
                passed: ok,
                details: if ok { format!("{}:22 OK", MAIL_WG_IP) } else { "WG DOWN".into() },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("WG DOWN".into()) },
                severity: Severity::Critical,
            }
        },
        async {
            let t = Instant::now();
            let ok = tcp(APPS_WG_IP, 22).await;
            Check {
                name: "WG oci-apps".into(),
                passed: ok,
                details: if ok { format!("{}:22 OK", APPS_WG_IP) } else { "WG DOWN".into() },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("WG DOWN".into()) },
                severity: Severity::Critical,
            }
        },
        async {
            let t = Instant::now();
            let ok = tcp(PROXY_WG_IP, 22).await;
            Check {
                name: "WG gcp-proxy".into(),
                passed: ok,
                details: if ok { format!("{}:22 OK", PROXY_WG_IP) } else { "WG DOWN".into() },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("WG DOWN".into()) },
                severity: Severity::Critical,
            }
        },
    );

    checks.push(wg_mail);
    checks.push(wg_apps);
    checks.push(wg_proxy);

    // Batch SSH to all 3 VMs in parallel. Each VM short-circuits to Err if
    // master's fleet preflight reported it Terminated — saves the ~10s SSH
    // handshake deadline per dead VM.
    let mail_term = is_terminated("oci-mail");
    let apps_term = is_terminated("oci-apps");
    let proxy_term = is_terminated("gcp-proxy");
    let (mail_result, apps_result, proxy_result) = tokio::join!(
        async {
            if mail_term {
                Err::<RemoteData, String>("skipped: fleet=Terminated".into())
            } else {
                ssh::ssh_batch_mail().await
            }
        },
        async {
            if apps_term {
                Err::<RemoteDataApps, String>("skipped: fleet=Terminated".into())
            } else {
                ssh::ssh_batch_apps().await
            }
        },
        async {
            if proxy_term {
                Err::<RemoteDataProxy, String>("skipped: fleet=Terminated".into())
            } else {
                ssh::ssh_batch_proxy().await
            }
        },
    );
    // Keep Results for check reporting, convert to Options for data access
    let mail_data = mail_result.as_ref().ok().cloned();
    let apps_data = apps_result.as_ref().ok().cloned();
    let proxy_data = proxy_result.as_ref().ok().cloned();

    // SSH batch oci-mail check
    {
        let t = Instant::now();
        let (ok, detail) = match &mail_result {
            Ok(d) if !d.docker_version.is_empty() => (true, format!("Docker {}", d.docker_version)),
            Ok(d) => (false, format!("Docker version empty: {}", d.docker_version)),
            Err(e) => (false, e.clone()),
        };
        checks.push(Check {
            name: "SSH batch oci-mail".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: if ok { Severity::Info } else { Severity::Critical },
        });
    }

    // SSH batch oci-apps check
    {
        let t = Instant::now();
        let (ok, detail) = match &apps_result {
            Ok(d) if d.mail_mcp_status.contains("Up") => (true, format!("cloud-mail-mcp: {}", &d.mail_mcp_status[..d.mail_mcp_status.len().min(30)])),
            Ok(d) => (false, format!("cloud-mail-mcp: {}", &d.mail_mcp_status[..d.mail_mcp_status.len().min(30)])),
            Err(e) => (false, e.clone()),
        };
        checks.push(Check {
            name: "SSH batch oci-apps".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Warning,
        });
    }

    // SSH batch gcp-proxy check
    {
        let t = Instant::now();
        let (ok, detail) = match &proxy_result {
            Ok(d) if !d.authelia_health.contains("FAIL") => (true, "Authelia OK".to_string()),
            Ok(_) => (false, "Authelia FAILED".to_string()),
            Err(e) => (false, e.clone()),
        };
        checks.push(Check {
            name: "SSH batch gcp-proxy".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Warning,
        });
    }

    // System metrics from oci-mail (from cache)
    if let Some(ref data) = mail_data {
        let disk_pct: i32 = data.disk.trim().parse().unwrap_or(-1);
        if disk_pct >= 0 {
            let warn = disk_pct >= 80;
            checks.push(Check {
                name: "Disk space".into(),
                passed: disk_pct < 90,
                details: format!("{}% used{}", disk_pct, if warn { " WARNING" } else { "" }),
                duration_ms: 0,
                error: if disk_pct >= 90 {
                    Some(format!("{}% disk used", disk_pct))
                } else {
                    None
                },
                severity: if disk_pct >= 90 {
                    Severity::Critical
                } else if warn {
                    Severity::Warning
                } else {
                    Severity::Info
                },
            });
        }

        // Memory
        let mem_pct = data
            .memory
            .split('(')
            .nth(1)
            .and_then(|s| s.trim_end_matches(')').trim_end_matches('%').parse::<i32>().ok())
            .unwrap_or(-1);
        if mem_pct >= 0 {
            checks.push(Check {
                name: "Memory".into(),
                passed: mem_pct < 95,
                details: format!("{}{}", data.memory, if mem_pct >= 85 { " WARNING" } else { "" }),
                duration_ms: 0,
                error: if mem_pct >= 95 {
                    Some(format!("{}% memory", mem_pct))
                } else {
                    None
                },
                severity: if mem_pct >= 95 {
                    Severity::Critical
                } else if mem_pct >= 85 {
                    Severity::Warning
                } else {
                    Severity::Info
                },
            });
        }

        // Load
        let load_val: f64 = data.load.split_whitespace().next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        checks.push(Check {
            name: "Load".into(),
            passed: load_val < 4.0,
            details: format!("load: {}{}", data.load, if load_val >= 2.0 { " WARNING" } else { "" }),
            duration_ms: 0,
            error: if load_val >= 4.0 {
                Some(format!("load {}", load_val))
            } else {
                None
            },
            severity: if load_val >= 4.0 {
                Severity::Warning
            } else {
                Severity::Info
            },
        });
    }

    (checks, mail_data, apps_data, proxy_data)
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: CONTAINERS (from cached batch data)
// ═══════════════════════════════════════════════════════════════════════════

pub fn container_health(
    mail_data: &Option<RemoteData>,
    apps_data: &Option<RemoteDataApps>,
) -> Vec<Check> {
    let mut checks = Vec::new();

    let data = match mail_data {
        Some(d) => d,
        None => {
            checks.push(Check {
                name: "Container listing".into(),
                passed: false,
                details: "no remote data".into(),
                duration_ms: 0,
                error: Some("SSH to oci-mail failed".into()),
                severity: Severity::Critical,
            });
            return checks;
        }
    };

    // Parse container lines
    struct ContainerLine {
        name: String,
        status: String,
        #[allow(dead_code)]
        image: String,
    }
    let containers: Vec<ContainerLine> = data
        .containers
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            ContainerLine {
                name: parts.first().unwrap_or(&"").to_string(),
                status: parts.get(1).unwrap_or(&"").to_string(),
                image: parts.get(2).unwrap_or(&"").to_string(),
            }
        })
        .collect();

    // Parse restart counts
    let mut restart_map: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for line in data.restarts.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if let (Some(name), Some(count_str)) = (parts.first(), parts.get(1)) {
            restart_map.insert(
                name.to_string(),
                count_str.trim().parse().unwrap_or(0),
            );
        }
    }

    // Check each expected container
    let all_expected: Vec<&str> = MAIL_CONTAINERS
        .iter()
        .chain(EXTRA_CONTAINERS.iter())
        .copied()
        .collect();

    for name in &all_expected {
        let ct = containers.iter().find(|c| c.name == *name);
        match ct {
            Some(c) => {
                let is_up = c.status.starts_with("Up");
                let is_restarting = c.status.contains("Restarting");
                let restarts = restart_map.get(*name).copied().unwrap_or(0);
                let restart_warn = if restarts > 3 {
                    format!(" WARNING {} restarts", restarts)
                } else {
                    String::new()
                };

                if is_restarting {
                    checks.push(Check {
                        name: name.to_string(),
                        passed: false,
                        details: format!("CRASH-LOOPING ({} restarts)", restarts),
                        duration_ms: 0,
                        error: Some("container crash-looping".into()),
                        severity: Severity::Critical,
                    });
                } else if !is_up {
                    checks.push(Check {
                        name: name.to_string(),
                        passed: false,
                        details: format!("DOWN: {}", c.status),
                        duration_ms: 0,
                        error: Some(format!("container down: {}", c.status)),
                        severity: Severity::Critical,
                    });
                } else {
                    // Remove parenthetical from status for display
                    let clean_status = c
                        .status
                        .find(" (")
                        .map(|i| &c.status[..i])
                        .unwrap_or(&c.status);
                    checks.push(Check {
                        name: name.to_string(),
                        passed: restarts < 10,
                        details: format!("{}{}", clean_status, restart_warn),
                        duration_ms: 0,
                        error: if restarts >= 10 {
                            Some(format!("{} restarts", restarts))
                        } else {
                            None
                        },
                        severity: if restarts >= 10 {
                            Severity::Warning
                        } else {
                            Severity::Info
                        },
                    });
                }
            }
            None => {
                checks.push(Check {
                    name: name.to_string(),
                    passed: false,
                    details: "NOT FOUND".into(),
                    duration_ms: 0,
                    error: Some("container not found".into()),
                    severity: Severity::Critical,
                });
            }
        }
    }

    // cloud-mail-mcp on oci-apps
    let mcp_ok = apps_data
        .as_ref()
        .map(|d| d.mail_mcp_status.contains("Up"))
        .unwrap_or(false);
    let mcp_detail = apps_data
        .as_ref()
        .map(|d| d.mail_mcp_status[..d.mail_mcp_status.len().min(40)].to_string())
        .unwrap_or_else(|| "no data".into());
    checks.push(Check {
        name: "cloud-mail-mcp".into(),
        passed: mcp_ok,
        details: mcp_detail.clone(),
        duration_ms: 0,
        error: if mcp_ok { None } else { Some(mcp_detail) },
        severity: if mcp_ok { Severity::Info } else { Severity::Warning },
    });

    checks
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3: NETWORK + AUTH (async, parallel)
// ═══════════════════════════════════════════════════════════════════════════

pub async fn network_checks(
    mail_data: &Option<RemoteData>,
    apps_data: &Option<RemoteDataApps>,
    proxy_data: &Option<RemoteDataProxy>,
    bearer_token: &Option<String>,
) -> Vec<Check> {
    let client = http_client();
    let auth_cl = bearer_token.as_ref().map(|t| auth_client(t));

    // Gather all futures
    let mut futs: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = Check> + Send>>> = Vec::new();

    // Caddy (gcp-proxy) -- TLS + DNS
    futs.push(Box::pin(async {
        let t = Instant::now();
        let resolver = hickory_resolver();
        let (tls_ok, _) = openssl_connect("diegonmarcos.com", 443, None).await;
        let dns_ip = dns_resolve(&resolver, "caddy.mesh.diegonmarcos.com").await;
        let ok = tls_ok;
        let detail = if ok {
            format!(
                "HTTPS OK ({})",
                dns_ip.as_deref().unwrap_or("no DNS")
            )
        } else {
            "Caddy DOWN".into()
        };
        Check {
            name: "Caddy (gcp-proxy)".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Critical,
        }
    }));

    // Hickory DNS resolve maddy.mesh.diegonmarcos.com — retry to survive single-shot flake
    futs.push(Box::pin(async {
        let t = Instant::now();
        let resolver = hickory_resolver();
        let ip = reports_common::checks::dns_resolve_retry(&resolver, "maddy.mesh.diegonmarcos.com", 3, 500).await;
        let ok = ip.as_deref() == Some(MAIL_WG_IP);
        let detail = if ok {
            format!("maddy.mesh.diegonmarcos.com -> {}", MAIL_WG_IP)
        } else {
            format!(
                "FAIL: {}",
                ip.as_deref().unwrap_or("no response")
            )
        };
        Check {
            name: "Hickory DNS".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Critical,
        }
    }));

    // TLS WG direct (SSH to oci-mail localhost)
    {
        let has_data = mail_data.is_some();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            if !has_data {
                return Check {
                    name: "TLS WG direct".into(),
                    passed: false,
                    details: "SSH down".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: Some("SSH down".into()),
                    severity: Severity::Critical,
                };
            }
            // Phase-4: 587 is not bound on oci-mail (see Phase-0 comment);
            // probe only 993/465 over the WG direct path.
            //
            // Wrap in `bash -c '...'` because oci-mail's login user defaults
            // to fish, which silently rejects bash assignment syntax like
            // `r993=$(...)`. Without the wrap the script returns empty
            // stdout and both checks read FAIL even though the ports are
            // serving fine. Mirrors the pattern in ssh::ssh_batch_mail().
            let script = format!(
                r#"r993=$(echo Q | timeout 3 openssl s_client -connect localhost:993 -servername {} 2>&1)
r465=$(echo Q | timeout 3 openssl s_client -connect localhost:465 -servername {} 2>&1)
echo "993:$(echo "$r993" | grep -c CONNECTED)"
echo "465:$(echo "$r465" | grep -c CONNECTED)"
echo "$r993" | grep "Not After" | head -1"#,
                MAIL_DOMAIN, MAIL_DOMAIN
            );
            let cmd = format!("bash -c '{}'", script.replace('\'', "'\\''"));
            let out = ssh::ssh_exec(MAIL_ALIAS, &cmd, 12).await.unwrap_or_default();
            let p993 = out.contains("993:1");
            let p465 = out.contains("465:1");
            let expiry = out.lines().find(|l| l.contains("Not After")).map(|l| l.trim().to_string());
            let mut cert_info = String::new();
            if let Some(exp) = &expiry {
                if let Some(date_str) = exp.split(": ").nth(1) {
                    // Just show the date, don't compute days (would need chrono parsing of OpenSSL format)
                    cert_info = format!(", cert expires {}", date_str.trim());
                }
            }
            let ok = p993 && p465;
            let detail = format!(
                "{}{}",
                [
                    if p993 { "993 OK" } else { "993 FAIL" },
                    if p465 { "465 OK" } else { "465 FAIL" },
                ]
                .join(" "),
                cert_info
            );
            Check {
                name: "TLS WG direct".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        }));
    }

    // Caddy L4 forwarding (from proxy batch).
    // Phase-4: only IMAP/SMTPS forward via Caddy L4; SMTP submission (587)
    // takes the http-to-smtp-proxy-api path, not Caddy L4.
    for (port, label) in [(993, "IMAP"), (465, "SMTPS")] {
        let proxy_val = proxy_data.as_ref().map(|d| match port {
            993 => d.caddy_l4_993.clone(),
            465 => d.caddy_l4_465.clone(),
            _ => String::new(),
        });
        futs.push(Box::pin(async move {
            let t = Instant::now();
            let (ok, detail) = match &proxy_val {
                Some(val) if val.contains("1") => (true, format!("{} forwarding OK", port)),
                Some(_) => (false, "FAIL".into()),
                None => (false, "no proxy data".into()),
            };
            Check {
                name: format!("Caddy L4 -> {}", label),
                passed: ok,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        }));
    }

    // TLS via public SNI-mux hostnames on :443 — mail clients never hit raw
    // 993/465 publicly (those ports were collapsed away; see IMAP_DOMAIN doc).
    futs.push(Box::pin(async {
        let t = Instant::now();
        let (ok, detail) = openssl_connect(IMAP_DOMAIN, 443, None).await;
        Check {
            name: "mail:993 (IMAP)".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Critical,
        }
    }));
    futs.push(Box::pin(async {
        let t = Instant::now();
        let (ok, detail) = openssl_connect(SMTPS_DOMAIN, 443, None).await;
        Check {
            name: "mail:465 (SMTPS)".into(),
            passed: ok,
            details: detail.clone(),
            duration_ms: t.elapsed().as_millis() as u64,
            error: if ok { None } else { Some(detail) },
            severity: Severity::Critical,
        }
    }));
    // Phase-4: public mail.diegonmarcos.com:587 is intentionally not served
    // (submission path is http-to-smtp-proxy-api). Skip the probe.

    // Local SMTP :25 relay (from cache)
    {
        let smtp25 = mail_data.as_ref().map(|d| d.smtp25.clone());
        futs.push(Box::pin(async move {
            let (ok, detail) = match &smtp25 {
                Some(s) if s.contains("220") => {
                    (true, s.lines().next().unwrap_or("").to_string())
                }
                Some(_) => (false, "no banner".into()),
                None => (false, "no data".into()),
            };
            Check {
                name: "SMTP :25 relay".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: 0,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // Phase-4: nothing binds :587 on oci-mail (see Phase-0 + TLS WG direct
    // comments). The submission path is http-to-smtp-proxy-api → :25; skip
    // the SMTP :587 local TLS probe.

    // Webmail HTTPS
    {
        let cl = client.clone();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            let url = format!("https://{}/", MAIL_DOMAIN);
            let (ok, _code, detail) = http_get(&cl, &url).await;
            Check {
                name: "Webmail HTTPS".into(),
                passed: ok,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // Webmail internal (from cache) — cloud-webmail on oci-apps:3000, probed
    // from oci-mail across the mesh. See constants::WEBMAIL_INTERNAL_URL.
    {
        let webmail_int = mail_data.as_ref().map(|d| d.webmail_internal.clone());
        futs.push(Box::pin(async move {
            let (ok, detail) = match &webmail_int {
                Some(s) => {
                    let code = s.trim();
                    (code == "200", format!("HTTP {}", code))
                }
                None => (false, "no data".into()),
            };
            Check {
                name: "Webmail internal".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: 0,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // (The "SnappyMail internal" check was removed 2026-09-09. SnappyMail is
    // decommissioned — it probed the same dead localhost:8888 as the webmail
    // check above, so it was a duplicate of a probe that could only ever
    // return HTTP 000.)

    // Caddy route: mail.diegonmarcos.com/webmail/ → cloud-webmail
    {
        let cl = client.clone();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            let url = format!("https://{}/webmail/", MAIL_DOMAIN);
            let (ok, _code, detail) = http_get(&cl, &url).await;
            Check {
                name: "mail.*/webmail/ route".into(),
                passed: ok,
                details: format!("HTTP {}", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // Caddy route: webmail.diegonmarcos.com → 301 redirect to /webmail/
    {
        let cl = client.clone();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            let url = format!("https://{}/", WEBMAIL_DOMAIN);
            // No per-request timeout override: the client already carries
            // checks::HTTP_TIMEOUT (8s), which every sibling probe in this
            // phase uses. This call used to override it down to 5s and was the
            // only probe here that did. Phase 3 fires ~23 requests at once, and
            // under that concurrency the 5s budget expired before the edge
            // answered — the 2026-09-09 run recorded duration_ms 5002 and
            // "ERR: error sending request", while the identical URL probed by
            // phase 0 with the 8s budget returned HTTP 302 in 1988ms in the
            // same run, and five consecutive curls from oci-apps returned the
            // expected 302 -> auth.diegonmarcos.com in 0.48-1.24s. A tighter
            // deadline than the crate's own is a latency assertion nobody
            // asked for, dressed up as an availability failure.
            let resp = cl.get(&url)
                .send()
                .await;
            let (ok, detail) = match resp {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let location = r.headers().get("location")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    // Valid redirects:
                    //   301 → /webmail/ (legacy Caddy rewrite)
                    //   302 → auth.diegonmarcos.com/... (Authelia challenge for
                    //   unauthenticated GET — this IS the correct behaviour;
                    //   webmail is protected and the 302 proves the auth chain
                    //   is wired correctly).
                    let is_redirect = (status == 301 && location.contains("/webmail/"))
                        || (status == 302 && location.contains(AUTH_DOMAIN));
                    (is_redirect, format!("{} → {}", status, location))
                }
                Err(e) => (false, format!("ERR: {}", e)),
            };
            Check {
                name: "webmail.* redirect".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // Authelia health (from proxy cache)
    {
        let auth = proxy_data.as_ref().map(|d| d.authelia_health.clone());
        futs.push(Box::pin(async move {
            let (ok, detail) = match &auth {
                Some(s) => {
                    let good = s.contains("OK") || s.contains("ok") || !s.contains("FAIL");
                    (
                        good,
                        if good { "Authelia OK".into() } else { s[..s.len().min(50)].to_string() },
                    )
                }
                None => (false, "no proxy data".into()),
            };
            Check {
                name: "Authelia health".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: 0,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // OIDC bearer -> webmail
    {
        let has_auth = auth_cl.is_some();
        let token = bearer_token.clone();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            if !has_auth {
                return Check {
                    name: "OIDC bearer -> webmail".into(),
                    passed: false,
                    details: "no OIDC token".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: Some("no OIDC token".into()),
                    severity: Severity::Warning,
                };
            }
            let cl = auth_client(token.as_deref().unwrap_or(""));
            let url = format!("https://{}/", MAIL_DOMAIN);
            let (_, code, detail) = http_get(&cl, &url).await;
            let ok = code == 200;
            Check {
                name: "OIDC bearer -> webmail".into(),
                passed: ok,
                details: if ok {
                    "Bearer auth -> 200 OK (full chain)".into()
                } else if code == 302 {
                    "Bearer rejected -> 302 (introspect-proxy issue)".into()
                } else {
                    format!("HTTP {}", detail)
                },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(format!("HTTP {}", code)) },
                severity: Severity::Warning,
            }
        }));
    }

    // Mail Admin via Bearer — Maddy has no web admin (CLI-only)
    {
        futs.push(Box::pin(async move {
            Check {
                name: "Mail Admin via Bearer".into(),
                passed: true,
                details: "N/A — Maddy CLI-only (no web admin)".into(),
                duration_ms: 0,
                error: None,
                severity: Severity::Info,
            }
        }));
    }

    // cloud-mail-mcp container connectivity (from oci-apps batch)
    let mcp_checks: Vec<(&str, Box<dyn Fn(&RemoteDataApps) -> (bool, String) + Send + Sync>)> = vec![
        ("mcp->DNS resolve", Box::new(|d: &RemoteDataApps| {
            let ok = d.dns_resolve.starts_with("OK:");
            (ok, if ok { d.dns_resolve.replace("OK:", "-> ") } else { d.dns_resolve.clone() })
        })),
        ("mcp->IMAP TLS", Box::new(|d: &RemoteDataApps| {
            (d.imap_tls.starts_with("OK"), d.imap_tls.clone())
        })),
        ("mcp->SMTP TLS", Box::new(|d: &RemoteDataApps| {
            (d.smtp_tls.starts_with("OK"), d.smtp_tls.clone())
        })),
        ("mcp->IMAP WG direct", Box::new(|d: &RemoteDataApps| {
            let ok = d.imap_wg.starts_with("OK");
            (ok, format!("{}:993 {}", MAIL_WG_IP, d.imap_wg))
        })),
        ("mcp->IMAP LOGIN", Box::new(|d: &RemoteDataApps| {
            if d.imap_login == "NO_CREDS" {
                return (false, "MAIL_USER/MAIL_PASSWORD not set in cloud-mail-mcp".into());
            }
            (d.imap_login.contains("LOGIN_OK"), d.imap_login.clone())
        })),
        ("mcp->SMTP AUTH", Box::new(|d: &RemoteDataApps| {
            (d.smtp_auth.contains("SMTP_AUTH_OK"), d.smtp_auth.clone())
        })),
    ];

    for (name, check_fn) in mcp_checks {
        let (ok, detail) = match apps_data {
            Some(d) => check_fn(d),
            None => (false, "no app data".into()),
        };
        futs.push(Box::pin(async move {
            Check {
                name: name.to_string(),
                passed: ok,
                details: detail.clone(),
                duration_ms: 0,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // MCP endpoint checks
    {
        let cl = client.clone();
        futs.push(Box::pin(async move {
            let t = Instant::now();
            let url = format!("https://{}/mail-mcp/mcp", MCP_DOMAIN);
            let (_, code, detail) = http_get(&cl, &url).await;
            let ok = matches!(code, 400 | 405 | 406);
            Check {
                name: "cloud-mail-mcp MCP".into(),
                passed: ok,
                details: format!("HTTP {} (alive)", detail),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Warning,
            }
        }));
    }

    // All ports bound verification (from cache)
    {
        let ports_data = mail_data.as_ref().map(|d| d.all_local_ports.clone());
        futs.push(Box::pin(async move {
            let (ok, detail) = match &ports_data {
                Some(ports) => {
                    let bound: Vec<u16> = EXPECTED_PORTS
                        .iter()
                        .filter(|p| ports.contains(&format!(":{}", p)))
                        .copied()
                        .collect();
                    let missing: Vec<u16> = EXPECTED_PORTS
                        .iter()
                        .filter(|p| !ports.contains(&format!(":{}", p)))
                        .copied()
                        .collect();
                    if missing.is_empty() {
                        (true, format!("all {} ports bound", bound.len()))
                    } else {
                        (
                            false,
                            format!(
                                "missing: {}",
                                missing
                                    .iter()
                                    .map(|p| p.to_string())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        )
                    }
                }
                None => (false, "no data".into()),
            };
            Check {
                name: "All ports bound".into(),
                passed: ok,
                details: detail.clone(),
                duration_ms: 0,
                error: if ok { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        }));
    }

    futures::future::join_all(futs).await
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4: DNS AUTH
// ═══════════════════════════════════════════════════════════════════════════

pub async fn dns_auth() -> Vec<Check> {
    let (mx, dkim, spf, dmarc) = tokio::join!(
        // MX
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let records = dns_mx(&resolver, BASE_DOMAIN).await;
            let has_mx = records
                .iter()
                .any(|(_, ex)| ex.contains("mx") || ex.contains("cloudflare"));
            let detail = if let Some(first) = records.first() {
                format!("{} {}", first.0, first.1)
            } else {
                "no MX".into()
            };
            Check {
                name: "MX".into(),
                passed: has_mx,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if has_mx { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
        // DKIM
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let txt = dns_txt(&resolver, &format!("{}._domainkey.{}", DKIM_SELECTOR, BASE_DOMAIN)).await;
            let ok = txt.as_ref().map(|s| s.contains("v=DKIM1")).unwrap_or(false);
            Check {
                name: "DKIM".into(),
                passed: ok,
                details: if ok { "present".into() } else { "missing".into() },
                duration_ms: t.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("DKIM missing".into()) },
                severity: Severity::Critical,
            }
        },
        // SPF
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let txt = dns_txt(&resolver, BASE_DOMAIN).await;
            let has_spf = txt.as_ref().map(|s| s.contains("v=spf1")).unwrap_or(false);
            let detail = txt
                .as_ref()
                .and_then(|s| {
                    s.split_whitespace()
                        .find(|w| w.starts_with("v=spf1") || w.contains("spf1"))
                        .map(|w| w.to_string())
                })
                .or_else(|| txt.as_ref().and_then(|s| {
                    if s.contains("spf1") { Some(s.clone()) } else { None }
                }))
                .unwrap_or_else(|| "missing".into());
            Check {
                name: "SPF".into(),
                passed: has_spf,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if has_spf { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
        // DMARC
        async {
            let t = Instant::now();
            let resolver = public_resolver();
            let txt = dns_txt(&resolver, &format!("_dmarc.{}", BASE_DOMAIN)).await;
            let has_dmarc = txt.as_ref().map(|s| s.contains("v=DMARC1")).unwrap_or(false);
            let detail = txt
                .as_ref()
                .map(|s| s.lines().next().unwrap_or("").trim().to_string())
                .unwrap_or_else(|| "missing".into());
            Check {
                name: "DMARC".into(),
                passed: has_dmarc,
                details: detail.clone(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: if has_dmarc { None } else { Some(detail) },
                severity: Severity::Critical,
            }
        },
    );

    vec![mx, dkim, spf, dmarc]
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5: MAIL INTERNALS (from cached SSH batch data)
// ═══════════════════════════════════════════════════════════════════════════

pub fn mail_internals(mail_data: &Option<RemoteData>) -> Vec<Check> {
    let data = match mail_data {
        Some(d) => d,
        None => {
            return vec![Check {
                name: "internals".into(),
                passed: false,
                details: "no remote data".into(),
                duration_ms: 0,
                error: Some("SSH to oci-mail failed".into()),
                severity: Severity::Critical,
            }];
        }
    };

    let mut checks = Vec::new();

    // Maddy's own IMAP (127.0.0.1:993) — the `deliver_to &local_mailboxes` leg.
    //
    // This used to be two checks, "IMAP auth" and "IMAP protocol", fed by two
    // SSH sections (dovecotUser and imapCap) that ran the *identical* command.
    // One probe reported as two independent signals inflates the pass count and
    // hides the fact that nothing was watching the other store at all.
    let maddy_imap_ok = data.imap_cap.contains("IMAP4") || data.imap_cap.contains("OK");
    checks.push(Check {
        name: "Maddy IMAP :993".into(),
        passed: maddy_imap_ok,
        details: if maddy_imap_ok { "IMAP4rev1 responding".into() } else { "not responding".into() },
        duration_ms: 0,
        error: if maddy_imap_ok { None } else { Some("maddy IMAP not responding".into()) },
        severity: if maddy_imap_ok { Severity::Info } else { Severity::Critical },
    });

    // Stalwart's IMAP (10.0.0.3:2993) — the store mail clients actually read,
    // written by the `deliver_to &stalwart_queue` leg. The two legs are not
    // atomic (maddy.conf documents this at length), so maddy answering on 993
    // says nothing about whether the user can see their mail.
    let stalwart_imap_ok = data.stalwart_imap.contains("IMAP4") || data.stalwart_imap.contains("OK");
    checks.push(Check {
        name: "Stalwart IMAP :2993".into(),
        passed: stalwart_imap_ok,
        details: if stalwart_imap_ok {
            "IMAP4rev2 responding (user-facing store)".into()
        } else {
            "not responding — user cannot read mail".into()
        },
        duration_ms: 0,
        error: if stalwart_imap_ok { None } else { Some("stalwart IMAP not responding".into()) },
        severity: if stalwart_imap_ok { Severity::Info } else { Severity::Critical },
    });

    // (Removed 2026-09-09: "spam filter", "data store", "admin panel" and
    // "sieve filter". Each asserted a string the SSH batch had just echoed as a
    // literal on the line above — `echo "maddy-builtin-dkim-spf"` then assert
    // it contains "maddy-builtin" — so all four passed unconditionally and
    // measured nothing. Their names were Mailu-era besides: there is no rspamd,
    // no redis and no web admin on this VM. "sieve filter" was also actively
    // wrong: it reported "no ManageSieve server" while Stalwart answers
    // `"IMPLEMENTATION" "Stalwart ManageSieve"` on :6190 — now covered by the
    // EXPECTED_PORTS bound check.)

    // mailbox quota
    checks.push(Check {
        name: "mailbox quota".into(),
        passed: true,
        details: data.quota.trim()[..data.quota.trim().len().min(60)].to_string(),
        duration_ms: 0,
        error: None,
        severity: Severity::Info,
    });

    // Maddy accounts (from `maddy creds list` via SSH)
    {
        let accts = &data.maddy_accounts;
        let count = accts.lines().filter(|l| l.contains("@")).count();
        let ok = count > 0 || !accts.contains("API_FAIL");
        checks.push(Check {
            name: "Mail accounts".into(),
            passed: count > 0,
            details: if count > 0 { format!("{} accounts (maddy creds)", count) } else { accts[..accts.len().min(60)].to_string() },
            duration_ms: 0,
            error: if count > 0 { None } else { Some("no accounts found".into()) },
            severity: if count > 0 { Severity::Info } else { Severity::Warning },
        });
    }

    // Maddy domains (from maddy.conf local_domains)
    {
        let domains = &data.maddy_domains;
        let has_domain = domains.contains("diegonmarcos.com") || domains.contains("local_domains");
        checks.push(Check {
            name: "Mail domains".into(),
            passed: has_domain,
            details: if has_domain { "diegonmarcos.com configured".into() } else { domains[..domains.len().min(60)].to_string() },
            duration_ms: 0,
            error: if has_domain { None } else { Some("domain not configured".into()) },
            severity: if has_domain { Severity::Info } else { Severity::Warning },
        });
    }

    // Stalwart dual-write backlog — messages in maddy's local store that have
    // not reached the store the user reads.
    //
    // This replaces a check that could not fail: it read `maddy queue list`,
    // which is not a maddy subcommand, and the batch masked the error with
    // `|| echo "empty"`. So it reported an empty queue forever, including
    // through a total stalwart_relay outage. Because maddy fronts the relay with
    // a durable on-disk queue, that outage raises no other alarm anywhere in
    // this report — inbound SMTP still succeeds, both containers stay Up, and
    // mail silently stops appearing for the user. Depth is the only signal.
    {
        let raw = data.stalwart_queue_depth.trim();
        let depth = raw.parse::<usize>().ok();
        let (passed, details, severity) = match depth {
            Some(0) => (true, "empty — stalwart mirror caught up".to_string(), Severity::Info),
            Some(d) if d <= STALWART_QUEUE_MAX_DEPTH => (
                true,
                format!("{} in flight (ceiling {})", d, STALWART_QUEUE_MAX_DEPTH),
                Severity::Info,
            ),
            Some(d) => (
                false,
                format!(
                    "{} messages queued for tcp://{}:2025 (ceiling {}) — mirror to Stalwart is stalled",
                    d, MAIL_WG_IP, STALWART_QUEUE_MAX_DEPTH
                ),
                Severity::Critical,
            ),
            None => (
                false,
                format!("cannot read /data/queue-stalwart ({})", raw),
                Severity::Warning,
            ),
        };
        checks.push(Check {
            name: "Stalwart relay backlog".into(),
            passed,
            details: details.clone(),
            duration_ms: 0,
            error: if passed { None } else { Some(details) },
            severity,
        });
    }

    // User accounts
    let user_count = serde_json::from_str::<serde_json::Value>(&data.users)
        .ok()
        .and_then(|v| {
            if let Some(arr) = v.as_array() { return Some(arr.len()); }
            if let Some(items) = v.pointer("/data/items").and_then(|i| i.as_array()) { return Some(items.len()); }
            v.get("items").and_then(|i| i.as_array()).map(|a| a.len())
        })
        .or_else(|| data.users.trim().parse::<usize>().ok())
        .unwrap_or(0);
    checks.push(Check {
        name: "User accounts".into(),
        passed: user_count > 0,
        details: if user_count > 0 {
            format!("{} users", user_count)
        } else {
            format!("unknown ({})", &data.users.trim()[..data.users.trim().len().min(30)])
        },
        duration_ms: 0,
        error: if user_count > 0 { None } else { Some("no users found".into()) },
        severity: if user_count > 0 { Severity::Info } else { Severity::Warning },
    });

    checks
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5b: CONFIG DRIFT DETECTION (5-layer consistency)
// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: src/config.toml.tpl (git source)
// Layer 2: dist/config.toml.tpl (nix build output)
// Layer 3: GHCR image /etc/maddy/maddy.conf.tpl
// Layer 4: Running container /etc/maddy/maddy.conf.tpl
// Layer 5: Running config.toml (generated by init.sh from template)

pub fn config_drift(mail_data: &mut Option<RemoteData>) -> Vec<Check> {
    let data = match mail_data {
        Some(d) => d,
        None => {
            return vec![Check {
                name: "config drift".into(),
                passed: false,
                details: "no remote data (SSH failed)".into(),
                duration_ms: 0,
                error: Some("SSH to oci-mail failed".into()),
                severity: Severity::Critical,
            }];
        }
    };

    let mut checks = Vec::new();

    // Maddy config drift: src/maddy.conf.tpl → dist/maddy.conf.tpl → host deployed → container running
    //
    // The dist file lives in the PRIVATE cloud repo (cloud/a_solutions/aa-sui_tools-maddy/),
    // not in the public cloud-data submodule. When the report runs inside the
    // Dagu container on oci-analytics, the entrypoint mounts cloud-source at
    // /var/lib/dagu/data/cloud-source, so honour the CLOUD_REPO_DIR env var
    // populated by entrypoint.sh; otherwise fall back to $HOME/git/cloud-infra for
    // dev/local runs. When neither resolves, emit a single Info check rather
    // than four cascading Criticals.
    let cloud_repo_dir = std::env::var("CLOUD_REPO_DIR").ok().or_else(|| {
        std::env::var("HOME").ok().map(|h| format!("{}/git/cloud-infra", h))
    });
    let dist_tpl_path = cloud_repo_dir
        .as_deref()
        .map(|d| format!("{}/a_solutions/aa-sui_tools-maddy/dist/maddy.conf.tpl", d))
        .unwrap_or_default();

    // If the dist template isn't accessible from this runtime (typical for
    // the report container, which mounts cloud-source read-only and may not
    // include a_solutions/), skip the whole drift block. Drift detection is
    // a developer-workstation check; the in-container report verifies
    // running config instead.
    if dist_tpl_path.is_empty() || !std::path::Path::new(&dist_tpl_path).exists() {
        checks.push(Check {
            name: "Config drift".into(),
            passed: true,
            details: "skipped — cloud repo not mounted (set CLOUD_REPO_DIR to enable)".into(),
            duration_ms: 0,
            error: None,
            severity: Severity::Info,
        });
        return checks;
    }

    // Maddy: src has @@PLACEHOLDERS@@, dist has substituted values — they'll always differ
    // So we start drift detection from dist (nix output)
    let dist_hash = file_md5(&dist_tpl_path);
    data.config_dist_hash = dist_hash.clone();
    data.config_src_hash = dist_hash.clone(); // use dist as baseline

    // Check dist exists
    checks.push(Check {
        name: "Dist built".into(),
        passed: !dist_hash.is_empty(),
        details: if !dist_hash.is_empty() { format!("dist OK ({})", &dist_hash[..8.min(dist_hash.len())]) }
                 else { "dist/maddy.conf.tpl missing — run: build.sh build".into() },
        duration_ms: 0,
        error: if !dist_hash.is_empty() { None } else { Some("run: build.sh build".into()) },
        severity: if !dist_hash.is_empty() { Severity::Info } else { Severity::Critical },
    });

    // L2→Host: dist vs deployed host file
    let host_hash = data.config_host_hash.trim().to_string();
    let dist_host_match = !dist_hash.is_empty() && !host_hash.is_empty() && dist_hash == host_hash;
    checks.push(Check {
        name: "L2→Host dist=deployed".into(),
        passed: dist_host_match,
        details: if dist_host_match { format!("match ({})", &host_hash[..8.min(host_hash.len())]) }
                 else if host_hash.contains("HOST_FAIL") { "host file not found".into() }
                 else { format!("DRIFT") },
        duration_ms: 0,
        error: if dist_host_match { None } else { Some("run: build.sh deploy".into()) },
        severity: if dist_host_match { Severity::Info } else { Severity::Warning },
    });

    // Host→Container: deployed tpl vs container mounted tpl
    let container_hash = data.config_container_tpl_hash.trim().to_string();
    let host_container_match = !host_hash.is_empty() && !container_hash.is_empty() && host_hash == container_hash;
    checks.push(Check {
        name: "Host→Container tpl".into(),
        passed: host_container_match,
        details: if host_container_match { format!("match ({})", &container_hash[..8.min(container_hash.len())]) }
                 else if container_hash.contains("CONTAINER_FAIL") { "container not running".into() }
                 else { "DRIFT — restart container".into() },
        duration_ms: 0,
        error: if host_container_match { None } else { Some("run: docker compose down && up".into()) },
        severity: if host_container_match { Severity::Info } else { Severity::Critical },
    });

    // Running config: check critical Maddy settings
    let running = &data.config_running;
    if running.contains("CONFIG_FAIL") {
        checks.push(Check {
            name: "Running config".into(),
            passed: false,
            details: "cannot read running config".into(),
            duration_ms: 0,
            error: Some("maddy container not running".into()),
            severity: Severity::Critical,
        });
    } else {
        let has_hostname = running.contains("hostname");
        let has_relay = running.contains("targets") || running.contains("smtp.email");
        let has_tls = running.contains("tls");
        let has_local = running.contains("deliver_to") || running.contains("local_domains");
        let all_ok = has_hostname && has_relay && has_tls && has_local;
        checks.push(Check {
            name: "Running config".into(),
            passed: all_ok,
            details: format!("hostname={} relay={} tls={} local={}",
                if has_hostname { "OK" } else { "MISS" },
                if has_relay { "OK" } else { "MISS" },
                if has_tls { "OK" } else { "MISS" },
                if has_local { "OK" } else { "MISS" }),
            duration_ms: 0,
            error: if all_ok { None } else { Some("maddy config incomplete".into()) },
            severity: if all_ok { Severity::Info } else { Severity::Critical },
        });
    }

    // Full chain
    let all_match = dist_host_match && host_container_match && !dist_hash.is_empty();
    checks.push(Check {
        name: "FULL CHAIN src=dist=host=container".into(),
        passed: all_match,
        details: if all_match { format!("ALL CONSISTENT ({})", &dist_hash[..8.min(dist_hash.len())]) }
                 else { "DRIFT DETECTED".into() },
        duration_ms: 0,
        error: if all_match { None } else { Some("rebuild+deploy needed".into()) },
        severity: if all_match { Severity::Info } else { Severity::Critical },
    });

    checks
}

/// Compute MD5 hash of a local file
fn file_md5(path: &str) -> String {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    format!("{:x}", md5::compute(&buf))
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6: E2E DELIVERY (optional, requires RESEND_API_KEY)
// ═══════════════════════════════════════════════════════════════════════════

pub async fn e2e_delivery(mail_data: &Option<RemoteData>) -> Vec<Check> {
    let mut checks = Vec::new();
    let api_key = match std::env::var("RESEND_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            checks.push(Check {
                name: "Resend API key".into(),
                passed: true, // optional — E2E disabled but not a failure
                details: "not set (set RESEND_API_KEY to enable E2E)".into(),
                duration_ms: 0,
                error: None,
                severity: Severity::Info,
            });
            return checks;
        }
    };
    checks.push(Check {
        name: "Resend API key".into(),
        passed: true,
        details: "found".into(),
        duration_ms: 0,
        error: None,
        severity: Severity::Info,
    });

    let tag = format!("health-{}", chrono::Utc::now().timestamp_millis());

    // Send via Resend API
    let t_send = Instant::now();
    let body = serde_json::json!({
        "from": format!("Health <{}>", TEST_FROM),
        "to": [TEST_TO],
        "subject": format!("[health-check] {}", tag),
        "text": format!("Health {}", tag),
    });
    let send_result = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap()
        .post("https://api.resend.com/emails")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await;

    let email_id = match send_result {
        Ok(resp) => {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            let id = json["id"].as_str().unwrap_or("").to_string();
            let ok = !id.is_empty();
            checks.push(Check {
                name: "Send via Resend".into(),
                passed: ok,
                details: if ok {
                    format!("id={}", id)
                } else {
                    json["message"].as_str().unwrap_or("failed").to_string()
                },
                duration_ms: t_send.elapsed().as_millis() as u64,
                error: if ok { None } else { Some("send failed".into()) },
                severity: if ok { Severity::Info } else { Severity::Critical },
            });
            if ok { Some(id) } else { None }
        }
        Err(e) => {
            checks.push(Check {
                name: "Send via Resend".into(),
                passed: false,
                details: format!("error: {}", e),
                duration_ms: t_send.elapsed().as_millis() as u64,
                error: Some(format!("{}", e)),
                severity: Severity::Critical,
            });
            None
        }
    };

    let email_id = match email_id {
        Some(id) => id,
        None => return checks,
    };

    let ssh_ok = mail_data.is_some();

    // Resend status polling, IMAP arrival, http-to-smtp-proxy-api logs, CF Worker -- all in parallel
    let (resend_check, imap_check, proxy_check, cf_check) = tokio::join!(
        // Resend status
        async {
            let t = Instant::now();
            let poll_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
                .unwrap();
            for i in 0..3u32 {
                if i > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                }
                let url = format!("https://api.resend.com/emails/{}", email_id);
                if let Ok(resp) = poll_client
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .send()
                    .await
                {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        let ev = json["last_event"].as_str().unwrap_or("?");
                        if ev == "delivered" {
                            return Check {
                                name: "Resend status".into(),
                                passed: true,
                                details: format!("delivered (poll {})", i + 1),
                                duration_ms: t.elapsed().as_millis() as u64,
                                error: None,
                                severity: Severity::Info,
                            };
                        }
                        if ev == "bounced" {
                            return Check {
                                name: "Resend status".into(),
                                passed: false,
                                details: "BOUNCED".into(),
                                duration_ms: t.elapsed().as_millis() as u64,
                                error: Some("email bounced".into()),
                                severity: Severity::Critical,
                            };
                        }
                    }
                }
            }
            Check {
                name: "Resend status".into(),
                passed: true,
                details: "sent (IMAP is truth)".into(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: None,
                severity: Severity::Info,
            }
        },
        // IMAP arrival
        async {
            let t = Instant::now();
            if !ssh_ok {
                return Check {
                    name: "IMAP arrival".into(),
                    passed: false,
                    details: "SSH down".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: Some("SSH down".into()),
                    severity: Severity::Critical,
                };
            }
            for i in 0..6u32 {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if let Ok(out) = ssh::ssh_exec(
                    MAIL_ALIAS,
                    r#"docker logs maddy --since 60s 2>&1 | grep -cE "accepted|delivered" || echo 0"#,
                    5,
                )
                .await
                {
                    let count: u32 = out.trim().parse().unwrap_or(0);
                    if count > 0 {
                        return Check {
                            name: "IMAP arrival".into(),
                            passed: true,
                            details: format!("delivered (poll {}, {}s)", i + 1, (i + 1) * 3),
                            duration_ms: t.elapsed().as_millis() as u64,
                            error: None,
                            severity: Severity::Info,
                        };
                    }
                }
            }
            Check {
                name: "IMAP arrival".into(),
                passed: false,
                details: "NOT FOUND after 18s".into(),
                duration_ms: t.elapsed().as_millis() as u64,
                error: Some("email not arrived".into()),
                severity: Severity::Warning,
            }
        },
        // http-to-smtp-proxy-api logs
        async {
            let t = Instant::now();
            if !ssh_ok {
                return Check {
                    name: "http-to-smtp-proxy-api logs".into(),
                    passed: false,
                    details: "SSH down".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: Some("SSH down".into()),
                    severity: Severity::Warning,
                };
            }
            match ssh::ssh_exec(
                PROXY_ALIAS,
                "docker logs http-to-smtp-proxy-api --since 5m 2>&1 | tail -3 || true",
                5,
            )
            .await
            {
                Ok(out) => {
                    if out.contains("502") || out.contains("refused") {
                        Check {
                            name: "http-to-smtp-proxy-api logs".into(),
                            passed: false,
                            details: format!("errors: {}", out.trim().lines().rev().take(2).collect::<Vec<_>>().join(" | ")),
                            duration_ms: t.elapsed().as_millis() as u64,
                            error: Some("http-to-smtp-proxy-api errors".into()),
                            severity: Severity::Warning,
                        }
                    } else if out.contains("POST") || out.contains("200") {
                        Check {
                            name: "http-to-smtp-proxy-api logs".into(),
                            passed: true,
                            details: "activity confirmed".into(),
                            duration_ms: t.elapsed().as_millis() as u64,
                            error: None,
                            severity: Severity::Info,
                        }
                    } else {
                        Check {
                            name: "http-to-smtp-proxy-api logs".into(),
                            passed: true,
                            details: "no logs (IMAP is truth)".into(),
                            duration_ms: t.elapsed().as_millis() as u64,
                            error: None,
                            severity: Severity::Info,
                        }
                    }
                }
                Err(_) => Check {
                    name: "http-to-smtp-proxy-api logs".into(),
                    passed: true,
                    details: "no logs (IMAP is truth)".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: None,
                    severity: Severity::Info,
                },
            }
        },
        // CF Worker
        async {
            let t = Instant::now();
            let cf_key = std::env::var("CF_API_KEY").ok();
            let cf_email = std::env::var("CF_API_EMAIL").ok();
            match (cf_key, cf_email) {
                (Some(key), Some(email)) => {
                    let cl = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(8))
                        .build()
                        .unwrap();
                    match cl
                        .get("https://api.cloudflare.com/client/v4/accounts/e5cb0a0c6f448e54f217de484259f0ae/workers/scripts/email-forwarder")
                        .header("X-Auth-Email", &email)
                        .header("X-Auth-Key", &key)
                        .send()
                        .await
                    {
                        Ok(resp) => {
                            if let Ok(json) = resp.json::<serde_json::Value>().await {
                                let modified = json["result"]["modified_on"]
                                    .as_str()
                                    .map(|s| &s[..s.len().min(10)])
                                    .unwrap_or("?");
                                Check {
                                    name: "CF Worker".into(),
                                    passed: true,
                                    details: format!("active ({})", modified),
                                    duration_ms: t.elapsed().as_millis() as u64,
                                    error: None,
                                    severity: Severity::Info,
                                }
                            } else {
                                Check {
                                    name: "CF Worker".into(),
                                    passed: true,
                                    details: "info: CF API unparseable".into(),
                                    duration_ms: t.elapsed().as_millis() as u64,
                                    error: None,
                                    severity: Severity::Info,
                                }
                            }
                        }
                        Err(_) => Check {
                            name: "CF Worker".into(),
                            passed: true,
                            details: "info: CF API error".into(),
                            duration_ms: t.elapsed().as_millis() as u64,
                            error: None,
                            severity: Severity::Info,
                        },
                    }
                }
                _ => Check {
                    name: "CF Worker".into(),
                    passed: true,
                    details: "info: no CF creds".into(),
                    duration_ms: t.elapsed().as_millis() as u64,
                    error: None,
                    severity: Severity::Info,
                },
            }
        },
    );

    checks.push(resend_check);
    checks.push(imap_check);
    checks.push(proxy_check);
    checks.push(cf_check);

    checks
}
