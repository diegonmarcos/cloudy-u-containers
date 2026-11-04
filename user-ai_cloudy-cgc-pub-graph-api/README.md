# SurrealDB Hybrid Knowledge Graph

**Status**: 🚧 Planning Phase
**Target**: oci-apps (3 vCPU, 16GB, aarch64)
**Port**: 8001

---

## Overview

The graph layer of the Hybrid Knowledge Graph, storing infrastructure topology, relationships, and temporal state using SurrealDB (multi-model database: graph + document + vector).

## Schema

### Nodes (Entities)

- **vm**: Virtual machines (5 instances)
- **service**: Services (44 total: Caddy, Authelia, PhotoPrism, etc.)
- **container**: Docker containers
- **log**: System logs, error messages
- **documentation**: README files, configs, guides
- **alert**: Triggered alerts from monitoring

### Edges (Relationships)

- **hosted_on**: service → vm
- **depends_on**: service → service (e.g., Vaultwarden depends on Authelia)
- **proxied_by**: service → service (e.g., everything proxied by Caddy)
- **caused_by**: log → service/container
- **similar_to**: log → log (based on vector similarity)

## Setup

### Deploy SurrealDB

```bash
cd ~/git/cloud-infra/a_solutions/ca-dat_kg-graph
./build.sh ship
```

This will:
1. Generate `docker-compose.yml` via Nix flake
2. Copy to oci-apps `/opt/containers/kg-graph/`
3. Start SurrealDB container

### Initialize Schema

```bash
ssh oci-apps
cd /opt/containers/kg-graph
surreal import --conn http://localhost:8001 --ns infra --db production schema.surql
```

### Seed Initial Data

```bash
./scripts/seed_from_architecture.sh
```

This parses `architecture.json` (or equivalent) and creates:
- 5 VM nodes
- 44 service nodes
- ~100 relationship edges

## Querying

### SurrealQL Examples

**Find all services on a VM**:
```surql
SELECT <-hosted_on<-service.name
FROM vm
WHERE alias = 'gcp-proxy';
```

**Blast radius analysis**:
```surql
SELECT
  <-hosted_on<-service.* AS direct_services,
  <-hosted_on<-service<-depends_on<-service.* AS dependents
FROM vm
WHERE alias = 'oci-analytics';
```

**Hybrid search (semantic + graph)**:
```surql
LET $vec = vector::embed("authentication error");
LET $matches = (
  SELECT * FROM log
  WHERE vector::similarity::cosine(embedding, $vec) > 0.8
  LIMIT 5
);
SELECT $matches.*, ->caused_by->service.name AS affected_services
FROM $matches;
```

## Vector Embeddings

Each node type (service, log, documentation) has an `embedding` field (768-dim vector from nomic-embed-text).

**Index**:
```surql
DEFINE INDEX embedding_idx ON service
FIELDS embedding MTREE DIMENSION 768;
```

This enables fast similarity search (< 50ms for 10,000 nodes).

## Data Persistence

**Location**: `/opt/data/surrealdb/` on oci-apps
**Backup**: Weekly via bup (see backup system)
**Retention**:
- Logs: 30 days
- Service/VM state: Forever
- Documentation: Forever (updated on git push)

## Access

**Internal** (oci-apps only):
```bash
surreal sql --conn http://localhost:8001 --ns infra --db production
```

**Via Rig API** (from anywhere):
```bash
curl -X POST https://api.diegonmarcos.com/rig/kg/query \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "What services depend on Authelia?"}'
```

**Via MCP** (Claude Code):
```
kg_hybrid_search("disk space issues")
kg_blast_radius("vm", "oci-analytics")
```

## Maintenance

### Daily Indexing

Automated via Rig Workflow 2 (3 AM daily):
- New logs embedded and inserted
- Container events synced
- Stale logs pruned (> 30 days)

### Manual Queries

```bash
# How many logs today?
surreal sql --conn http://localhost:8001
> SELECT count() FROM log WHERE timestamp > time::now() - 1d;

# Top 5 most restarted services this week
> SELECT name, count(<-caused_by<-log) AS restart_count
  FROM service
  ORDER BY restart_count DESC
  LIMIT 5;
```

## Troubleshooting

**Issue**: SurrealDB not starting
```bash
ssh oci-apps "docker logs surrealdb"
ssh oci-apps "docker restart surrealdb"
```

**Issue**: Queries timing out
- Check disk space: `df -h /opt/data/surrealdb`
- Check index health: `SHOW INDEX`

**Issue**: Schema out of date
```bash
# Re-import schema (non-destructive)
surreal import --conn http://localhost:8001 --ns infra --db production schema.surql
```

## Development

### Local Testing (Desktop)

```bash
# SSH tunnel to oci-apps
ssh -L 8001:localhost:8001 oci-apps -N &

# Connect locally
surreal sql --conn http://localhost:8001 --ns infra --db production
```

## License

Private - Diego Nepomuceno Marcos
