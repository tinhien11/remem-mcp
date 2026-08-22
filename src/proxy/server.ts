/**
 * Memory Proxy — HTTP proxy that injects memory into LLM requests.
 *
 * Adapted from TencentDB Agent Memory's Memory Proxy concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * Instead of requiring MCP hooks, the agent points its base URL to this proxy.
 * The proxy intercepts /v1/chat/completions (OpenAI) and /v1/messages (Anthropic),
 * injects memory into the system prompt, and forwards to the upstream LLM.
 *
 * This enables zero-code integration with any agent that calls OpenAI/Anthropic APIs.
 */

import {
  createServer,
  request as httpRequestHttp,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpRequest } from "node:https";
import { URL } from "node:url";
import { LocalEmbedder } from "../embedding/local.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { captureConversation, captureConversationAnthropic } from "./capture.js";
import { injectMemory } from "./inject.js";
import { SessionStore } from "./session.js";

export interface ProxyConfig {
  port: number;
  upstreamUrl: string;
  upstreamApiKey?: string;
  dbPath: string;
  /** Whether to auto-capture conversations. Default: true. */
  autoCapture: boolean;
  /** Whether to inject memory into system prompt. Default: true. */
  injectMemory: boolean;
}

/** Default proxy config from environment variables. */
export function loadProxyConfig(): ProxyConfig {
  return {
    port: parseInt(process.env.REMEM_PROXY_PORT ?? "8765", 10),
    upstreamUrl: process.env.REMEM_UPSTREAM_URL ?? "https://api.openai.com",
    upstreamApiKey: process.env.REMEM_UPSTREAM_API_KEY ?? process.env.OPENAI_API_KEY,
    dbPath: process.env.REMEM_DB_PATH ?? "",
    autoCapture: process.env.REMEM_PROXY_CAPTURE !== "false",
    injectMemory: process.env.REMEM_PROXY_INJECT !== "false",
  };
}

/** Start the Memory Proxy server. */
export async function startProxyServer(config: ProxyConfig): Promise<void> {
  if (!config.dbPath) {
    throw new Error("REMEM_DB_PATH is required for proxy mode");
  }

  const storage = new SQLiteBackend(config.dbPath);
  const embedder = new LocalEmbedder();
  const sessions = new SessionStore();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", proxy: true, upstream: config.upstreamUrl }));
        return;
      }

      // Session init — user selects team/agent/task
      if (url.pathname === "/session/init" && req.method === "POST") {
        const body = await readBody(req);
        const { teamId, agentId, taskId, userId } = JSON.parse(body);
        const sessionId = sessions.create({ teamId, agentId, taskId, userId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId }));
        return;
      }

      // OpenAI protocol: POST /v1/chat/completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        await handleOpenAIRequest(req, res, config, storage, embedder, sessions);
        return;
      }

      // Anthropic protocol: POST /v1/messages
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        await handleAnthropicRequest(req, res, config, storage, embedder, sessions);
        return;
      }

      // Pass-through for other endpoints (e.g., /v1/models)
      await passthrough(req, res, config);
    } catch (err) {
      console.error("[remem-mcp proxy] Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Proxy internal error", detail: String(err) }));
    }
  });

  server.listen(config.port, () => {
    console.log(`[remem-mcp proxy] Listening on http://localhost:${config.port}`);
    console.log(`[remem-mcp proxy] Upstream: ${config.upstreamUrl}`);
    console.log(`[remem-mcp proxy] Endpoints:`);
    console.log(`  POST /v1/chat/completions  (OpenAI protocol)`);
    console.log(`  POST /v1/messages          (Anthropic protocol)`);
    console.log(`  POST /session/init         (bind team/agent/task)`);
    console.log(`  GET  /health               (health check)`);
  });
}

/** Handle OpenAI /v1/chat/completions request. */
async function handleOpenAIRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  storage: SQLiteBackend,
  embedder: LocalEmbedder,
  sessions: SessionStore,
): Promise<void> {
  const body = await readBody(req);
  const parsed = JSON.parse(body);

  // Inject memory into system prompt
  if (config.injectMemory) {
    const lastUserMessage = getLastUserMessage(parsed.messages ?? []);
    const sessionBinding = sessions.getFromHeaders(req.headers);
    console.error(
      `[proxy] inject: userMsg="${lastUserMessage?.slice(0, 50)}" binding=${JSON.stringify(sessionBinding)}`,
    );
    if (lastUserMessage) {
      try {
        const injected = await injectMemory(
          parsed.messages ?? [],
          lastUserMessage,
          storage,
          embedder,
          sessionBinding,
        );
        const hasMemory = injected.some((m: { content: string }) => m.content.includes("<remem-mcp>"));
        console.error(`[proxy] inject result: hasMemory=${hasMemory}, messages=${injected.length}`);
        parsed.messages = injected;
      } catch (e) {
        console.error(`[proxy] inject error:`, e);
      }
    }
  }

  // Forward to upstream
  const upstreamResp = await forwardRequest(
    config.upstreamUrl,
    "/v1/chat/completions",
    "POST",
    JSON.stringify(parsed),
    config.upstreamApiKey,
    req.headers,
  );

  // Auto-capture the conversation
  if (config.autoCapture) {
    const responseText = extractOpenAIResponse(upstreamResp.body);
    if (responseText) {
      captureConversation(
        parsed.messages ?? [],
        responseText,
        storage,
        sessions.getFromHeaders(req.headers),
      ).catch((e: unknown) => console.error("[remem-mcp proxy] Capture error:", e));
    }
  }

  // Return response to client
  res.writeHead(upstreamResp.statusCode, upstreamResp.headers);
  res.end(upstreamResp.body);
}

/** Handle Anthropic /v1/messages request. */
async function handleAnthropicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
  storage: SQLiteBackend,
  embedder: LocalEmbedder,
  sessions: SessionStore,
): Promise<void> {
  const body = await readBody(req);
  const parsed = JSON.parse(body);

  // Inject memory into system prompt
  if (config.injectMemory) {
    const lastUserMessage = getLastUserMessageAnthropic(parsed.messages ?? []);
    const sessionBinding = sessions.getFromHeaders(req.headers);
    if (lastUserMessage) {
      const systemPrompt = typeof parsed.system === "string" ? parsed.system : "";
      const injected = await injectMemoryAnthropic(
        systemPrompt,
        lastUserMessage,
        storage,
        embedder,
        sessionBinding,
      );
      parsed.system = injected;
    }
  }

  // Forward to upstream
  const upstreamResp = await forwardRequest(
    config.upstreamUrl,
    "/v1/messages",
    "POST",
    JSON.stringify(parsed),
    config.upstreamApiKey,
    req.headers,
  );

  // Auto-capture
  if (config.autoCapture) {
    const responseText = extractAnthropicResponse(upstreamResp.body);
    if (responseText) {
      captureConversationAnthropic(
        parsed.messages ?? [],
        responseText,
        storage,
        sessions.getFromHeaders(req.headers),
      ).catch((e: unknown) => console.error("[remem-mcp proxy] Capture error:", e));
    }
  }

  res.writeHead(upstreamResp.statusCode, upstreamResp.headers);
  res.end(upstreamResp.body);
}

/** Pass-through for unsupported endpoints. */
async function passthrough(
  req: IncomingMessage,
  res: ServerResponse,
  config: ProxyConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const upstreamResp = await forwardRequest(
    config.upstreamUrl,
    url.pathname + url.search,
    req.method ?? "GET",
    await readBody(req),
    config.upstreamApiKey,
    req.headers,
  );
  res.writeHead(upstreamResp.statusCode, upstreamResp.headers);
  res.end(upstreamResp.body);
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Get the last user message from OpenAI-format messages. */
function getLastUserMessage(messages: Array<{ role: string; content: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return typeof messages[i].content === "string"
        ? messages[i].content
        : JSON.stringify(messages[i].content);
    }
  }
  return null;
}

/** Get the last user message from Anthropic-format messages. */
function getLastUserMessageAnthropic(
  messages: Array<{ role: string; content: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textBlock = content.find((b: { type: string; text?: string }) => b.type === "text");
        if (textBlock?.text) return textBlock.text;
      }
    }
  }
  return null;
}

/** Extract text from OpenAI chat completion response. */
function extractOpenAIResponse(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return parsed.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Extract text from Anthropic messages response. */
function extractAnthropicResponse(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    const textBlocks = parsed.content?.filter((b: { type: string }) => b.type === "text") ?? [];
    return textBlocks.map((b: { text: string }) => b.text).join("\n") || null;
  } catch {
    return null;
  }
}

/** Forward a request to the upstream server. */
async function forwardRequest(
  upstreamUrl: string,
  path: string,
  method: string,
  body: string,
  apiKey?: string,
  headers?: Record<string, string | string[] | undefined>,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const url = new URL(path, upstreamUrl);
  const isHttps = url.protocol === "https:";
  const requestFn = isHttps ? httpRequest : httpRequestHttp;

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
  };

  // Copy relevant headers from original request
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (
        lower === "authorization" ||
        lower === "x-api-key" ||
        lower === "anthropic-version" ||
        lower === "openai-organization" ||
        lower === "accept" ||
        lower === "accept-encoding"
      ) {
        if (typeof value === "string") {
          forwardHeaders[key] = value;
        }
      }
    }
  }

  // Override with configured API key if provided
  if (apiKey) {
    if (path.startsWith("/v1/messages")) {
      forwardHeaders["x-api-key"] = apiKey;
    } else {
      forwardHeaders["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  return new Promise((resolve, reject) => {
    const proxyReq = requestFn(url, { method, headers: forwardHeaders }, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", () => {
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (typeof v === "string") respHeaders[k] = v;
        }
        resolve({
          statusCode: proxyRes.statusCode ?? 200,
          headers: respHeaders,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      proxyRes.on("error", reject);
    });
    proxyReq.on("error", reject);
    proxyReq.write(body);
    proxyReq.end();
  });
}

/** Inject memory into Anthropic-format system prompt. */
async function injectMemoryAnthropic(
  systemPrompt: string,
  userMessage: string,
  storage: SQLiteBackend,
  embedder: LocalEmbedder,
  sessionBinding: { teamId?: string; agentId?: string; userId?: string; taskId?: string },
): Promise<string> {
  const memoryBlock = await injectMemory([], userMessage, storage, embedder, sessionBinding);
  // For Anthropic, we append the memory to the system prompt
  const memoryText = extractMemoryBlock(memoryBlock);
  if (!memoryText) return systemPrompt;
  return `${systemPrompt}\n\n${memoryText}`;
}

/** Extract the memory block text from injected messages. */
function extractMemoryBlock(messages: Array<{ role: string; content: string }>): string | null {
  for (const msg of messages) {
    if (msg.role === "system" && msg.content.includes("<remem-mcp>")) {
      return msg.content;
    }
  }
  return null;
}
