# compose.nix — docker-compose for my-ai-api.
# WG-ONLY: host networking so the container reaches the WG mesh (10.0.0.6)
# for the claude-cli backend and makes outbound OpenRouter calls without NAT.
# Three process bindings on the host: 3217 (Node /v1), 12436 (Ollama mimic),
# 8890 (Headroom FastAPI sidecar). No Caddy route — public:false.
# Secrets via .secrets env_file (sops-decrypted OPENROUTER_API_KEY).
{ buildJson, container }:

let
  app   = buildJson.containers.app;
  rt    = buildJson.runtime or {};
  ports = buildJson.ports or {};
  gw = rt.gateway or {};
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    my-ai-api = {
      image          = binariesImage;
      container_name = app.container_name;
      # Ticket #545: the container used to start with the fleet-wide restart:no
      # default, so a host reboot or a killed container left the whole agent
      # fleet dead until someone noticed. This is the ONE declaration of the
      # restart policy — engine.nix deep-merges compose-defaults.json, so an
      # entry here overrides the fleet default for this service. unless-stopped
      # (not always) so an operator can still `docker stop` intentionally; the
      # container comes back automatically on daemon/host restart and on any
      # unexpected exit.
      restart        = "unless-stopped";
      network_mode   = "host";
      env_file       = [ "./.secrets" ];
      environment    = {
        BRIDGE_PORT        = toString (ports.app      or 3217);
        # wg0-only: bind the /v1 API + Ollama mimic to the WG address so WG-peer
        # GHA runners can reach them. localhost default left them unreachable over
        # wg0 (octocode LLM calls from the x86 runner silently failed). NOT 0.0.0.0
        # — 10.0.0.6 is the WG interface only, never a public bind.
        BRIDGE_BIND        = rt.wg_bind or "10.0.0.6";
        BRIDGE_OLLAMA_BIND = rt.wg_bind or "10.0.0.6";
        # In-container gateway (telegram/mattermost bot) calls the /v1 API. Follow
        # the wg0 bind — localhost no longer answers once BRIDGE_BIND is the WG IP.
        MYAI_LOCAL_URL     = "http://${rt.wg_bind or "10.0.0.6"}:3217";
        # goose itself (`goose run`, goosed on GOOSE_PORT) calls this same /v1 API as its
        # OpenAI provider, so its host follows the wg0 bind too. The baked goose-config.yaml
        # pinned http://127.0.0.1:3217, which stopped answering when the bind moved to the
        # WG IP (0c5311af, 2026-08-07): every goose model call was refused, so its declared
        # MCP extensions could never be used. The environment overrides goose's config.yaml.
        OPENAI_HOST        = "http://${rt.wg_bind or "10.0.0.6"}:${toString (ports.app or 3217)}";
        # Same reason, same mechanism, for the model itself. goose-config.yaml used to
        # restate the model TWICE (GOOSE_MODEL and providers.openai.model), both pinned
        # to deepseek-v4-pro, so build.json's runtime.model was dead config: goose ran
        # v4-pro no matter what was declared. build.json is the ONE declaration now, and
        # this export is what carries it — proven live 2026-09-16, banner read
        # "openai deepseek/deepseek-v4-flash-0731" and the run pushed a360baf2.
        # No `or` fallback on purpose: a default naming a different model would be a
        # second declaration of exactly the kind this fix removes. If build.json ever
        # stops declaring runtime.model, eval must fail here rather than quietly run
        # something other than what is declared.
        GOOSE_MODEL        = rt.model;
        HEADROOM_PORT      = toString (ports.headroom or 8890);
        GOOSE_PORT         = toString (ports.goosed   or 3227);
        # BRIDGE_ prefix is MANDATORY: server.mjs reads process.env.BRIDGE_DEFAULT_MODEL /
        # BRIDGE_MAX_CONCURRENCY / BRIDGE_CALL_TIMEOUT_MS / BRIDGE_MODEL_ALIASES. These were
        # exported un-prefixed until 2026-08-09, so the server never saw them and silently
        # used its hardcoded fallbacks — build.json runtime.model was dead config (goose kept
        # answering as z-ai/glm-5 no matter what runtime.model said). Renaming a key here
        # without changing server.mjs re-breaks it silently; keep the two in lockstep.
        # Fallback dropped for the same reason as GOOSE_MODEL above: "z-ai/glm-5" here
        # is what the old un-prefixed export silently fell back to, and leaving it named
        # keeps a second model declaration alive in the file that exists to have one.
        BRIDGE_DEFAULT_MODEL   = rt.model;
        BRIDGE_MAX_CONCURRENCY = toString (rt.max_concurrency or 12);
        BRIDGE_CALL_TIMEOUT_MS = toString (rt.call_timeout_ms or 180000);
        # Requested-id → OpenRouter slug map, consumed as JSON by server.mjs.
        BRIDGE_MODEL_ALIASES   = builtins.toJSON (rt.model_aliases or {});
        BRIDGE_OLLAMA_PORT     = toString (ports.ollama or 12436);
        MATTERMOST_URL     = gw.mattermost_url     or "";
        MATTERMOST_ENABLED = gw.mattermost_enabled  or "false";
        TELEGRAM_ALLOW_FROM = gw.telegram_allow_from or "";
        # #542 lifetime split. This container is an AGENT RUNTIME: every deploy
        # recreates it, which kills any in-flight `goose run`. The bots are a
        # long-lived SERVICE and must not share that fate — on 2026-09-20 a
        # single evicted deploy left this container in `created` and took BOTH
        # telegram bots down with it. The gateway now lives in cloud-agi-bots.
        GATEWAY_ENABLED    = "false";
        MCP_ENABLED        = "1";
        CLAUDE_CLI_BASE_URL = "http://10.0.0.6:3117";
        # The claude agent model, sent explicitly by route.mjs so server.mjs never
        # substitutes its OWN OpenRouter DEFAULT_MODEL (which would make the superset
        # echo a foreign OpenRouter name back). Single declaration: build.json
        # runtime.claude_model. No `or` fallback on purpose — a default naming a
        # different model would be a second declaration of exactly the kind this file
        # exists to avoid (mirrors the GOOSE_MODEL reasoning above).
        CLAUDE_MODEL          = rt.claude_model;
        # /resume bound (#513). The cross-device store holds a 127 MB Claude
        # Code transcript; /resume reads only the tail of it. Declared once in
        # build.json runtime.sessions.resume — no `or` fallback on purpose, for
        # the same reason as GOOSE_MODEL above: a default here would be a second
        # declaration of a number that already has one.
        BRIDGE_RESUME_MAX_BYTES    = toString rt.sessions.resume.max_bytes;
        BRIDGE_RESUME_MAX_MESSAGES = toString rt.sessions.resume.max_messages;
        BRIDGE_RESUME_MAX_LISTED   = toString rt.sessions.resume.max_listed;
        # Session naming bound (#516). Every listed session gets a name, and
        # deriving it must never read a whole file — the same 127 MB transcript
        # is in the listing /sessions builds on every call. head/tail bound the
        # two positional reads deriveSessionName does; max_chars is the row
        # width. Declared once in build.json runtime.sessions.name, no `or`
        # fallback for the same reason as the resume bounds above.
        BRIDGE_NAME_HEAD_BYTES     = toString rt.sessions.name.head_bytes;
        BRIDGE_NAME_TAIL_BYTES     = toString rt.sessions.name.tail_bytes;
        BRIDGE_NAME_MAX_CHARS      = toString rt.sessions.name.max_chars;
      };
      volumes = [
        "my_ai_home:/home/appuser"
      ];
      healthcheck = {
        test     = [ "CMD" "curl" "-sf" "http://10.0.0.6:3217/health" ];
        interval = "30s";
        timeout  = "5s";
        retries  = 3;
      };
    };

    # ── cloud-agi-bots — the messaging gateway, split out by LIFETIME (#542) ──
    # Same image, different process and different reason to restart. my-ai-api
    # above is an agent runtime that every deploy recreates; these bots are a
    # service that must stay up across deploys. They shared one container until
    # today, so shipping goose took Telegram down — measured 2026-09-20, an
    # evicted deploy left my-ai-api in `created` and both bots were unreachable
    # for ~30 minutes.
    #
    # `entrypoint`, not `command`: the image's ENTRYPOINT is start.sh, which
    # execs server.mjs as its lifecycle process. A `command` override would be
    # passed to start.sh as arguments and ignored, and this container would
    # silently become a SECOND full API — two servers racing for port 3217.
    #
    # No ports, no healthcheck port: gateway.mjs only makes outbound calls and
    # long-polls Telegram. It still needs network_mode host to reach my-ai-api
    # on the WG address below.
    #
    # Supervision moves from the in-container `respawn` loop (#545) to docker's
    # own restart policy — one less supervisor, and a crash-looping gateway is
    # now visible in `docker ps` instead of hidden inside a healthy container.
    cloud-agi-bots = {
      image          = binariesImage;
      container_name = "cloud-agi-bots";
      restart        = "unless-stopped";
      network_mode   = "host";
      env_file       = [ "./.secrets" ];
      entrypoint     = [ "node" "/app/gateway.mjs" ];
      environment    = {
        GATEWAY_ENABLED     = "true";
        # The gateway calls the /v1 API in my-ai-api over the WG bind, exactly
        # as it did when both lived in one container. Same expression as above
        # so the two cannot drift to different addresses.
        MYAI_LOCAL_URL      = "http://${rt.wg_bind or "10.0.0.6"}:${toString (ports.app or 3217)}";
        CLAUDE_CLI_BASE_URL = "http://10.0.0.6:3117";
        CLAUDE_MODEL        = rt.claude_model;
        MATTERMOST_URL      = gw.mattermost_url      or "";
        MATTERMOST_ENABLED  = gw.mattermost_enabled  or "false";
        TELEGRAM_ALLOW_FROM = gw.telegram_allow_from or "";
      };
      # Start order only: compose cannot wait for the API to be ready here
      # without a healthcheck condition, and the gateway retries its first call
      # anyway. This stops the bots racing the API on a cold boot.
      depends_on = [ "my-ai-api" ];
    };
  };

  volumes = {
    my_ai_home = { name = "my-ai-api-home"; };
  };
}
