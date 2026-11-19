use crate::constants::*;
use crate::types::*;
use anyhow::Result;
use std::time::Duration;
use tokio::time::timeout;

#[allow(dead_code)]
const SSH_TIMEOUT: Duration = Duration::from_secs(10);

/// SSH args with mux support + keepalive that tolerates the mesh's idle gaps.
///
/// The batch is silent for minutes at a time (docker runs, openssl handshakes)
/// while the connect stays real, and the old ServerAliveCountMax=2 meant any
/// blip longer than 30s (NAT expiry, a WireGuard rekey, a congested mesh hop)
/// dropped the session with `client_loop: send disconnect: Broken pipe`,
/// killing the whole liveness report — #398. 12 unacknowledged probes at 15s
/// apart tolerates ~3 minutes of silence, matching the hardened options
/// cloud-infra applies to its own mail-health SSH calls (see
/// 9_others/mail-health-diagnosis.json in that repo).
fn ssh_args(alias: &str, cmd: &str) -> Vec<String> {
    // NOTE: Some VMs (notably oci-mail) default the login shell to fish,
    // which rejects bash idioms like `r993=$(...)`. Sites that depend on
    // bash syntax must wrap the command themselves with
    // `format!("bash -c '{}'", cmd.replace('\'', "'\\''"))` before calling
    // ssh_exec — see ssh_batch_mail() for the canonical pattern. We
    // intentionally DO NOT wrap here because ssh_batch_mail() already
    // wraps and a second wrap at this layer double-escapes single quotes
    // (breaking the batch's docker --format '{{...}}' tokens) and causes
    // bash to exit non-zero, which ssh.rs then surfaces as a spurious
    // "SSH to X failed" error.
    vec![
        "-o".into(),
        "ConnectTimeout=5".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=12".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        "ControlPath=/tmp/cloud-mail-mux-%h".into(),
        "-o".into(),
        "ControlPersist=30".into(),
        alias.into(),
        cmd.into(),
    ]
}

/// Single SSH attempt — no retry, no failure-diagnostic escalation. Returns
/// Ok(stdout) on success; Err(reason) on any failure (timeout, connection
/// error, non-zero exit) so the caller can decide whether to retry.
async fn ssh_exec_once(vm_alias: &str, command: &str, timeout_secs: u64) -> std::result::Result<String, String> {
    ssh_exec_once_with(vm_alias, command, timeout_secs, ssh_args(vm_alias, command)).await
}

/// One SSH attempt on a FRESH connection with multiplexing disabled. A broken
/// session's fault almost always lives in the stale ControlMaster socket
/// (`read failed: Broken pipe` on the mux): retrying through the same socket
/// reproduces the same fault, so a broken pipe is taken here instead —
/// ControlPath=none makes OpenSSH start a new connection rather than reuse the
/// dead master (#398).
async fn ssh_exec_once_fresh(vm_alias: &str, command: &str, timeout_secs: u64) -> std::result::Result<String, String> {
    let mut args = ssh_args(vm_alias, command);
    args.push("-o".into());
    args.push("ControlPath=none".into());
    ssh_exec_once_with(vm_alias, command, timeout_secs, args).await
}

async fn ssh_exec_once_with(vm_alias: &str, command: &str, timeout_secs: u64, args: Vec<String>) -> std::result::Result<String, String> {
    let result = timeout(
        Duration::from_secs(timeout_secs),
        tokio::process::Command::new("ssh")
            .args(args)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(Ok(output)) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("tokio timeout".to_string()),
    }
}

/// True when an ssh failure is a broken channel rather than a command that
/// genuinely failed on the far side: a dead mux socket, a mid-run disconnect,
/// or a silent exit (SIGPIPE has no message). These say nothing about the
/// remote command or the VM — only about the pipe — so they are retryable, and
/// they must never be reported as the remote's own fault (#398).
fn is_broken_pipe(stderr: &str) -> bool {
    stderr.is_empty()
        || stderr.contains("broken pipe") || stderr.contains("Broken pipe")
        || stderr.contains("Connection reset") || stderr.contains("Connection closed")
        || stderr.contains("packet_write_wait") || stderr.contains("read failed")
        || stderr.contains("Connection reset by peer")
}

/// Execute a command on a remote VM via SSH (port 22), with Dropbear :2200
/// fallback diagnostic.
///
/// 2026-07-03: this used to fire the first SSH attempt with no retry.
/// Reproduced twice in a row: identical SSH+Dropbear-down failure on all 3
/// VMs, ~16s after `wg0` came up while a second interface `wg1` was still
/// initializing — a cold WG handshake miss. reports-common/src/fleet.rs
/// already documents and retries this exact scenario for its own TCP
/// probes (`TCP_PROBE_RETRIES = 1 // cold-WG miss almost always succeeds
/// the second time`); this crate's SSH tier never had that retry, so a
/// cold mesh was misreported as "VM down" via the expensive Tier-2/3
/// diagnostic. One retry after a short backoff, mirroring the existing
/// pattern, before escalating.
pub async fn ssh_exec(vm_alias: &str, command: &str, timeout_secs: u64) -> Result<String> {
    if let Ok(out) = ssh_exec_once(vm_alias, command, timeout_secs).await {
        return Ok(out);
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    match ssh_exec_once(vm_alias, command, timeout_secs).await {
        Ok(out) => Ok(out),
        Err(stderr) => {
            let is_timeout = stderr.contains("timed out") || stderr.contains("tokio timeout")
                || stderr.contains("Connection refused") || stderr.contains("banner exchange")
                || stderr.contains("No route to host");
            // A broken pipe is a transport fault, not a mail fault: it must not
            // kill the liveness report any more than a 30s mesh blip does. Give
            // one broken pipe a fresh (mux-less) attempt before escalating — a
            // stale ControlMaster socket is exactly why the retry above just
            // failed again. When it still fails, escalate through the diagnostic
            // so the report names the REAL cause (Dropbear down, VM frozen,
            // cloud-API state) instead of a bare "SSH to VM failed" (#398).
            if is_broken_pipe(&stderr) {
                if let Ok(out) = ssh_exec_once_fresh(vm_alias, command, timeout_secs).await {
                    return Ok(out);
                }
                let cause = if stderr.is_empty() {
                    "no ssh output (broken pipe on a dropped connection)".to_string()
                } else {
                    stderr.clone()
                };
                return ssh_failure_diagnostic(vm_alias, &cause).await;
            }
            if is_timeout {
                return ssh_failure_diagnostic(vm_alias, &stderr).await;
            }
            anyhow::bail!("SSH to {} failed: {}", vm_alias, stderr)
        }
    }
}

/// Shared SSH failure diagnostic — Tier 2 (Dropbear) + Tier 3 (Cloud API + serial)
async fn ssh_failure_diagnostic(vm_alias: &str, initial_error: &str) -> Result<String> {
    // Tier 2: Dropbear :2200 liveness check
    let db_alive = dropbear_alive(vm_alias).await;
    if db_alive {
        eprintln!("[mail-health] SSH :22 failed on {} — Dropbear :2200 ALIVE (VM under load)", vm_alias);
        anyhow::bail!("SSH :22 failed (Dropbear :2200 alive — VM under load, not down)")
    }
    // Tier 3: Cloud API + serial console (both SSH dead)
    eprintln!("[mail-health] SSH :22 + Dropbear :2200 BOTH DOWN on {} — checking cloud API + serial", vm_alias);
    let serial_diag = cloud_serial_diagnostic(vm_alias).await;
    anyhow::bail!("SSH :22 failed ({}) + Dropbear :2200 down — {}", initial_error, serial_diag)
}

/// Cloud API VM status — fast, no SSH, works even when VM is frozen.
/// Returns "CLI_UNAVAILABLE" when the `gcloud`/`oci` binary isn't installed
/// or times out (e.g. GHA runners, which never provision these CLIs) — the
/// caller must NOT treat that the same as a real API failure, since it says
/// nothing about VM health, only about this environment's tooling.
pub async fn cloud_vm_status(vm_alias: &str) -> String {
    let is_gcp = vm_alias.starts_with("gcp-");

    if is_gcp {
        let gcloud_name = match vm_alias {
            "gcp-proxy" => "arch-1",
            _ => vm_alias,
        };
        let result = timeout(
            Duration::from_secs(8),
            tokio::process::Command::new("gcloud")
                .args(["compute", "instances", "describe", gcloud_name,
                       "--zone=us-central1-a", "--format=value(status)"])
                .output(),
        ).await;
        match result {
            Ok(Ok(o)) => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { "API_FAIL".into() } else { s }
            }
            Ok(Err(_)) => "CLI_UNAVAILABLE".into(), // spawn failed — gcloud not installed
            Err(_) => "API_FAIL".into(),            // spawned but timed out
        }
    } else {
        // OCI
        let instance_id = match vm_alias {
            "oci-mail" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacbwylmkqr253ay7binepapgsyopllfayovkzaky6oigbq",
            "oci-apps" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacj7dfxl7uifar574je7fzlvtdjp4ghljdwuwdemsdbiva",
            "oci-analytics" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacgwg5rkrjyomuxvjtvtuk5xrbmy7hmslwn4pse4kw5jkq",
            _ => return "unknown instance".into(),
        };
        let result = timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("oci")
                .args(["compute", "instance", "get", "--instance-id", instance_id,
                       "--query", "data.\"lifecycle-state\"", "--raw-output"])
                .output(),
        ).await;
        match result {
            Ok(Ok(o)) => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { "API_FAIL".into() } else { s }
            }
            Ok(Err(_)) => "CLI_UNAVAILABLE".into(), // spawn failed — oci CLI not installed
            Err(_) => "API_FAIL".into(),            // spawned but timed out
        }
    }
}

/// Dropbear liveness check on port 2200 — lightweight SSH, survives OOM
async fn dropbear_alive(vm_alias: &str) -> bool {
    let result = timeout(
        Duration::from_secs(8),
        tokio::process::Command::new("ssh")
            .args([
                "-o", "ConnectTimeout=5",
                "-o", "ServerAliveInterval=15",
                "-o", "ServerAliveCountMax=12",
                "-o", "BatchMode=yes",
                "-o", "ControlPath=none",
                "-p", "2200",
                vm_alias,
                "echo OK",
            ])
            .output(),
    )
    .await;
    result
        .ok()
        .and_then(|r| r.ok())
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("OK"))
        .unwrap_or(false)
}

/// Tier 3: Cloud API status + serial console tail when both SSH and Dropbear are dead
async fn cloud_serial_diagnostic(vm_alias: &str) -> String {
    let mut parts: Vec<String> = vec![];

    // Determine provider from alias
    let is_gcp = vm_alias.starts_with("gcp-");
    let is_oci = vm_alias.starts_with("oci-");

    if is_gcp {
        // GCP: check instance status via gcloud
        let gcloud_name = match vm_alias {
            "gcp-proxy" => "arch-1",
            _ => vm_alias,
        };

        // Instance status
        let status = timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("gcloud")
                .args(["compute", "instances", "describe", gcloud_name,
                       "--zone=us-central1-a", "--format=value(status)"])
                .output(),
        ).await;
        let vm_status = status.ok().and_then(|r| r.ok())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or("API_FAIL".into());
        parts.push(format!("GCP status: {}", vm_status));

        // Serial console last 20 lines — look for OOM, panic, boot
        let serial = timeout(
            Duration::from_secs(15),
            tokio::process::Command::new("gcloud")
                .args(["compute", "instances", "get-serial-port-output", gcloud_name,
                       "--zone=us-central1-a", "--start=-8192"])
                .output(),
        ).await;
        if let Ok(Ok(out)) = serial {
            let text = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = text.lines().collect();
            let tail: Vec<&str> = lines.iter().rev().take(30).copied().collect();

            // Scan for diagnostic keywords
            let has_oom = tail.iter().any(|l| l.contains("Out of memory") || l.contains("oom-kill") || l.contains("Killed process"));
            let has_panic = tail.iter().any(|l| l.contains("Kernel panic") || l.contains("kernel BUG"));
            let has_boot = tail.iter().any(|l| l.contains("Linux version") || l.contains("systemd[1]: Started"));
            let has_login = tail.iter().any(|l| l.contains("login:"));

            if has_oom { parts.push("SERIAL: OOM killer active".into()); }
            if has_panic { parts.push("SERIAL: kernel panic detected".into()); }
            if has_boot && !has_login { parts.push("SERIAL: booting (no login prompt yet)".into()); }
            if has_login { parts.push("SERIAL: login prompt present (SSH daemon issue)".into()); }
            if !has_oom && !has_panic && !has_boot && !has_login {
                // Show last 3 lines for context
                let last3: Vec<&str> = tail.iter().take(3).copied().collect();
                parts.push(format!("SERIAL tail: {}", last3.join(" | ")));
            }
        } else {
            parts.push("SERIAL: gcloud timeout".into());
        }
    } else if is_oci {
        // OCI: check instance status via oci cli
        let instance_id = match vm_alias {
            "oci-mail" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacbwylmkqr253ay7binepapgsyopllfayovkzaky6oigbq",
            "oci-apps" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacj7dfxl7uifar574je7fzlvtdjp4ghljdwuwdemsdbiva",
            "oci-analytics" => "ocid1.instance.oc1.eu-marseille-1.anwxeljruadvczacgwg5rkrjyomuxvjtvtuk5xrbmy7hmslwn4pse4kw5jkq",
            _ => "",
        };

        if !instance_id.is_empty() {
            // Instance lifecycle state
            let status = timeout(
                Duration::from_secs(10),
                tokio::process::Command::new("oci")
                    .args(["compute", "instance", "get", "--instance-id", instance_id,
                           "--query", "data.\"lifecycle-state\"", "--raw-output"])
                    .output(),
            ).await;
            let vm_status = status.ok().and_then(|r| r.ok())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or("API_FAIL".into());
            parts.push(format!("OCI status: {}", vm_status));

            // OCI serial console: get-instance-console-history (last chunk)
            let serial = timeout(
                Duration::from_secs(12),
                tokio::process::Command::new("oci")
                    .args(["compute", "instance-console-history", "list",
                           "--instance-id", instance_id,
                           "--query", "data[0].id", "--raw-output"])
                    .output(),
            ).await;
            if let Ok(Ok(out)) = serial {
                let history_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !history_id.is_empty() && history_id.starts_with("ocid1") {
                    let content = timeout(
                        Duration::from_secs(12),
                        tokio::process::Command::new("oci")
                            .args(["compute", "instance-console-history", "get-content",
                                   "--instance-console-history-id", &history_id,
                                   "--length", "4096"])
                            .output(),
                    ).await;
                    if let Ok(Ok(out)) = content {
                        let text = String::from_utf8_lossy(&out.stdout);
                        let lines: Vec<&str> = text.lines().collect();
                        let tail: Vec<&str> = lines.iter().rev().take(30).copied().collect();

                        let has_oom = tail.iter().any(|l| l.contains("Out of memory") || l.contains("oom-kill"));
                        let has_panic = tail.iter().any(|l| l.contains("Kernel panic"));
                        let has_login = tail.iter().any(|l| l.contains("login:"));

                        if has_oom { parts.push("SERIAL: OOM killer active".into()); }
                        if has_panic { parts.push("SERIAL: kernel panic".into()); }
                        if has_login { parts.push("SERIAL: login prompt (SSH issue)".into()); }
                        if !has_oom && !has_panic && !has_login {
                            let last3: Vec<&str> = tail.iter().take(3).copied().collect();
                            parts.push(format!("SERIAL tail: {}", last3.join(" | ")));
                        }
                    }
                }
            }
        } else {
            parts.push("OCI: unknown instance".into());
        }
    } else {
        parts.push("unknown provider".into());
    }

    if parts.is_empty() {
        "VM frozen/unreachable (no cloud API data)".into()
    } else {
        parts.join(" | ")
    }
}

/// SSH echo test -- verifies SSH auth works
#[allow(dead_code)]
pub async fn ssh_echo_test(vm_alias: &str) -> bool {
    timeout(
        SSH_TIMEOUT,
        tokio::process::Command::new("ssh")
            .args(ssh_args(vm_alias, "echo OK"))
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("OK"))
    .unwrap_or(false)
}

/// Parse ===section=== markers from SSH batch output
pub fn parse_section(output: &str, name: &str) -> String {
    let start_marker = format!("==={}===", name);
    let start = match output.find(&start_marker) {
        Some(pos) => pos + start_marker.len(),
        None => return String::new(),
    };
    // Skip the newline after marker
    let start = if output.as_bytes().get(start) == Some(&b'\n') {
        start + 1
    } else {
        start
    };
    let rest = &output[start..];
    let end = rest.find("===").unwrap_or(rest.len());
    rest[..end].trim().to_string()
}

/// Big batch SSH to oci-mail -- collects all data in one round-trip
/// Returns Err(diagnostic) with Dropbear liveness info on failure
pub async fn ssh_batch_mail() -> Result<RemoteData, String> {
    // SSH batch script for Maddy mail server (migrated from Stalwart 2026-04-04)
    let script = r#"
T=3
echo "===disk==="
df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %'
echo "===memory==="
free -m 2>/dev/null | awk '/Mem:/{printf "%d/%dMB (%.0f%%)", $3, $2, $3/$2*100}'
echo ""
echo "===load==="
cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}'
echo "===dockerVersion==="
timeout $T docker info --format '{{.ServerVersion}}' 2>&1 | head -1
echo "===containers==="
timeout $T docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>&1
echo "===restarts==="
# http-to-smtp-proxy-api dropped from the filter: it runs on gcp-proxy, never on
# oci-mail, so the filter never matched it and only widened the docker ps scan.
timeout $T docker inspect --format '{{.Name}}\t{{.RestartCount}}' $(timeout $T docker ps -aq --filter name=maddy --filter name=stalwart 2>/dev/null) 2>/dev/null | tr -d '/'
echo "===imapCap==="
echo "a001 CAPABILITY" | timeout $T openssl s_client -connect localhost:993 -quiet 2>/dev/null | head -3
echo "===stalwartImap==="
# Stalwart's IMAPS, the store the user actually reads. Must be dialled on the
# WG IP, not localhost: stalwart is published through docker-proxy, which binds
# only the oci-apps wg0/wg-public addresses (10.0.0.6, 10.1.0.4, #1821) — there is no loopback listener on 2993.
echo "a001 CAPABILITY" | timeout $T openssl s_client -connect 10.0.0.6:2993 -quiet 2>/dev/null | head -3
echo "===stalwartQueueDepth==="
# The dual-write backlog. `maddy queue list` (used here until 2026-09-09) is not
# a maddy subcommand at all — `maddy --help` offers only verify-config, run,
# version, hash, imap-mboxes, imap-msgs, imap-acct and creds. The old probe
# swallowed that error with `|| echo "empty"`, so the queue check reported an
# empty queue forever and could never see a backlog. The real queue is the
# on-disk one maddy.conf declares: target.queue stalwart_queue, location
# /data/queue-stalwart. Count its entries.
docker exec maddy sh -c 'ls -1 /data/queue-stalwart 2>/dev/null | wc -l' 2>/dev/null || echo "QUEUE_FAIL"
echo "===quota==="
docker exec maddy maddy imap-acct list 2>/dev/null | head -5 || echo "maddy-accounts"
echo "===users==="
docker exec maddy maddy creds list 2>/dev/null | wc -l || echo "0"
echo "===smtp25==="
# Dial the WG IP, not localhost. maddy.conf declares the inbound listener as
# `smtp tcp://10.0.0.3:25 tcp://10.1.0.3:25` — wg0 and wg-public, with no
# loopback bind — so `nc localhost 25` returned nothing and the "SMTP :25 relay"
# check was red on every run. The 8s timeout below was added to chase that as a
# slow-banner problem on the 1-vCPU Ampere VM; the banner was never slow, the
# port was simply not there. Kept at 8s anyway because SPF evaluation genuinely
# can delay it under load.
echo QUIT | timeout 8 nc -w8 10.0.0.3 25 2>&1 | head -1
echo "===webmailInternal==="
# cloud-webmail lives on oci-apps (10.0.0.6:3000), NOT here — this probed
# localhost:8888 (the retired SnappyMail/Maddy-debug port) and so returned
# HTTP 000 forever. Kept as a mesh hop rather than moved into ssh_batch_apps
# because it also proves oci-mail → oci-apps reachability. See
# constants::WEBMAIL_INTERNAL_URL.
curl -skL -o /dev/null -w '%{http_code}' --max-time $T http://10.0.0.6:3000/ 2>&1
echo ""
echo "===maddyAccounts==="
docker exec maddy maddy creds list 2>/dev/null || echo "CLI_FAIL"
echo "===maddyDomains==="
docker exec maddy grep 'local_domains' /data/maddy.conf 2>/dev/null || echo "CLI_FAIL"
echo "===allLocalPorts==="
# Keep this port set a superset of constants::EXPECTED_PORTS — a port that is
# expected but not grepped here can never be seen as bound. 8888 dropped and
# 2443/2993 (Stalwart JMAP + IMAPS) added 2026-09-09. 4190 dropped: it is
# Dovecot's ManageSieve port and nothing has bound it since Mailu; Stalwart's
# ManageSieve is 6190. 2025 (stalwart_relay) and 2465 (Stalwart SMTPS) added.
sudo ss -tlnp 2>/dev/null | grep -E ':(25|143|465|587|993|2025|2443|2465|2993|6190)\s' || ss -tlnp 2>/dev/null | grep -E ':(25|143|465|587|993|2025|2443|2465|2993|6190)\s' || echo "(none)"
echo "===configGhcrHash==="
echo "maddy-no-ghcr-image"
echo "===configContainerTplHash==="
docker exec maddy md5sum /etc/maddy/maddy.conf.tpl 2>/dev/null | awk '{print $1}' || echo "CONTAINER_FAIL"
echo "===configHostHash==="
# configs/maddy.conf.tpl, not the top-level copy. The deploy pipeline ships
# ./configs/maddy.conf.tpl (see /opt/containers/maddy/.deploy-manifest) and that
# file is md5-identical to the container's /etc/maddy/maddy.conf.tpl. The
# top-level /opt/containers/maddy/maddy.conf.tpl is an April leftover from
# before the layout moved and has a different hash, so hashing it made
# "Host→Container tpl" and "FULL CHAIN" report CRITICAL DRIFT on every run
# against a chain that is in fact consistent.
md5sum /opt/containers/maddy/configs/maddy.conf.tpl 2>/dev/null | awk '{print $1}' || echo "HOST_FAIL"
echo "===configRunning==="
docker exec maddy grep -E 'hostname|targets|deliver_to|local_domains|smart_host|tls' /data/maddy.conf 2>/dev/null | head -20 || echo "CONFIG_FAIL"
echo "===debugDump==="
echo "--- ss listening ports ---"
sudo ss -tlnp 2>/dev/null || ss -tlnp 2>/dev/null || true
echo "--- docker networks ---"
timeout $T docker network ls --format '{{.Name}}\t{{.Driver}}' 2>/dev/null || true
echo "--- maddy config ---"
docker exec maddy grep -E 'hostname|smtp|imap|submission|tls' /data/maddy.conf 2>/dev/null | head -10 || echo "(no config)"
echo "--- maddy logs (last 10) ---"
timeout $T docker logs maddy --tail 10 2>&1 || echo "(no maddy container)"
echo "--- resolv.conf ---"
cat /etc/resolv.conf 2>/dev/null || true
"#;

    eprintln!("[mail-health] SSH batch oci-mail: connecting...");
    // Wrap in bash -c to avoid fish shell syntax errors
    let bash_script = format!("bash -c '{}'", script.trim().replace('\'', "'\\''"));
    let output = match ssh_exec(MAIL_ALIAS, &bash_script, 45).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[mail-health] SSH batch oci-mail FAILED: {}", e);
            return Err(e.to_string());
        }
    };

    Ok(RemoteData {
        containers: parse_section(&output, "containers"),
        restarts: parse_section(&output, "restarts"),
        disk: parse_section(&output, "disk"),
        memory: parse_section(&output, "memory"),
        load: parse_section(&output, "load"),
        docker_version: parse_section(&output, "dockerVersion"),
        imap_cap: parse_section(&output, "imapCap"),
        stalwart_imap: parse_section(&output, "stalwartImap"),
        quota: parse_section(&output, "quota"),
        users: parse_section(&output, "users"),
        smtp25: parse_section(&output, "smtp25"),
        webmail_internal: parse_section(&output, "webmailInternal"),
        maddy_accounts: parse_section(&output, "maddyAccounts"),
        maddy_domains: parse_section(&output, "maddyDomains"),
        stalwart_queue_depth: parse_section(&output, "stalwartQueueDepth"),
        all_local_ports: parse_section(&output, "allLocalPorts"),
        debug_dump: parse_section(&output, "debugDump"),
        config_src_hash: String::new(),  // filled locally, not via SSH
        config_dist_hash: String::new(), // filled locally, not via SSH
        config_ghcr_hash: parse_section(&output, "configGhcrHash"),
        config_container_tpl_hash: parse_section(&output, "configContainerTplHash"),
        config_running: parse_section(&output, "configRunning"),
        config_host_hash: parse_section(&output, "configHostHash"),
    })
}

/// Batch SSH to oci-apps -- cloud-mail-mcp container tests via node
pub async fn ssh_batch_apps() -> Result<RemoteDataApps, String> {
    // Node scripts run inside cloud-mail-mcp container
    let node_script = |code: &str| -> String {
        let escaped = code.replace('"', r#"\""#).replace('\n', "");
        format!(
            r#"docker exec cloud-mail-mcp node -e "{}" 2>&1 | head -5"#,
            escaped
        )
    };

    let dns_resolve_js = node_script(
        r#"require('dns').resolve4('imap.diegonmarcos.com',(e,a)=>console.log(e?'ERR:'+e.message:'OK:'+a.join(',')));"#,
    );
    // These four probes dial :443 with SNI, NOT raw 993/465. The public
    // surface was collapsed to 443+51820+25, so 993 and 465 are refused from
    // anywhere off the mesh — every one of these checks failed permanently
    // (ECONNREFUSED on the TLS pair, TIMEOUT on the LOGIN/AUTH pair) while the
    // path real clients use was fine. Hostnames must be imap.* and smtps.*
    // (constants::IMAP_DOMAIN / SMTPS_DOMAIN); the old smtp.* name does not
    // route at all. Verified 2026-09-09 from oci-apps: :443 CONNECTED on both,
    // :465 and :993 Connection refused. Kept as literals rather than format!
    // args because the JS bodies are full of braces.
    let imap_tls_js = node_script(
        r#"const tls=require('tls');const s=tls.connect(443,'imap.diegonmarcos.com',{servername:'imap.diegonmarcos.com',timeout:5000},()=>{console.log('OK proto='+s.getProtocol()+' cn='+((s.getPeerCertificate()||{}).subject||{}).CN);s.end()});s.on('error',e=>console.log('ERR:'+e.code+' '+e.message));s.setTimeout(5000,()=>{console.log('ERR:TIMEOUT');s.destroy()});"#,
    );
    let smtp_tls_js = node_script(
        r#"const tls=require('tls');const s=tls.connect(443,'smtps.diegonmarcos.com',{servername:'smtps.diegonmarcos.com',timeout:5000},()=>{console.log('OK proto='+s.getProtocol());s.end()});s.on('error',e=>console.log('ERR:'+e.code+' '+e.message));s.setTimeout(5000,()=>{console.log('ERR:TIMEOUT');s.destroy()});"#,
    );
    let imap_wg_js = node_script(&format!(
        r#"const tls=require('tls');const s=tls.connect(993,'{}',{{servername:'{}',rejectUnauthorized:false,timeout:5000}},()=>{{console.log('OK proto='+s.getProtocol());s.end()}});s.on('error',e=>console.log('ERR:'+e.code+' '+e.message));s.setTimeout(5000,()=>{{console.log('ERR:TIMEOUT');s.destroy()}});"#,
        MAIL_WG_IP, MAIL_DOMAIN
    ));
    let imap_login_js = node_script(
        r#"const tls=require('tls');const u=process.env.MAIL_USER||'';const p=process.env.MAIL_PASSWORD||'';if(!u||!p){console.log('NO_CREDS');process.exit(0)}const s=tls.connect(443,'imap.diegonmarcos.com',{servername:'imap.diegonmarcos.com',timeout:6000},()=>{let buf='';s.on('data',d=>{buf+=d.toString();if(buf.includes('* OK')&&!buf.includes('a001')){s.write('a001 LOGIN '+u+' '+p+'\r\n')}if(buf.includes('a001 OK')){console.log('LOGIN_OK');s.end()}if(buf.includes('a001 NO')||buf.includes('a001 BAD')){console.log('LOGIN_FAIL: '+buf.split('\n').pop());s.end()}})});s.on('error',e=>console.log('ERR:'+e.message));setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},7000);"#,
    );
    let smtp_auth_js = node_script(
        r#"const tls=require('tls');const s=tls.connect(443,'smtps.diegonmarcos.com',{servername:'smtps.diegonmarcos.com',timeout:5000},()=>{let phase=0,buf='';s.on('data',d=>{buf+=d.toString();if(phase===0&&buf.includes('220')){s.write('EHLO health-check\r\n');phase=1;buf=''}if(phase===1&&buf.includes('250')){const hasAuth=buf.includes('AUTH');console.log(hasAuth?'SMTP_AUTH_OK: '+buf.split('\n').filter(l=>l.includes('AUTH'))[0]:'SMTP_NO_AUTH');s.write('QUIT\r\n');s.end()}})});s.on('error',e=>console.log('ERR:'+e.message));setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},6000);"#,
    );

    let script = format!(
        r#"echo "===mailMcpStatus==="
docker ps --filter name=cloud-mail-mcp --format '{{{{.Status}}}}' 2>/dev/null || echo "NOT FOUND"
echo "===dnsResolve==="
{}
echo "===imapTls==="
{}
echo "===smtpTls==="
{}
echo "===imapWg==="
{}
echo "===imapLogin==="
{}
echo "===smtpAuth==="
{}"#,
        dns_resolve_js, imap_tls_js, smtp_tls_js, imap_wg_js, imap_login_js, smtp_auth_js
    );

    eprintln!("[mail-health] SSH batch oci-apps: connecting...");
    let output = match ssh_exec(APPS_ALIAS, &script, 35).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[mail-health] SSH batch oci-apps FAILED: {}", e);
            return Err(e.to_string());
        }
    };

    Ok(RemoteDataApps {
        mail_mcp_status: parse_section(&output, "mailMcpStatus"),
        dns_resolve: parse_section(&output, "dnsResolve"),
        imap_tls: parse_section(&output, "imapTls"),
        smtp_tls: parse_section(&output, "smtpTls"),
        imap_wg: parse_section(&output, "imapWg"),
        imap_login: parse_section(&output, "imapLogin"),
        smtp_auth: parse_section(&output, "smtpAuth"),
    })
}

/// Batch SSH to gcp-proxy -- Caddy L4 + Authelia
pub async fn ssh_batch_proxy() -> Result<RemoteDataProxy, String> {
    let script = format!(
        r#"echo "===caddyL4_993==="
echo Q | timeout 8 openssl s_client -connect {mail_wg}:993 -servername {mail_domain} 2>&1 | grep -c CONNECTED
echo "===caddyL4_465==="
echo Q | timeout 8 openssl s_client -connect {mail_wg}:465 -servername {mail_domain} 2>&1 | grep -c CONNECTED
# No 587 probe: nothing binds 587 on oci-mail by design (submission goes through
# http-to-smtp-proxy-api on gcp-proxy, which speaks :25 over WG). network_checks
# never read the result, so this only spent 8s per run timing out on a closed port.
echo "===autheliaHealth==="
# Authelia publishes on gcp-proxy's WG IP (10.0.0.1:9091), not localhost.
# Probing localhost:9091 always returned FAIL.
curl -skf http://{proxy_wg}:9091/api/health 2>/dev/null || curl -skf http://authelia.mesh.diegonmarcos.com:9091/api/health 2>/dev/null || echo "FAIL""#,
        mail_wg = MAIL_WG_IP,
        mail_domain = MAIL_DOMAIN,
        proxy_wg = PROXY_WG_IP,
    );

    eprintln!("[mail-health] SSH batch gcp-proxy: connecting...");
    let output = match ssh_exec(PROXY_ALIAS, &script, 60).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[mail-health] SSH batch gcp-proxy FAILED: {}", e);
            return Err(e.to_string());
        }
    };

    Ok(RemoteDataProxy {
        caddy_l4_993: parse_section(&output, "caddyL4_993"),
        caddy_l4_465: parse_section(&output, "caddyL4_465"),
        authelia_health: parse_section(&output, "autheliaHealth"),
    })
}
