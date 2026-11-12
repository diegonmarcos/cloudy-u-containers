// Tester: the OpenClaw service (cloud-agi-openclaw) — loopback only, behind the
// fleet agent gateway, no secret, one declaration.
//
// It EVALUATES the declarative source (compose.nix and openclaw-config.nix are
// pure functions of build.json, so nix-instantiate renders them without
// nixpkgs) rather than grepping it, then re-renders with a mutated build.json
// to prove each rendered value follows the declaration. It fails when:
//   O1  the gateway leaves loopback while auth stays "none" (an open operator
//       API on the mesh), or the container publishes a port / leaves host
//       network
//   O2  the bind / port / auth the gateway starts with is not build.json's
//   O3  the OpenAI-compatible endpoint is off (the fleet gateway cannot reach
//       the agent), or the browser Control UI is on
//   O4  OpenClaw's model calls do not go to the fleet gateway's own
//       OpenAI-compatible face, or use a model id the gateway would route to
//       an agent mode instead of OpenRouter (a loop: openclaw -> claude-cli…)
//   O5  a secret appears: src/secrets.yaml, an env_file, or an `agent` block
//       (the shared git tree + GH_TOKEN this service does not get)
//   O6  the config is not emitted by the flake, not mounted read-only, or not
//       copied into the state volume at start (the EPERM-fchmod trap)
//   O7  the image floats (:latest) or the memory ceiling is undeclared
//   O8  the fleet gateway's default OpenClaw address is not this port
//
// Usage: node test-openclaw-service.mjs   (cwd = src; exit 0 = PASS)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();
const buildPath = join(here, "..", "build.json");
const build = JSON.parse(readFileSync(buildPath, "utf8"));

let nixOk = true;
try { execFileSync("nix-instantiate", ["--version"], { stdio: "ignore" }); } catch { nixOk = false; }
check("O0 nix-instantiate is available (the render is evaluated, never grepped)", nixOk);
if (!nixOk) { console.error("NOT GREEN"); process.exit(1); }

const render = (buildJson) => {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-svc-"));
  const bj = join(dir, "build.json");
  writeFileSync(bj, JSON.stringify(buildJson));
  const expr = `let b = builtins.fromJSON (builtins.readFile ${bj}); in {
    c = import ${join(here, "compose.nix")} { buildJson = b; container = {}; };
    o = import ${join(here, "openclaw-config.nix")} { buildJson = b; };
  }`;
  return JSON.parse(execFileSync("nix-instantiate", ["--eval", "--strict", "--json", "-E", expr], { encoding: "utf8" }));
};

const { c, o } = render(build);
const svc = c.services.openclaw;
const entry = (svc.entrypoint || []).join(" ");

// ── O1 loopback only ────────────────────────────────────────────────────────
check("O1 the gateway binds loopback", o.gateway.bind === "loopback", o.gateway.bind);
check("O1b auth mode none is only ever paired with loopback",
  o.gateway.auth.mode !== "none" || o.gateway.bind === "loopback");
check("O1c host network, no published port", svc.network_mode === "host" && !("ports" in svc), JSON.stringify(svc.ports));
check("O1d not public in the declaration", build.containers.app.public === false && build.proxy.app_hub === false);
// mutation: a non-loopback bind with auth none must be refused by O1b's rule
{
  const m = structuredClone(build); m.runtime.bind = "lan";
  const r = render(m);
  check("O1e (mutation) bind=lan with auth=none is caught by the rule",
    !(r.o.gateway.auth.mode !== "none" || r.o.gateway.bind === "loopback"));
}

// ── O2 one declaration: bind, port, auth ────────────────────────────────────
const port = String(build.ports.app);
check("O2 the gateway starts on build.json's bind and port",
  entry.includes(`gateway --bind ${build.runtime.bind} --port ${port}`) && o.gateway.port === build.ports.app && svc.environment.OPENCLAW_GATEWAY_PORT === port, entry);
check("O2b the container healthcheck probes that loopback port", svc.healthcheck.test.join(" ").includes(`http://127.0.0.1:${port}/health`));
{
  const m = structuredClone(build); m.ports.app = 18800;
  const r = render(m);
  check("O2c (mutation) a new port moves the config, the entrypoint and the healthcheck together",
    r.o.gateway.port === 18800 && r.c.services.openclaw.entrypoint.join(" ").includes("--port 18800")
      && r.c.services.openclaw.healthcheck.test.join(" ").includes(":18800/health"));
}

// ── O3 the endpoint the fleet gateway calls ────────────────────────────────
check("O3 the OpenAI-compatible /v1/chat/completions is enabled", o.gateway.http.endpoints.chatCompletions.enabled === true);
check("O3b the Control UI is off", o.gateway.controlUi.enabled === false);

// ── O4 model calls go back through the fleet gateway ────────────────────────
const myai = JSON.parse(readFileSync(join(here, "..", "..", "user-ai_cloudy-ai-agents-api", "build.json"), "utf8"));
const myaiBind = myai.runtime.wg_bind || "10.0.0.6";
const prov = o.models.providers[build.runtime.provider.id];
check("O4 the provider is my-ai-api's OpenAI-compatible face on its WireGuard bind",
  prov.baseUrl === `http://${myaiBind}:${myai.ports.app}/v1` && prov.api === "openai-completions", prov.baseUrl);
check("O4b the default model is the declared one, on that provider",
  o.agents.defaults.model.primary === `${build.runtime.provider.id}/${build.runtime.model}` && prov.models[0].id === build.runtime.model);
const m = build.runtime.model.toLowerCase();
check("O4c the model id is one the gateway sends to OpenRouter (no loop into an agent mode)",
  !(m === "goose" || m.startsWith("goose") || m === "hermes" || m.startsWith("hermes/") || m.startsWith("nous/") || m === "claude" || m.startsWith("claude/") || m.startsWith("claude-") || m.startsWith("openclaw")), m);
check("O4d the provider key is the placeholder the gateway ignores, never a real key",
  prov.apiKey === build.runtime.provider.api_key_placeholder && !/^sk-/.test(prov.apiKey) && myai.runtime.upstream.passthrough_auth === false);

// ── O5 no secret ────────────────────────────────────────────────────────────
check("O5 no src/secrets.yaml", !existsSync(join(here, "secrets.yaml")));
check("O5b no env_file", Array.isArray(svc.env_file) && svc.env_file.length === 0 && build.containers.app.env_file === false);
// The fleet rule (cloud-infra test_agent_git_tree_declared) makes every category "agi"
// container DECLARE its decision, so an `agent` block exists — but the only block that
// keeps this service secret-less is the explicit opt-out: no shared tree, hence no
// writable tree and no GH_TOKEN credential helper.
check("O5c no shared git tree and no GH_TOKEN (agent block absent, or the explicit git_tree:false opt-out)",
  !("agent" in build) || (build.agent.git_tree === false && !build.agent.git_tree_writable));

// ── O6 the config's path into the container ─────────────────────────────────
const flake = readFileSync(join(here, "flake.nix"), "utf8");
check("O6 the flake emits configs/openclaw.json from openclaw-config.nix",
  /name = "openclaw\.json";[\s\S]*?builtins\.toJSON \(import \.\/openclaw-config\.nix/.test(flake));
check("O6b it is mounted read-only", svc.volumes.includes("./configs/openclaw.json:/etc/openclaw/openclaw.json:ro"));
check("O6c and copied into the state volume before the gateway starts",
  /cp \/etc\/openclaw\/openclaw\.json \/home\/node\/\.openclaw\/openclaw\.json;.*exec node dist\/index\.js gateway/.test(entry)
    && svc.environment.OPENCLAW_CONFIG_PATH === "/home/node/.openclaw/openclaw.json"
    && svc.volumes.some((v) => v.startsWith("openclaw_state:/home/node/.openclaw")));

// ── O7 pinned image, declared ceiling ───────────────────────────────────────
check("O7 the image is upstream's, pinned to a version", /^ghcr\.io\/openclaw\/openclaw:\d{4}\.\d+\.\d+$/.test(svc.image), svc.image);
check("O7b the memory ceiling is declared and rendered", svc.deploy.resources.limits.memory === build.containers.app.resources.mem_limit);
check("O7c restarts on its own after a reboot", svc.restart === "unless-stopped");

// ── O8 the fleet gateway points at this port ────────────────────────────────
const server = readFileSync(join(here, "..", "..", "user-ai_cloudy-ai-agents-api", "src", "code", "server.mjs"), "utf8");
check("O8 my-ai-api's default OpenClaw address is 127.0.0.1:<this port>",
  server.includes(`OPENCLAW_BASE_URL ?? "http://127.0.0.1:${port}"`));
check("O8b and it routes X-Agent-Mode: openclaw there", /hdr === "openclaw"\) return "openclaw"/.test(server) && /agentMode === "openclaw"\)\s+return callNative\("openclaw"/.test(server));

// ── O9 the AGI naming convention (#505/#542) ───────────────────────────────
// _shared/test-agi-container-naming.mjs enumerates the first four runtimes; it
// is not extended here on purpose: any change under _shared/ ships EVERY
// engine consumer (cloud-ship-detect-engine-consumers.sh), a fleet-wide
// redeploy for a roster line. The same two rules are held for this one.
const agiNames = ["user-ai_cloudy-ai-claude-api", "user-ai_cloudy-ai-agents-api", "user-ai_hermes-agent"]
  .map((d) => JSON.parse(readFileSync(join(here, "..", "..", d, "build.json"), "utf8")).containers.app.container_name);
check("O9 the container is named cloud-agi-*", /^cloud-agi-[a-z]+$/.test(svc.container_name) && svc.container_name === build.containers.app.container_name, svc.container_name);
check("O9b and the name is not another AGI runtime's", !agiNames.includes(svc.container_name) && svc.container_name !== "cloud-agi-bots", agiNames.join(","));

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
