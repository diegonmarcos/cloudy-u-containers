//! Shared server state. Cloned cheaply (everything is `Arc`).

use fincept_agents_investors::Persona;
use fincept_datahub::DataHub;
use fincept_mcp::Registry as McpRegistry;
use std::collections::HashMap;
use std::sync::Arc;

use crate::finterm::Finterm;

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<DataHub>,
    pub personas: Arc<HashMap<String, Persona>>,
    pub mcp: Arc<McpRegistry>,
    pub version: &'static str,
    /// FinTerm fetch jobs (generated fetchers.json), their status and the client the /v1 routes fetch through on demand.
    pub finterm: Arc<Finterm>,
}

impl AppState {
    pub fn try_new() -> anyhow::Result<Self> {
        let hub = DataHub::new();
        let personas = fincept_agents_investors::InvestorAgent::default_roster()
            .map_err(|e| anyhow::anyhow!("persona roster: {e}"))?;
        let mcp = McpRegistry::with_defaults();
        let finterm = Finterm::from_embedded()?;
        Ok(Self {
            hub,
            personas: Arc::new(personas),
            mcp: Arc::new(mcp),
            version: env!("CARGO_PKG_VERSION"),
            finterm: Arc::new(finterm),
        })
    }
}
