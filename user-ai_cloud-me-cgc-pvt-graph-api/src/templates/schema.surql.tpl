-- ============================================================
-- SurrealDB Schema: Infrastructure Hybrid Knowledge Graph
-- Namespace: infra | Database: production
-- ============================================================

-- Initialize namespace and database
DEFINE NAMESPACE IF NOT EXISTS infra;
USE NS infra;
DEFINE DATABASE IF NOT EXISTS production;
USE DB production;

-- ============================================================
-- NODE TABLES
-- ============================================================

-- Virtual Machines
DEFINE TABLE vm SCHEMAFULL;
DEFINE FIELD name ON vm TYPE string;
DEFINE FIELD alias ON vm TYPE string;
DEFINE FIELD ip ON vm TYPE string;
DEFINE FIELD wg_ip ON vm TYPE option<string>;
DEFINE FIELD user ON vm TYPE string;
DEFINE FIELD provider ON vm TYPE string;         -- gcp, oci, vast.ai
DEFINE FIELD arch ON vm TYPE option<string>;     -- x86_64, aarch64
DEFINE FIELD cpu_count ON vm TYPE option<int>;
DEFINE FIELD ram_gb ON vm TYPE option<int>;
DEFINE FIELD disk_gb ON vm TYPE option<int>;
DEFINE FIELD description ON vm TYPE string;
DEFINE FIELD status ON vm TYPE string DEFAULT "unknown";  -- healthy, degraded, down, unknown
DEFINE FIELD embedding ON vm TYPE option<array<float>>;
DEFINE FIELD updated_at ON vm TYPE datetime DEFAULT time::now();

DEFINE INDEX vm_alias ON vm FIELDS alias UNIQUE;

-- Services
DEFINE TABLE service SCHEMAFULL;
DEFINE FIELD name ON service TYPE string;
DEFINE FIELD category ON service TYPE string;     -- app, mic, sec, tools, cloud, data, fin
DEFINE FIELD description ON service TYPE string;
DEFINE FIELD domain ON service TYPE option<string>;
DEFINE FIELD port ON service TYPE option<int>;
DEFINE FIELD availability ON service TYPE string DEFAULT "unknown";  -- 24/7, wake-on-demand, manual
DEFINE FIELD status ON service TYPE string DEFAULT "unknown";
DEFINE FIELD embedding ON service TYPE option<array<float>>;
DEFINE FIELD updated_at ON service TYPE datetime DEFAULT time::now();

DEFINE INDEX service_name ON service FIELDS name UNIQUE;

-- Containers (Docker)
DEFINE TABLE container SCHEMAFULL;
DEFINE FIELD name ON container TYPE string;
DEFINE FIELD image ON container TYPE option<string>;
DEFINE FIELD status ON container TYPE string DEFAULT "unknown";  -- running, stopped, restarting, unhealthy
DEFINE FIELD restart_count ON container TYPE int DEFAULT 0;
DEFINE FIELD last_restart ON container TYPE option<datetime>;
DEFINE FIELD embedding ON container TYPE option<array<float>>;
DEFINE FIELD updated_at ON container TYPE datetime DEFAULT time::now();

DEFINE INDEX container_name ON container FIELDS name;

-- Log entries (temporal, prunable)
DEFINE TABLE log SCHEMAFULL;
DEFINE FIELD timestamp ON log TYPE datetime DEFAULT time::now();
DEFINE FIELD source ON log TYPE string;          -- vm:oci-apps, service:authelia, container:xyz
DEFINE FIELD level ON log TYPE string;           -- error, warn, info, debug
DEFINE FIELD message ON log TYPE string;
DEFINE FIELD embedding ON log TYPE option<array<float>>;

DEFINE INDEX log_timestamp ON log FIELDS timestamp;
DEFINE INDEX log_source ON log FIELDS source;
DEFINE INDEX log_level ON log FIELDS level;

-- Documentation (READMEs, configs, runbooks)
DEFINE TABLE documentation SCHEMAFULL;
DEFINE FIELD path ON documentation TYPE string;   -- ~/git/cloud-t-infra/README.md
DEFINE FIELD title ON documentation TYPE option<string>;
DEFINE FIELD content_hash ON documentation TYPE string;  -- detect changes for re-embedding
DEFINE FIELD embedding ON documentation TYPE option<array<float>>;
DEFINE FIELD updated_at ON documentation TYPE datetime DEFAULT time::now();

DEFINE INDEX doc_path ON documentation FIELDS path UNIQUE;

-- Audit log (append-only record of all Rig actions)
DEFINE TABLE audit_log SCHEMAFULL;
DEFINE FIELD timestamp ON audit_log TYPE datetime DEFAULT time::now();
DEFINE FIELD workflow ON audit_log TYPE string;    -- self_healing, kg_maintenance, agentic
DEFINE FIELD action ON audit_log TYPE string;      -- health_check, diagnose, execute, embed, prune
DEFINE FIELD command ON audit_log TYPE option<string>;
DEFINE FIELD risk_level ON audit_log TYPE option<string>;  -- low, medium, high
DEFINE FIELD human_approved ON audit_log TYPE option<bool>;
DEFINE FIELD result ON audit_log TYPE string;      -- success, failure, skipped
DEFINE FIELD detail ON audit_log TYPE option<string>;

DEFINE INDEX audit_timestamp ON audit_log FIELDS timestamp;
DEFINE INDEX audit_workflow ON audit_log FIELDS workflow;

-- ============================================================
-- EDGE TABLES (relationships)
-- ============================================================

-- service -> hosted_on -> vm
DEFINE TABLE hosted_on SCHEMAFULL TYPE RELATION IN service OUT vm;
DEFINE FIELD created_at ON hosted_on TYPE datetime DEFAULT time::now();

-- service -> depends_on -> service (inferred from Docker Compose)
DEFINE TABLE depends_on SCHEMAFULL TYPE RELATION IN service OUT service;
DEFINE FIELD type ON depends_on TYPE string DEFAULT "runtime";  -- runtime, network, data
DEFINE FIELD created_at ON depends_on TYPE datetime DEFAULT time::now();

-- service -> proxied_by -> service (inferred from Caddyfile)
DEFINE TABLE proxied_by SCHEMAFULL TYPE RELATION IN service OUT service;
DEFINE FIELD domain ON proxied_by TYPE option<string>;
DEFINE FIELD created_at ON proxied_by TYPE datetime DEFAULT time::now();

-- service -> authenticated_by -> service (inferred from Authelia config)
DEFINE TABLE authenticated_by SCHEMAFULL TYPE RELATION IN service OUT service;
DEFINE FIELD created_at ON authenticated_by TYPE datetime DEFAULT time::now();

-- vm -> connected_to -> vm (inferred from WireGuard configs)
DEFINE TABLE connected_to SCHEMAFULL TYPE RELATION IN vm OUT vm;
DEFINE FIELD interface ON connected_to TYPE string DEFAULT "wg0";
DEFINE FIELD created_at ON connected_to TYPE datetime DEFAULT time::now();

-- service -> runs_container -> container
DEFINE TABLE runs_container SCHEMAFULL TYPE RELATION IN service OUT container;
DEFINE FIELD created_at ON runs_container TYPE datetime DEFAULT time::now();

-- log -> caused_by -> service|container
DEFINE TABLE caused_by TYPE RELATION;
DEFINE FIELD created_at ON caused_by TYPE datetime DEFAULT time::now();

-- ============================================================
-- VECTOR INDEXES (data-driven from build-kg-graph_schema.json)
-- Embedder model:     @EMBEDDER_MODEL@
-- Embedder dimension: @EMBEDDER_DIM@
-- Embedder enabled:   @EMBEDDER_ENABLED@
-- ============================================================

@VECTOR_INDEXES_DDL@

-- ============================================================
-- HELPER QUERIES (for reference, not executed on schema load)
-- ============================================================

-- Find all services on a VM:
-- SELECT <-hosted_on<-service.* FROM vm WHERE alias = 'gcp-proxy';

-- Find blast radius of restarting a service:
-- SELECT
--   ->depends_on->service.name AS direct_deps,
--   ->proxied_by->service.name AS proxy,
--   ->authenticated_by->service.name AS auth
-- FROM service WHERE name = 'authelia';

-- Hybrid search (requires external embedding as parameter):
-- LET $vec = $query_embedding;
-- SELECT *, vector::similarity::cosine(embedding, $vec) AS score
-- FROM service
-- WHERE embedding IS NOT NONE AND score > 0.8
-- ORDER BY score DESC LIMIT 10;
