import http from "node:http";
import crypto from "node:crypto";
import {
  defaultProviderBaseUrl,
  defaultModelMap,
  defaultRouting,
  getProviderById,
  readBridgeConfig,
  resolveConfigPath,
} from "./config-store.mjs";

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }

    const name = key.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[name] = true;
      continue;
    }

    args[name] = next;
    index += 1;
  }

  return args;
}

export function loadConfig(options = {}) {
  const configPath = resolveConfigPath(options.configPath);
  const fileConfig = readBridgeConfig(configPath);
  const requestedProviderId =
    options.provider || process.env.CLAUDE_BRIDGE_PROVIDER || fileConfig.selectedProviderId;
  const selectedProvider =
    getProviderById(fileConfig, requestedProviderId) || getProviderById(fileConfig);

  return {
    configPath,
    port: Number(options.port || process.env.CLAUDE_BRIDGE_PORT || fileConfig.port || 3456),
    listenHost:
      options.listenHost ||
      process.env.CLAUDE_BRIDGE_HOST ||
      fileConfig.listenHost ||
      "127.0.0.1",
    upstreamBaseUrl: String(
      options.upstreamBaseUrl ||
        process.env.GMN_BASE_URL ||
        selectedProvider?.baseUrl ||
        fileConfig.upstreamBaseUrl ||
        defaultProviderBaseUrl,
    ).replace(/\/+$/, ""),
    apiKey: String(
      options.apiKey ||
        process.env.GMN_API_KEY ||
        selectedProvider?.apiKey ||
        fileConfig.apiKey ||
        "",
    ),
    requestTimeoutMs: Number(
      options.requestTimeoutMs ||
        process.env.CLAUDE_BRIDGE_TIMEOUT_MS ||
        fileConfig.requestTimeoutMs ||
        600000,
    ),
    quiet:
      options.quiet ??
      (String(process.env.CLAUDE_BRIDGE_QUIET || "").toLowerCase() === "1" ||
        String(process.env.CLAUDE_BRIDGE_QUIET || "").toLowerCase() === "true"),
    modelMap: {
      default: options.modelMap?.default || fileConfig.modelMap?.default || defaultModelMap.default,
      opus: options.modelMap?.opus || fileConfig.modelMap?.opus || defaultModelMap.opus,
      sonnet: options.modelMap?.sonnet || fileConfig.modelMap?.sonnet || defaultModelMap.sonnet,
      haiku: options.modelMap?.haiku || fileConfig.modelMap?.haiku || defaultModelMap.haiku,
    },
    selectedProviderId: selectedProvider?.id || fileConfig.selectedProviderId,
    provider: selectedProvider || null,
    providers: fileConfig.providers || [],
    routing: {
      mode:
        options.routing?.mode ||
        process.env.CLAUDE_BRIDGE_ROUTING_MODE ||
        fileConfig.routing?.mode ||
        defaultRouting.mode,
      cooldownMs: Number(
        options.routing?.cooldownMs ||
          process.env.CLAUDE_BRIDGE_ROUTING_COOLDOWN_MS ||
          fileConfig.routing?.cooldownMs ||
          defaultRouting.cooldownMs,
      ),
      maxConsecutiveFailures: Number(
        options.routing?.maxConsecutiveFailures ||
          process.env.CLAUDE_BRIDGE_ROUTING_MAX_FAILURES ||
          fileConfig.routing?.maxConsecutiveFailures ||
          defaultRouting.maxConsecutiveFailures,
      ),
    },
  };
}

function json(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function anthropicError(res, statusCode, type, message) {
  json(res, statusCode, {
    type: "error",
    error: {
      type,
      message,
    },
  });
}

function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeContentBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [];
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item?.type === "text") {
        return item.text || "";
      }

      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToInstructions(system) {
  if (!system) {
    return "";
  }

  if (typeof system === "string") {
    return system;
  }

  if (!Array.isArray(system)) {
    return "";
  }

  return system
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }

      if (block?.type === "text") {
        return block.text || "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function toolResultToOutput(content) {
  const text = extractTextFromContent(content);
  return text || JSON.stringify(content || "");
}

function mapModel(config, requestModel) {
  const direct = config.modelMap[requestModel];
  if (direct) {
    return direct;
  }

  const lower = String(requestModel || "").toLowerCase();
  if (lower.includes("opus")) {
    return config.modelMap.opus;
  }
  if (lower.includes("sonnet")) {
    return config.modelMap.sonnet;
  }
  if (lower.includes("haiku")) {
    return config.modelMap.haiku;
  }
  return config.modelMap.default;
}

function mapToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice === "any" ? "required" : toolChoice;
  }

  if (toolChoice.type === "auto") {
    return "auto";
  }

  if (toolChoice.type === "any") {
    return "required";
  }

  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      name: toolChoice.name,
    };
  }

  return undefined;
}

function createMessageTextPart(role, text) {
  if (role === "assistant") {
    return {
      type: "output_text",
      text,
    };
  }

  return {
    type: "input_text",
    text,
  };
}

function convertAnthropicToResponses(config, requestBody) {
  const input = [];
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

  for (const message of messages) {
    const role = message.role || "user";
    const textParts = [];

    const flushTextParts = () => {
      if (!textParts.length) {
        return;
      }

      input.push({
        role,
        content: textParts.splice(0, textParts.length),
      });
    };

    for (const block of normalizeContentBlocks(message.content)) {
      if (!block) {
        continue;
      }

      if (block.type === "text") {
        textParts.push(createMessageTextPart(role, block.text || ""));
        continue;
      }

      if (block.type === "tool_use") {
        flushTextParts();
        input.push({
          type: "function_call",
          call_id: block.id || crypto.randomUUID(),
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
        continue;
      }

      if (block.type === "tool_result") {
        flushTextParts();
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id || block.id || crypto.randomUUID(),
          output: toolResultToOutput(block.content),
        });
      }
    }

    flushTextParts();
  }

  const body = {
    model: mapModel(config, requestBody.model),
    input,
    max_output_tokens: requestBody.max_tokens || 4096,
  };

  const instructions = systemToInstructions(requestBody.system);
  if (instructions) {
    body.instructions = instructions;
  }

  if (typeof requestBody.temperature === "number") {
    body.temperature = requestBody.temperature;
  }

  if (typeof requestBody.top_p === "number") {
    body.top_p = requestBody.top_p;
  }

  if (Array.isArray(requestBody.stop_sequences) && requestBody.stop_sequences.length) {
    body.stop = requestBody.stop_sequences;
  }

  if (Array.isArray(requestBody.tools) && requestBody.tools.length) {
    body.tools = requestBody.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
      strict: false,
    }));
    body.parallel_tool_calls = true;
  }

  const toolChoice = mapToolChoice(requestBody.tool_choice);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  return body;
}

function safeJsonParse(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectAssistantBlocks(responseBody) {
  const blocks = [];
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];

  for (const item of output) {
    if (!item) {
      continue;
    }

    if (item.type === "function_call") {
      blocks.push({
        type: "tool_use",
        id: item.call_id || item.id || crypto.randomUUID(),
        name: item.name,
        input: safeJsonParse(item.arguments) || {},
      });
      continue;
    }

    if (item.type === "message" || item.role === "assistant") {
      const content = Array.isArray(item.content) ? item.content : [];

      for (const part of content) {
        if (!part) {
          continue;
        }

        if (part.type === "output_text" || part.type === "text") {
          blocks.push({
            type: "text",
            text: part.text || "",
          });
        }
      }
    }
  }

  if (!blocks.length && typeof responseBody.output_text === "string" && responseBody.output_text) {
    blocks.push({
      type: "text",
      text: responseBody.output_text,
    });
  }

  return blocks;
}

function buildAnthropicMessage(requestBody, responseBody) {
  const content = collectAssistantBlocks(responseBody);
  const hasToolUse = content.some((block) => block.type === "tool_use");

  let stopReason = "end_turn";
  if (hasToolUse) {
    stopReason = "tool_use";
  } else if (
    responseBody.status === "incomplete" &&
    responseBody.incomplete_details?.reason === "max_output_tokens"
  ) {
    stopReason = "max_tokens";
  }

  return {
    id: responseBody.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestBody.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:
        responseBody.usage?.input_tokens ||
        estimateTokens(requestBody.messages) + estimateTokens(requestBody.system),
      output_tokens: responseBody.usage?.output_tokens || estimateTokens(content),
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function createBridgeRuntime(config) {
  return {
    startedAt: new Date().toISOString(),
    requestCount: 0,
    lastRequestAt: null,
    roundRobinIndex: 0,
    providers: Object.fromEntries(
      (config.providers || []).map((provider) => [
        provider.id,
        {
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled !== false,
          baseUrl: provider.baseUrl,
          priority: provider.priority,
          weight: provider.weight,
          tags: provider.tags || [],
          notes: provider.notes || "",
          priceHint: provider.priceHint || "",
          totalRequests: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          averageLatencyMs: 0,
          lastLatencyMs: null,
          lastStatusCode: null,
          lastError: "",
          lastSuccessAt: null,
          lastFailureAt: null,
        },
      ]),
    ),
  };
}

function isRetryableStatus(statusCode) {
  return (
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function providerPenalty(config, providerState) {
  if (!providerState) {
    return Number.MAX_SAFE_INTEGER;
  }

  const inCooldown =
    providerState.lastFailureAt &&
    Date.now() - Date.parse(providerState.lastFailureAt) < config.routing.cooldownMs &&
    providerState.consecutiveFailures >= config.routing.maxConsecutiveFailures;

  return Number(providerState.priority || 1) + (inCooldown ? 1000 : 0);
}

function sortProvidersForMode(config, runtime, providers) {
  const ordered = providers.slice().sort((left, right) => {
    const leftState = runtime.providers[left.id];
    const rightState = runtime.providers[right.id];
    return providerPenalty(config, leftState) - providerPenalty(config, rightState);
  });

  if (config.routing.mode === "round-robin" && ordered.length > 1) {
    const startIndex = runtime.roundRobinIndex % ordered.length;
    runtime.roundRobinIndex += 1;
    return ordered.slice(startIndex).concat(ordered.slice(0, startIndex));
  }

  if (config.routing.mode === "single") {
    const selected = ordered.find((provider) => provider.id === config.selectedProviderId);
    return selected ? [selected] : ordered.slice(0, 1);
  }

  return ordered;
}

function resolveCandidateProviders(config, runtime) {
  const enabledProviders = (config.providers || []).filter((provider) => provider.enabled !== false);

  if (!enabledProviders.length && config.provider) {
    return [config.provider];
  }

  const selected = enabledProviders.find((provider) => provider.id === config.selectedProviderId);
  const preferred = selected
    ? [selected, ...enabledProviders.filter((provider) => provider.id !== selected.id)]
    : enabledProviders;

  return sortProvidersForMode(config, runtime, preferred);
}

function recordProviderSuccess(runtime, provider, latencyMs, statusCode) {
  const state = runtime.providers[provider.id];
  if (!state) {
    return;
  }

  state.totalRequests += 1;
  state.successCount += 1;
  state.consecutiveFailures = 0;
  state.lastLatencyMs = latencyMs;
  state.lastStatusCode = statusCode;
  state.lastError = "";
  state.lastSuccessAt = new Date().toISOString();
  state.averageLatencyMs = state.averageLatencyMs
    ? Math.round((state.averageLatencyMs * (state.successCount - 1) + latencyMs) / state.successCount)
    : latencyMs;
}

function recordProviderFailure(runtime, provider, latencyMs, error) {
  const state = runtime.providers[provider.id];
  if (!state) {
    return;
  }

  state.totalRequests += 1;
  state.failureCount += 1;
  state.consecutiveFailures += 1;
  state.lastLatencyMs = latencyMs;
  state.lastStatusCode = error.statusCode || null;
  state.lastError = error.payload?.error?.message || error.message || "unknown error";
  state.lastFailureAt = new Date().toISOString();
}

function buildRuntimeStatus(config, runtime) {
  const now = Date.now();

  return {
    startedAt: runtime.startedAt,
    requestCount: runtime.requestCount,
    lastRequestAt: runtime.lastRequestAt,
    selectedProviderId: config.selectedProviderId,
    routing: config.routing,
    providers: Object.values(runtime.providers).map((provider) => {
      const coolingDown =
        provider.lastFailureAt &&
        now - Date.parse(provider.lastFailureAt) < config.routing.cooldownMs &&
        provider.consecutiveFailures >= config.routing.maxConsecutiveFailures;

      return {
        ...provider,
        healthy: provider.enabled && !coolingDown,
        coolingDown,
      };
    }),
  };
}

async function callResponsesApi(config, runtime, provider, requestBody) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${provider.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let data = {};

    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText };
      }
    }

    if (!response.ok) {
      const error = new Error(
        data?.error?.message || data?.message || `Upstream returned HTTP ${response.status}.`,
      );
      error.statusCode = response.status;
      error.payload = data;
      throw error;
    }

    recordProviderSuccess(runtime, provider, Date.now() - startedAt, response.status);
    return data;
  } catch (error) {
    recordProviderFailure(runtime, provider, Date.now() - startedAt, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function streamAnthropicMessage(res, anthropicMessage) {
  sseHeaders(res);

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      ...anthropicMessage,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: anthropicMessage.usage.input_tokens,
        output_tokens: 0,
      },
    },
  });

  anthropicMessage.content.forEach((block, index) => {
    if (block.type === "text") {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "text",
          text: "",
        },
      });

      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: block.text || "",
        },
      });

      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
      return;
    }

    if (block.type === "tool_use") {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });

      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input || {}),
        },
      });

      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
  });

  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: anthropicMessage.stop_reason,
      stop_sequence: anthropicMessage.stop_sequence,
    },
    usage: {
      output_tokens: anthropicMessage.usage.output_tokens,
    },
  });

  writeSse(res, "message_stop", {
    type: "message_stop",
  });

  res.end();
}

function countRequestTokens(body) {
  const messagesText = extractTextFromContent(
    (Array.isArray(body.messages) ? body.messages : []).flatMap((message) =>
      normalizeContentBlocks(message.content),
    ),
  );
  const systemText = systemToInstructions(body.system);
  const toolText = JSON.stringify(body.tools || []);
  return estimateTokens(`${systemText}\n${messagesText}\n${toolText}`);
}

function buildModelList(config) {
  return [
    {
      id: "claude-opus-4-1-20250805",
      type: "model",
      display_name: `Claude Opus -> ${config.modelMap.opus}`,
      created_at: "2025-08-05T00:00:00Z",
    },
    {
      id: "claude-sonnet-4-5-20250929",
      type: "model",
      display_name: `Claude Sonnet -> ${config.modelMap.sonnet}`,
      created_at: "2025-09-29T00:00:00Z",
    },
    {
      id: "claude-3-5-haiku-20241022",
      type: "model",
      display_name: `Claude Haiku -> ${config.modelMap.haiku}`,
      created_at: "2024-10-22T00:00:00Z",
    },
  ];
}

export function createBridgeServer(config) {
  const runtime = createBridgeRuntime(config);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        port: config.port,
        listenHost: config.listenHost,
        upstreamBaseUrl: config.upstreamBaseUrl,
        providerId: config.selectedProviderId || null,
        providerName: config.provider?.name || null,
        routing: config.routing,
        modelMap: config.modelMap,
      });
    }

    if (req.method === "GET" && url.pathname === "/bridge/status") {
      return json(res, 200, buildRuntimeStatus(config, runtime));
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: buildModelList(config),
        has_more: false,
        first_id: null,
        last_id: null,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const model = buildModelList(config).find((item) => item.id === modelId);

      if (!model) {
        return anthropicError(res, 404, "not_found_error", `Unknown model: ${modelId}`);
      }

      return json(res, 200, model);
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      try {
        const body = await readJsonBody(req);
        return json(res, 200, {
          input_tokens: countRequestTokens(body),
        });
      } catch (error) {
        return anthropicError(res, 400, "invalid_request_error", error.message);
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      try {
        const body = await readJsonBody(req);
        const upstreamRequest = convertAnthropicToResponses(config, body);
        runtime.requestCount += 1;
        runtime.lastRequestAt = new Date().toISOString();
        const candidates = resolveCandidateProviders(config, runtime);
        let upstreamResponse = null;
        let usedProvider = null;
        const errors = [];

        for (const provider of candidates) {
          try {
            upstreamResponse = await callResponsesApi(config, runtime, provider, upstreamRequest);
            usedProvider = provider;
            break;
          } catch (error) {
            errors.push({
              providerId: provider.id,
              statusCode: error.statusCode || null,
              message: error.payload?.error?.message || error.message || "unknown error",
            });

            if (!isRetryableStatus(error.statusCode || 0)) {
              throw error;
            }
          }
        }

        if (!upstreamResponse || !usedProvider) {
          const error = new Error(
            errors[errors.length - 1]?.message || "No upstream provider completed the request.",
          );
          error.statusCode = errors[errors.length - 1]?.statusCode || 502;
          error.payload = { errors };
          throw error;
        }

        const anthropicMessage = buildAnthropicMessage(body, upstreamResponse);

        if (!config.quiet) {
          console.log(
            `[bridge] ${new Date().toISOString()} ${usedProvider.id} ${body.model || "unknown"} -> ${upstreamRequest.model}`,
          );
        }

        if (body.stream) {
          streamAnthropicMessage(res, anthropicMessage);
          return;
        }

        return json(res, 200, anthropicMessage);
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message =
          error.payload?.error?.message ||
          error.payload?.errors?.map((item) => `${item.providerId}:${item.message}`).join(" | ") ||
          error.message ||
          "Bridge failed to call the upstream Responses API.";
        if (!config.quiet) {
          console.error(`[bridge] request failed: ${message}`);
        }
        return anthropicError(res, statusCode, "api_error", message);
      }
    }

    return anthropicError(res, 404, "not_found_error", `Unsupported endpoint: ${url.pathname}`);
  });
}

export async function startBridgeServer(config) {
  if (!config.apiKey) {
    throw new Error("Missing API token. Set GMN_API_KEY or update config.local.json.");
  }

  const server = createBridgeServer(config);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.listenHost, resolve);
  });

  if (!config.quiet) {
    console.log(
      `[bridge] listening on http://${config.listenHost}:${config.port} -> ${config.upstreamBaseUrl} (${config.provider?.name || config.selectedProviderId || "provider"}) mode=${config.routing.mode}`,
    );
  }

  return server;
}
