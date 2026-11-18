use std::sync::Arc;

use crate::local_dispatch::authoring::Template;
use crate::server::Fault;

pub fn bundled() -> Result<Arc<[Template]>, Fault> {
    serde_json::from_str::<Vec<Template>>(include_str!("../../assets/agent-templates.json"))
        .map(Arc::from)
        .map_err(|error| Fault::new("agent_templates", error.to_string()))
}
