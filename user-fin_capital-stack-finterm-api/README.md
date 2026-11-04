# ac-fin_capital-stack-finterminal-api

Backend-only deployment of the Fincept Terminal Rust port (service alias: **capital-stack-finterminal-api**).

- **Source**: `src/code/` (Rust workspace; upstream identity stays `fincept-*` for the library crates)
- **Binary**: `crates/server` → `fin-api` (Cargo `[[bin]] name = "fin-api"`)
- **Container**: `ghcr.io/diegonmarcos/capital-stack-finterminal-api:latest`
- **Port**: 8340 (internal, env `FIN_API_PORT`) → Caddy path-based hub at `https://api.diegonmarcos.com/capital-stack-finterminal-api/*`
- **Auth**: Authelia 2FA (`/health` is public; everything else requires login or bearer token)
- **Health**: `GET /capital-stack-finterminal-api/health`

## Endpoints (under `/capital-stack-finterminal-api/*`)

```
GET  /capital-stack-finterminal-api/health
GET  /capital-stack-finterminal-api/api/v1/info
GET  /capital-stack-finterminal-api/api/v1/personas
POST /capital-stack-finterminal-api/api/v1/personas/:id/score
GET  /capital-stack-finterminal-api/api/v1/topics
POST /capital-stack-finterminal-api/api/v1/topics/:topic/publish
GET  /capital-stack-finterminal-api/api/v1/topics/:topic/peek
GET  /capital-stack-finterminal-api/api/v1/mcp/tools
POST /capital-stack-finterminal-api/api/v1/mcp/tools/:name/call
GET  /capital-stack-finterminal-api/api/v1/ws              # WebSocket — {op:subscribe|publish|ping}
```

## Deploy

```bash
cd ~/git/cloud-infra/a_solutions/ac-fin_capital-stack-finterminal-api
./build.sh all      # nix + secrets  (safe)
./build.sh ship     # nix + secrets + rsync + compose  (TOUCHES VM — ask first)
```

Frontends (desktop egui, WASM web) consume this via `fincept-client` (the
typed Rust client kept under its upstream name) → do not call library
crates directly. Adding a new endpoint = add a route to
`src/code/crates/server/src/routes/` + a method to
`src/code/crates/client/src/lib.rs`.
