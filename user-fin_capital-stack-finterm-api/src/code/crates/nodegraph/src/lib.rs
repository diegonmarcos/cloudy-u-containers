//! Directed-graph primitives for the visual node editor.
//!
//! Phase 9a ships the data model + evaluation order; `egui_node_graph2`
//! bindings (drag-and-drop editor UI) arrive in Phase 9b. Graphs serialize
//! to JSON in a stable format — matches upstream C++ node editor on disk so
//! user pipelines survive the port.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("unknown node: {0}")]
    UnknownNode(String),
    #[error("duplicate node id: {0}")]
    DuplicateNode(String),
    #[error("graph contains a cycle involving node {0}")]
    Cycle(String),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// A single workflow node.
///
/// `kind` is the node type (e.g. "quote", "ema", "sharpe"). Full type
/// registry for the UI — palette panel, parameter schemas — lands in Phase 9b.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
}

/// Directed edge from `from_node` to `to_node` with optional port names.
/// Matches upstream shape exactly so saved pipelines round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Edge {
    pub from_node: String,
    pub to_node: String,
    #[serde(default)]
    pub from_port: Option<String>,
    #[serde(default)]
    pub to_port: Option<String>,
}

/// Whole graph: nodes + edges. Designed to be trivially JSON-serialisable.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    pub fn from_json(raw: &str) -> Result<Self> {
        Ok(serde_json::from_str(raw)?)
    }

    pub fn to_json_pretty(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn add_node(&mut self, node: Node) -> Result<()> {
        if self.nodes.iter().any(|n| n.id == node.id) {
            return Err(Error::DuplicateNode(node.id));
        }
        self.nodes.push(node);
        Ok(())
    }

    pub fn add_edge(&mut self, edge: Edge) -> Result<()> {
        if !self.nodes.iter().any(|n| n.id == edge.from_node) {
            return Err(Error::UnknownNode(edge.from_node));
        }
        if !self.nodes.iter().any(|n| n.id == edge.to_node) {
            return Err(Error::UnknownNode(edge.to_node));
        }
        self.edges.push(edge);
        Ok(())
    }

    /// Kahn's topological sort. Returns node ids in an evaluation-safe order.
    /// Detects cycles and reports the first node stuck in one.
    pub fn topological_order(&self) -> Result<Vec<String>> {
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        for n in &self.nodes {
            in_degree.insert(n.id.as_str(), 0);
        }
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
        for e in &self.edges {
            *in_degree
                .get_mut(e.to_node.as_str())
                .ok_or_else(|| Error::UnknownNode(e.to_node.clone()))? += 1;
            adj.entry(e.from_node.as_str())
                .or_default()
                .push(e.to_node.as_str());
        }
        let mut q: VecDeque<&str> = in_degree
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(k, _)| *k)
            .collect();
        let mut out: Vec<String> = Vec::with_capacity(self.nodes.len());
        while let Some(n) = q.pop_front() {
            out.push(n.to_string());
            if let Some(children) = adj.get(n) {
                for &c in children {
                    let d = in_degree.get_mut(c).unwrap();
                    *d -= 1;
                    if *d == 0 {
                        q.push_back(c);
                    }
                }
            }
        }
        if out.len() != self.nodes.len() {
            let stuck = self
                .nodes
                .iter()
                .find(|n| !out.contains(&n.id))
                .expect("cycle must have an unvisited node");
            return Err(Error::Cycle(stuck.id.clone()));
        }
        Ok(out)
    }

    /// Fast cycle check (same algorithm as `topological_order` without
    /// building the order vector).
    pub fn has_cycle(&self) -> bool {
        self.topological_order().is_err()
    }

    /// Set of ancestors of `node_id` (transitive upstream dependencies).
    pub fn ancestors(&self, node_id: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut stack = vec![node_id.to_string()];
        while let Some(cur) = stack.pop() {
            for e in &self.edges {
                if e.to_node == cur && out.insert(e.from_node.clone()) {
                    stack.push(e.from_node.clone());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: &str) -> Node {
        Node {
            id: id.into(),
            kind: kind.into(),
            params: Default::default(),
        }
    }

    fn edge(from: &str, to: &str) -> Edge {
        Edge {
            from_node: from.into(),
            to_node: to.into(),
            from_port: None,
            to_port: None,
        }
    }

    #[test]
    fn add_node_and_edge() {
        let mut g = Graph::default();
        g.add_node(node("a", "quote")).unwrap();
        g.add_node(node("b", "ema")).unwrap();
        g.add_edge(edge("a", "b")).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn duplicate_node_rejected() {
        let mut g = Graph::default();
        g.add_node(node("a", "quote")).unwrap();
        let err = g.add_node(node("a", "other")).unwrap_err();
        assert!(matches!(err, Error::DuplicateNode(_)));
    }

    #[test]
    fn edge_to_unknown_node_rejected() {
        let mut g = Graph::default();
        g.add_node(node("a", "quote")).unwrap();
        let err = g.add_edge(edge("a", "missing")).unwrap_err();
        assert!(matches!(err, Error::UnknownNode(_)));
    }

    #[test]
    fn topological_order_straight_line() {
        let mut g = Graph::default();
        g.add_node(node("a", "x")).unwrap();
        g.add_node(node("b", "x")).unwrap();
        g.add_node(node("c", "x")).unwrap();
        g.add_edge(edge("a", "b")).unwrap();
        g.add_edge(edge("b", "c")).unwrap();
        let order = g.topological_order().unwrap();
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("b") < pos("c"));
    }

    #[test]
    fn topological_order_diamond() {
        let mut g = Graph::default();
        for id in ["a", "b", "c", "d"] {
            g.add_node(node(id, "x")).unwrap();
        }
        g.add_edge(edge("a", "b")).unwrap();
        g.add_edge(edge("a", "c")).unwrap();
        g.add_edge(edge("b", "d")).unwrap();
        g.add_edge(edge("c", "d")).unwrap();
        let order = g.topological_order().unwrap();
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("a") < pos("c"));
        assert!(pos("b") < pos("d"));
        assert!(pos("c") < pos("d"));
    }

    #[test]
    fn cycle_detection() {
        let mut g = Graph::default();
        for id in ["a", "b", "c"] {
            g.add_node(node(id, "x")).unwrap();
        }
        g.add_edge(edge("a", "b")).unwrap();
        g.add_edge(edge("b", "c")).unwrap();
        g.add_edge(edge("c", "a")).unwrap();
        assert!(g.has_cycle());
        assert!(matches!(g.topological_order(), Err(Error::Cycle(_))));
    }

    #[test]
    fn ancestors_transitive() {
        let mut g = Graph::default();
        for id in ["a", "b", "c", "d"] {
            g.add_node(node(id, "x")).unwrap();
        }
        g.add_edge(edge("a", "b")).unwrap();
        g.add_edge(edge("b", "c")).unwrap();
        g.add_edge(edge("d", "c")).unwrap();
        let anc = g.ancestors("c");
        assert!(anc.contains("a"));
        assert!(anc.contains("b"));
        assert!(anc.contains("d"));
        assert!(!anc.contains("c"));
    }

    #[test]
    fn json_round_trip() {
        let mut g = Graph::default();
        let mut params = serde_json::Map::new();
        params.insert("period".into(), serde_json::json!(20));
        g.add_node(Node {
            id: "a".into(),
            kind: "ema".into(),
            params,
        })
        .unwrap();
        g.add_node(node("b", "quote")).unwrap();
        g.add_edge(Edge {
            from_node: "b".into(),
            to_node: "a".into(),
            from_port: Some("price".into()),
            to_port: Some("input".into()),
        })
        .unwrap();
        let json = g.to_json_pretty().unwrap();
        let back = Graph::from_json(&json).unwrap();
        assert_eq!(g, back);
    }

    #[test]
    fn empty_graph_topological_order_is_empty() {
        let g = Graph::default();
        assert_eq!(g.topological_order().unwrap(), Vec::<String>::new());
    }
}
