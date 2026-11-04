# my-ai-api

**Sibling of `claude-superset-api`, routing OpenRouter (not Claude), with the
same Headroom compression hop.** The agent face for this stack is **goose**
(`my-ai` wraps goose; `claude-superset` keeps the Claude CLI).

One polyglot container on `oci-apps` (10.0.0.6, WG-only — never public):

```
OpenAI    /v1/chat/completions   ─┐
Ollama    /api/chat, /api/tags    ├─→ compress(messages) ─→ OpenRouter /v1/chat/completions
Anthropic /v1/messages           ─┘   (Headroom sidecar)      (container's OPENROUTER_API_KEY)
```

- **Compression plugins** (the value-add shared with claude-superset-api):
  vendored Headroom (Apache-2.0) — `SmartCrusher` JSON + AST `CodeCompressor`
  + RTK / Caveman-style pipeline stages. Exposed as `/stats` + `/dashboard`.
- **No Claude.** No `claude` CLI in the image (slimmer), no Anthropic proxy
  face, no Claude subscription login. The Anthropic `/v1/messages` endpoint is
  a **shape-translation shim onto OpenRouter** — it is *not* Claude.
- **One upstream (OpenRouter)**, declared in `build.json` `runtime.upstream`.
  The container injects `OPENROUTER_API_KEY` from `src/secrets.yaml`; clients
  may send any placeholder `Authorization` (ignored unless `passthrough_auth`
  is flipped on).

## Ports (oci-apps, WG-only)

| face     | port  | listener                                  |
|----------|-------|-------------------------------------------|
| app      | 3217  | Node front — OpenAI /v1 + Anthropic /v1   |
| ollama   | 12436 | Ollama mimic (`/api/chat`, `/api/tags`)   |
| headroom | 8890  | compress_service.py + savings dashboard   |

(`claude-superset-api` uses 3117/11436/8788/8789 on the same VM — the two
stacks coexist without port collisions.)

## Secret: `OPENROUTER_API_KEY`

The container needs an OpenRouter API key to forward chat requests. The fleet
pattern is a sops-encrypted `src/secrets.yaml`; the build engine decrypts it to
`dist/.secrets` and compose wires `env_file: dist/.secrets`.

1. Copy the example and add your key:
   ```sh
   cp src/secrets.yaml.example src/secrets.yaml
   # edit src/secrets.yaml → OPENROUTER_API_KEY: sk-or-v1-…your-key…
   ```
2. sops-encrypt in place (uses the fleet age key at
   `~/.config/sops/age/keys.txt`):
   ```sh
   sops -e -i src/secrets.yaml
   ```
3. Re-ship: `./build.sh ship`.

Without `src/secrets.yaml`, the secrets step skips gracefully and the
container still comes up, but **chat requests 502** (`OPENROUTER_API_KEY unset`)
until the secret is wired. `/health` reports `openrouter_key: false` while
unset — handy for diagnosing.

## Ship

```sh
cd a_solutions/user-ai_my-ai-api
./build.sh ship          # build (Rust wheel + Node) → GHCR → rsync → compose up → health
./build.sh logs          # tail container logs
./build.sh health        # healthcheck
```

`build.sh` is a symlink to the shared container engine
(`9_others/src/deploy/scripts/cloud-ship-container-engine.sh`); all behaviour is
data-driven from `build.json`.

## Client wiring (my-ai / goose)

`my-ai` points goose at this service as a custom OpenAI provider:

```
GOOSE_PROVIDER=openai
OPENAI_BASE_URL=http://10.0.0.6:3217/v1   # my-ai-api (WG)
OPENAI_API_KEY=placeholder                # the container injects the real key
GOOSE_MODEL=z-ai/glm-5                    # any OpenRouter slug (or a short alias)
```

The my-ai Rust CLI sets these envs from `src/data/endpoints.json`
(`my-ai-core`), probes `/readyz`, and execs `goose session`. Compression
plugins toggle via env (`RTK_ENABLED`, `CAVEMAN_ENABLED`, …) the same way the
claude stack does — see the my-ai `--help`.

## Layout

```
user-ai_my-ai-api/
├── build.json                       # data-driven build/deploy config
├── build.sh  → ../../9_others/…/cloud-ship-container-engine.sh
├── README.md
└── src/
    ├── build.json                   # (mirror; engine reads this)
    ├── build-cloud-agi-goose.json   # per-container config (symlink → cloud-infra dist; named after container_name)
    ├── secrets.yaml.example         # OPENROUTER_API_KEY (sops-encrypt → secrets.yaml)
    └── code/
        ├── Dockerfile               # 2-stage: Rust wheel (headroom) → Python+Node runtime
        ├── package.json
        ├── server.mjs               # OpenAI/Ollama/Anthropic → compress → OpenRouter
        ├── start.sh                 # supervisor: compress_service + node front
        ├── py/compress_service.py   # FastAPI sidecar over vendored Headroom
        └── vendor/headroom/         # Apache-2.0, vendored (same source as claude-superset-api)
```

## Relationship to `claude-superset-api`

|                       | `claude-superset-api`        | `my-ai-api` (this)              |
|-----------------------|------------------------------|--------------------------------|
| upstream              | Claude subscription (`claude -p`) | OpenRouter (HTTP)         |
| agent (client)        | `claude` CLI                 | `goose` (via `my-ai`)          |
| Anthropic `/v1/messages` face | real Claude          | **shim** → OpenRouter (NOT Claude) |
| headroom transparent-proxy face | yes (`anthropic` backend) | **no** (Node front forwards) |
| `claude` CLI in image | yes (npm `@anthropic-ai/claude-code`) | **no** (slimmer) |
| Headroom compress hop | yes                          | **yes** (same vendored engine) |
| session store         | Claude Code `.jsonl`         | goose `.jsonl`                 |
