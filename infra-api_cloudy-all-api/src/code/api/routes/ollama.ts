import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { registry } from "../../registry/index.js";

const OLLAMA_BASE = registry.getBaseUrl("ollama") ?? "http://10.0.0.8:11434";

export async function registerOllamaRoutes(app: FastifyInstance) {
  app.get("/ollama/models", {
    schema: {
      tags: ["Ollama"],
      summary: "List available models",
    },
  }, async (_req, reply) => {
    const result = rawHttpRequest("GET", `${OLLAMA_BASE}/api/tags`);
    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });

  app.post<{
    Body: { model: string; prompt: string; stream?: boolean };
  }>("/ollama/generate", {
    schema: {
      tags: ["Ollama"],
      summary: "Generate text completion",
      body: {
        type: "object",
        properties: {
          model: { type: "string" },
          prompt: { type: "string" },
          stream: { type: "boolean", default: false },
        },
        required: ["model", "prompt"],
      },
    },
  }, async (req, reply) => {
    const result = rawHttpRequest("POST", `${OLLAMA_BASE}/api/generate`, JSON.stringify({
      model: req.body.model,
      prompt: req.body.prompt,
      stream: false,
    }), 120_000);
    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });

  app.post<{
    Body: { model: string; messages: Array<{ role: string; content: string }> };
  }>("/ollama/chat", {
    schema: {
      tags: ["Ollama"],
      summary: "Chat completion",
      body: {
        type: "object",
        properties: {
          model: { type: "string" },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
        },
        required: ["model", "messages"],
      },
    },
  }, async (req, reply) => {
    const result = rawHttpRequest("POST", `${OLLAMA_BASE}/api/chat`, JSON.stringify({
      model: req.body.model,
      messages: req.body.messages,
      stream: false,
    }), 120_000);
    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });
}
