//! LLM provider abstraction.
//!
//! Upstream Fincept Terminal supports 8 providers (OpenAI, Anthropic, Gemini,
//! Groq, DeepSeek, MiniMax, OpenRouter, Ollama). Phase 6a ships the contract
//! and a deterministic `MockProvider` so the rest of the agent layer can be
//! unit-tested without network. Phase 6b layers real providers (`rig` crate
//! and vendor SDKs) against this exact trait.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("provider '{provider}' failed: {message}")]
    ProviderFailed { provider: String, message: String },
    #[error("unknown provider: {0}")]
    UnknownProvider(String),
    #[error("rate limited")]
    RateLimited,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Message in a chat. Mirrors the shape used by OpenAI/Anthropic SDKs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse>;
}

/// Deterministic mock: responds with a canned string and token counts based
/// on input length. Useful for testing agent orchestration without network.
pub struct MockProvider {
    pub response: String,
}

impl MockProvider {
    #[must_use]
    pub fn new(response: impl Into<String>) -> Self {
        Self {
            response: response.into(),
        }
    }
}

#[async_trait]
impl Provider for MockProvider {
    fn id(&self) -> &'static str {
        "mock"
    }
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> {
        let prompt_tokens = req
            .messages
            .iter()
            .map(|m| m.content.split_whitespace().count() as u32)
            .sum();
        let completion_tokens = self.response.split_whitespace().count() as u32;
        Ok(ChatResponse {
            content: self.response.clone(),
            prompt_tokens,
            completion_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_provider_counts_tokens() {
        let p = MockProvider::new("hello world");
        let out = p
            .complete(ChatRequest {
                model: "mock-1".into(),
                messages: vec![ChatMessage {
                    role: Role::User,
                    content: "one two three".into(),
                }],
                temperature: None,
                max_tokens: None,
            })
            .await
            .unwrap();
        assert_eq!(out.content, "hello world");
        assert_eq!(out.prompt_tokens, 3);
        assert_eq!(out.completion_tokens, 2);
    }
}
