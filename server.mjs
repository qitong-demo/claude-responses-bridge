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
import {
  buildOpenAiChatCompletion,
  buildUnifiedModelList,
  convertOpenAiChatToResponses,
  mapOpenAiModel,
  pickRecommendedModel,
  streamOpenAiChatCompletion,
} from "./openai-compat.mjs";

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

function openAiError(res, statusCode, type, message, details = undefined) {
  json(res, statusCode, {
    error: {
      message,
      type,
      ...(details && typeof details === "object" ? details : {}),
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

function writeOpenAiSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function pathMatches(pathname, candidates) {
  return candidates.includes(pathname);
}

function parseJsonText(rawText) {
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
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
          inFlightCount: 0,
          queuedCount: 0,
          pending: Promise.resolve(),
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
        pending: undefined,
        healthy: provider.enabled && !coolingDown,
        coolingDown,
      };
    }),
  };
}

async function runWithProviderQueue(runtime, provider, task) {
  const state = runtime.providers[provider.id];
  if (!state) {
    return task();
  }

  state.queuedCount += 1;

  const execute = async () => {
    state.queuedCount = Math.max(0, state.queuedCount - 1);
    state.inFlightCount += 1;
    try {
      return await task();
    } finally {
      state.inFlightCount = Math.max(0, state.inFlightCount - 1);
    }
  };

  const previous = state.pending || Promise.resolve();
  const current = previous.catch(() => {}).then(execute);
  state.pending = current.finally(() => {
    if (state.pending === current) {
      state.pending = Promise.resolve();
    }
  });
  return current;
}

function buildProviderError(provider, error) {
  return {
    providerId: provider.id,
    statusCode: error.statusCode || null,
    message: error.payload?.error?.message || error.payload?.message || error.message || "unknown error",
  };
}

function aggregateProviderError(errors, fallbackMessage) {
  const lastError = errors[errors.length - 1];
  const error = new Error(lastError?.message || fallbackMessage);
  error.statusCode = lastError?.statusCode || 502;
  error.payload = { errors };
  return error;
}

async function callUpstreamJson(config, runtime, provider, options) {
  const {
    pathname,
    method = "GET",
    body,
    headers = {},
  } = options;
  return runWithProviderQueue(runtime, provider, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${provider.baseUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const data = parseJsonText(rawText);

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
  });
}

async function callResponsesApi(config, runtime, provider, requestBody) {
  return callUpstreamJson(config, runtime, provider, {
    pathname: "/v1/responses",
    method: "POST",
    body: requestBody,
  });
}

async function requestAcrossProviders(config, runtime, options) {
  const candidates = resolveCandidateProviders(config, runtime);
  const errors = [];

  for (const provider of candidates) {
    try {
      const data = await callUpstreamJson(config, runtime, provider, options);
      return {
        data,
        provider,
      };
    } catch (error) {
      errors.push(buildProviderError(provider, error));
      if (!isRetryableStatus(error.statusCode || 0)) {
        throw error;
      }
    }
  }

  throw aggregateProviderError(
    errors,
    "No upstream provider completed the request.",
  );
}

async function pipeWebStreamToResponse(stream, res) {
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    res.write(Buffer.from(value));
  }
}

async function* iterateSseJsonEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushRecord = (record) => {
    const dataLines = record
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .filter(Boolean);

    if (!dataLines.length) {
      return null;
    }

    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      return { done: true };
    }

    return {
      done: false,
      value: parseJsonText(payload),
    };
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const record = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsed = flushRecord(record);
      if (parsed?.done) {
        return;
      }
      if (parsed?.value) {
        yield parsed.value;
      }
      boundaryIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  const parsed = flushRecord(buffer.trim());
  if (parsed?.value) {
    yield parsed.value;
  }
}

function createResponsesStreamError(event) {
  const error = new Error(
    event?.error?.message ||
      event?.message ||
      "Upstream Responses stream failed.",
  );
  error.statusCode = 502;
  error.payload = event;
  return error;
}

function responseUsageFromEvent(event) {
  return event?.response?.usage || event?.usage || null;
}

function responseStatusFromEvent(event) {
  return event?.response?.status || event?.status || null;
}

function responseIncompleteDetailsFromEvent(event) {
  return event?.response?.incomplete_details || event?.incomplete_details || null;
}

function responseIdentityFromEvent(event, fallback = {}) {
  return {
    id:
      event?.response?.id ||
      event?.response_id ||
      fallback.id ||
      `resp_${crypto.randomUUID()}`,
    model:
      event?.response?.model ||
      event?.model ||
      fallback.model ||
      "unknown",
    created:
      Number.isFinite(event?.response?.created_at)
        ? Math.floor(event.response.created_at)
        : fallback.created || Math.floor(Date.now() / 1000),
  };
}

function determineChatFinishReason(state, event) {
  if (state.sawToolCalls) {
    return "tool_calls";
  }

  const status = responseStatusFromEvent(event);
  const incomplete = responseIncompleteDetailsFromEvent(event);
  if (status === "incomplete" && incomplete?.reason === "max_output_tokens") {
    return "length";
  }

  return "stop";
}

function determineAnthropicStopReason(state, event) {
  if (state.sawToolUse) {
    return "tool_use";
  }

  const status = responseStatusFromEvent(event);
  const incomplete = responseIncompleteDetailsFromEvent(event);
  if (status === "incomplete" && incomplete?.reason === "max_output_tokens") {
    return "max_tokens";
  }

  return "end_turn";
}

async function streamResponsesEvents(config, runtime, requestBody, handlers) {
  const candidates = resolveCandidateProviders(config, runtime);
  const errors = [];

  for (const provider of candidates) {
    try {
      await runWithProviderQueue(runtime, provider, async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
        const startedAt = Date.now();
        let sawEvent = false;

        try {
          const response = await fetch(`${provider.baseUrl}/v1/responses`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${provider.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...requestBody,
              stream: true,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const rawText = await response.text();
            const data = parseJsonText(rawText);
            const error = new Error(
              data?.error?.message || data?.message || `Upstream returned HTTP ${response.status}.`,
            );
            error.statusCode = response.status;
            error.payload = data;
            throw error;
          }

          for await (const event of iterateSseJsonEvents(response.body)) {
            sawEvent = true;

            if (event?.type === "error" && event?.error) {
              throw createResponsesStreamError(event);
            }

            await handlers.onEvent?.(event, provider);
          }

          recordProviderSuccess(runtime, provider, Date.now() - startedAt, response.status);
          await handlers.onComplete?.(provider);
        } catch (error) {
          recordProviderFailure(runtime, provider, Date.now() - startedAt, error);
          error.__bridgeSawEvent = sawEvent;
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      });
      return provider;
    } catch (error) {
      errors.push(buildProviderError(provider, error));

      if (error.__bridgeSawEvent || !isRetryableStatus(error.statusCode || 0)) {
        throw error;
      }
    }
  }

  throw aggregateProviderError(
    errors,
    "No upstream provider completed the streaming request.",
  );
}

function createOpenAiChatStreamWriter(res, requestBody, mappedModel) {
  const state = {
    started: false,
    completed: false,
    sawToolCalls: false,
    emittedText: false,
    emittedRole: false,
    chunkId: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: mappedModel,
    usage: null,
    includeUsage: Boolean(requestBody.stream_options?.include_usage),
    tools: new Map(),
    nextToolIndex: 0,
  };

  const baseChunk = () => ({
    id: state.chunkId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
  });

  const ensureStarted = () => {
    if (state.started) {
      return;
    }
    state.started = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
  };

  const emit = (payload) => {
    ensureStarted();
    writeOpenAiSseChunk(res, payload);
  };

  const emitRole = () => {
    if (state.emittedRole) {
      return;
    }
    state.emittedRole = true;
    emit({
      ...baseChunk(),
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
          },
          finish_reason: null,
        },
      ],
    });
  };

  const ensureToolState = (itemId, meta = {}) => {
    const key = itemId || meta.id || meta.callId || crypto.randomUUID();
    if (!state.tools.has(key)) {
      state.tools.set(key, {
        key,
        index: state.nextToolIndex,
        id: meta.id || meta.callId || key,
        name: meta.name || meta.functionName || "tool",
        headerSent: false,
        argumentDeltaSent: false,
      });
      state.nextToolIndex += 1;
    }

    const toolState = state.tools.get(key);
    if (meta.id || meta.callId) {
      toolState.id = meta.id || meta.callId;
    }
    if (meta.name || meta.functionName) {
      toolState.name = meta.name || meta.functionName;
    }
    return toolState;
  };

  const emitToolArguments = (toolState, argumentsChunk, options = {}) => {
    const argumentText = typeof argumentsChunk === "string" ? argumentsChunk : "";
    if (!argumentText && !options.forceHeader) {
      return;
    }

    emitRole();
    state.sawToolCalls = true;

    const entry = {
      index: toolState.index,
    };

    if (!toolState.headerSent || options.forceHeader) {
      entry.id = toolState.id;
      entry.type = "function";
      entry.function = {
        name: toolState.name || "tool",
        ...(argumentText ? { arguments: argumentText } : {}),
      };
      toolState.headerSent = true;
    } else {
      entry.function = {};
      if (argumentText) {
        entry.function.arguments = argumentText;
      }
    }

    if (argumentText) {
      toolState.argumentDeltaSent = true;
    }

    emit({
      ...baseChunk(),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [entry],
          },
          finish_reason: null,
        },
      ],
    });
  };

  const finalize = (event) => {
    if (state.completed) {
      return;
    }
    state.completed = true;

    state.usage = responseUsageFromEvent(event) || state.usage;
    emitRole();
    emit({
      ...baseChunk(),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: determineChatFinishReason(state, event),
        },
      ],
    });

    if (state.includeUsage && state.usage) {
      emit({
        ...baseChunk(),
        choices: [],
        usage: {
          prompt_tokens: Number(state.usage.input_tokens || 0),
          completion_tokens: Number(state.usage.output_tokens || 0),
          total_tokens: Number(state.usage.total_tokens || 0),
          ...(state.usage.input_tokens_details
            ? { prompt_tokens_details: state.usage.input_tokens_details }
            : {}),
          ...(state.usage.output_tokens_details
            ? { completion_tokens_details: state.usage.output_tokens_details }
            : {}),
        },
      });
    }

    ensureStarted();
    res.end("data: [DONE]\n\n");
  };

  return {
    onEvent(event) {
      const identity = responseIdentityFromEvent(event, {
        id: state.chunkId,
        model: state.model,
        created: state.created,
      });
      state.chunkId = identity.id || state.chunkId;
      state.model = identity.model || state.model;
      state.created = identity.created || state.created;

      switch (event?.type) {
        case "response.output_text.delta":
        case "response.text.delta":
          if (event.delta) {
            emitRole();
            state.emittedText = true;
            emit({
              ...baseChunk(),
              choices: [
                {
                  index: 0,
                  delta: {
                    content: event.delta,
                  },
                  finish_reason: null,
                },
              ],
            });
          }
          return;
        case "response.output_item.added":
          if (event.item?.type === "function_call" || event.item?.type === "tool_call") {
            ensureToolState(event.item.id || event.item.call_id, {
              id: event.item.call_id || event.item.id,
              name: event.item.name || event.item.function?.name,
            });
          }
          return;
        case "response.function_call_arguments.delta":
        case "response.tool_call_arguments.delta": {
          const toolState = ensureToolState(
            event.item_id || event.tool_call_id || event.call_id || event.id,
            {
              id: event.call_id || event.tool_call_id || event.id,
              name: event.name || event.function_name,
            },
          );
          emitToolArguments(toolState, event.delta || event.arguments || "");
          return;
        }
        case "response.function_call_arguments.done": {
          const toolState = ensureToolState(event.item_id || event.call_id || event.id, {
            id: event.call_id || event.id,
            name: event.name,
          });
          if (!toolState.argumentDeltaSent) {
            emitToolArguments(toolState, event.arguments || "{}", { forceHeader: true });
          }
          return;
        }
        case "response.output_item.done":
          if (event.item?.type === "function_call" || event.item?.type === "tool_call") {
            const toolState = ensureToolState(event.item.id || event.item.call_id, {
              id: event.item.call_id || event.item.id,
              name: event.item.name || event.item.function?.name,
            });
            if (!toolState.argumentDeltaSent) {
              emitToolArguments(
                toolState,
                typeof event.item.arguments === "string"
                  ? event.item.arguments
                  : JSON.stringify(event.item.arguments || {}),
                { forceHeader: true },
              );
            }
            return;
          }
          if (!state.emittedText && event.item?.type === "message" && Array.isArray(event.item.content)) {
            const text = event.item.content
              .map((part) => (part?.type === "output_text" || part?.type === "text" ? part.text || "" : ""))
              .filter(Boolean)
              .join("");
            if (text) {
              emitRole();
              state.emittedText = true;
              emit({
                ...baseChunk(),
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: text,
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
          }
          return;
        case "response.completed":
        case "response.done":
        case "response.incomplete":
          finalize(event);
          return;
        default:
          return;
      }
    },
    onComplete() {
      finalize({});
    },
  };
}

function createAnthropicStreamWriter(res, requestBody) {
  const state = {
    started: false,
    completed: false,
    sawToolUse: false,
    messageId: `msg_${crypto.randomUUID()}`,
    messageCreated: Math.floor(Date.now() / 1000),
    outputTokens: 0,
    activeTextIndex: null,
    nextBlockIndex: 0,
    toolBlocks: new Map(),
    estimatedInputTokens: countRequestTokens(requestBody),
  };

  const ensureStarted = () => {
    if (state.started) {
      return;
    }
    state.started = true;
    sseHeaders(res);
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: requestBody.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: state.estimatedInputTokens,
          output_tokens: 0,
        },
      },
    });
  };

  const closeActiveTextBlock = () => {
    if (state.activeTextIndex === null) {
      return;
    }
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: state.activeTextIndex,
    });
    state.activeTextIndex = null;
  };

  const ensureTextBlock = () => {
    if (state.activeTextIndex !== null) {
      return state.activeTextIndex;
    }
    ensureStarted();
    const index = state.nextBlockIndex;
    state.nextBlockIndex += 1;
    state.activeTextIndex = index;
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
      },
    });
    return index;
  };

  const ensureToolBlock = (itemId, meta = {}) => {
    const key = itemId || meta.id || crypto.randomUUID();
    if (!state.toolBlocks.has(key)) {
      closeActiveTextBlock();
      ensureStarted();
      const index = state.nextBlockIndex;
      state.nextBlockIndex += 1;
      const block = {
        key,
        index,
        id: meta.id || key,
        name: meta.name || "tool",
        stopped: false,
        inputSent: false,
      };
      state.toolBlocks.set(key, block);
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
    }

    const block = state.toolBlocks.get(key);
    if (meta.id) {
      block.id = meta.id;
    }
    if (meta.name) {
      block.name = meta.name;
    }
    return block;
  };

  const emitToolJsonDelta = (block, partialJson) => {
    ensureStarted();
    state.sawToolUse = true;
    block.inputSent = true;
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: {
        type: "input_json_delta",
        partial_json: partialJson,
      },
    });
  };

  const closeToolBlock = (block) => {
    if (!block || block.stopped) {
      return;
    }
    block.stopped = true;
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: block.index,
    });
  };

  const finalize = (event) => {
    if (state.completed) {
      return;
    }
    state.completed = true;

    closeActiveTextBlock();
    for (const block of state.toolBlocks.values()) {
      closeToolBlock(block);
    }

    const usage = responseUsageFromEvent(event);
    if (usage) {
      state.outputTokens = Number(usage.output_tokens || 0);
    }

    ensureStarted();
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: determineAnthropicStopReason(state, event),
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.outputTokens,
      },
    });
    writeSse(res, "message_stop", {
      type: "message_stop",
    });
    res.end();
  };

  return {
    onEvent(event) {
      const identity = responseIdentityFromEvent(event, {
        id: state.messageId,
        created: state.messageCreated,
      });
      state.messageId = identity.id || state.messageId;

      switch (event?.type) {
        case "response.output_text.delta":
        case "response.text.delta":
          if (event.delta) {
            const index = ensureTextBlock();
            writeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "text_delta",
                text: event.delta,
              },
            });
          }
          return;
        case "response.output_item.added":
          if (event.item?.type === "function_call" || event.item?.type === "tool_call") {
            ensureToolBlock(event.item.id || event.item.call_id, {
              id: event.item.call_id || event.item.id,
              name: event.item.name || event.item.function?.name,
            });
          }
          return;
        case "response.function_call_arguments.delta":
        case "response.tool_call_arguments.delta": {
          const block = ensureToolBlock(
            event.item_id || event.tool_call_id || event.call_id || event.id,
            {
              id: event.call_id || event.tool_call_id || event.id,
              name: event.name || event.function_name,
            },
          );
          emitToolJsonDelta(block, event.delta || event.arguments || "");
          return;
        }
        case "response.function_call_arguments.done": {
          const block = ensureToolBlock(event.item_id || event.call_id || event.id, {
            id: event.call_id || event.id,
            name: event.name,
          });
          if (!block.inputSent) {
            emitToolJsonDelta(block, event.arguments || "{}");
          }
          closeToolBlock(block);
          return;
        }
        case "response.output_item.done":
          if (event.item?.type === "function_call" || event.item?.type === "tool_call") {
            const block = ensureToolBlock(event.item.id || event.item.call_id, {
              id: event.item.call_id || event.item.id,
              name: event.item.name || event.item.function?.name,
            });
            if (!block.inputSent) {
              emitToolJsonDelta(
                block,
                typeof event.item.arguments === "string"
                  ? event.item.arguments
                  : JSON.stringify(event.item.arguments || {}),
              );
            }
            closeToolBlock(block);
            return;
          }
          if (event.item?.type === "message" && Array.isArray(event.item.content)) {
            const text = event.item.content
              .map((part) => (part?.type === "output_text" || part?.type === "text" ? part.text || "" : ""))
              .filter(Boolean)
              .join("");
            if (text && state.activeTextIndex === null && !state.completed) {
              const index = ensureTextBlock();
              writeSse(res, "content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "text_delta",
                  text,
                },
              });
            }
          }
          return;
        case "response.completed":
        case "response.done":
        case "response.incomplete":
          finalize(event);
          return;
        default:
          return;
      }
    },
    onComplete() {
      finalize({});
    },
  };
}

async function proxyResponsesStream(config, runtime, requestBody, res) {
  const candidates = resolveCandidateProviders(config, runtime);
  const errors = [];

  for (const provider of candidates) {
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

      if (!response.ok) {
        const rawText = await response.text();
        const data = parseJsonText(rawText);
        const error = new Error(
          data?.error?.message || data?.message || `Upstream returned HTTP ${response.status}.`,
        );
        error.statusCode = response.status;
        error.payload = data;
        throw error;
      }

      const contentType = response.headers.get("content-type") || "text/event-stream; charset=utf-8";
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": response.headers.get("cache-control") || "no-cache, no-transform",
        connection: "keep-alive",
      });
      await pipeWebStreamToResponse(response.body, res);
      res.end();
      recordProviderSuccess(runtime, provider, Date.now() - startedAt, response.status);
      return provider;
    } catch (error) {
      recordProviderFailure(runtime, provider, Date.now() - startedAt, error);
      errors.push(buildProviderError(provider, error));
      if (!isRetryableStatus(error.statusCode || 0)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw aggregateProviderError(
    errors,
    "No upstream provider completed the streaming request.",
  );
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

async function fetchModelList(config, runtime) {
  const { data } = await requestAcrossProviders(config, runtime, {
    pathname: "/v1/models",
    method: "GET",
  });
  const upstreamModels = Array.isArray(data?.data) ? data.data : [];
  return buildUnifiedModelList(config, upstreamModels);
}

export function createBridgeServer(config) {
  const runtime = createBridgeRuntime(config);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const modelListPaths = ["/v1/models", "/models"];
    const modelDetailPaths = ["/v1/models/", "/models/"];
    const responsesPaths = ["/v1/responses", "/responses"];
    const chatCompletionsPaths = ["/v1/chat/completions", "/chat/completions"];

    if (req.method === "GET" && url.pathname === "/health") {
      const recommendedModel = pickRecommendedModel(config);
      return json(res, 200, {
        ok: true,
        port: config.port,
        listenHost: config.listenHost,
        upstreamBaseUrl: config.upstreamBaseUrl,
        providerId: config.selectedProviderId || null,
        providerName: config.provider?.name || null,
        routing: config.routing,
        modelMap: config.modelMap,
        openaiBaseUrl: `http://${config.listenHost}:${config.port}/v1`,
        bridgeApiKey: "bridge-local",
        recommendedModel,
      });
    }

    if (req.method === "GET" && url.pathname === "/bridge/status") {
      return json(res, 200, buildRuntimeStatus(config, runtime));
    }

    if (req.method === "GET" && pathMatches(url.pathname, modelListPaths)) {
      try {
        const data = await fetchModelList(config, runtime);
        return json(res, 200, {
          object: "list",
          data,
          has_more: false,
          first_id: data[0]?.id || null,
          last_id: data[data.length - 1]?.id || null,
        });
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message =
          error.payload?.error?.message ||
          error.payload?.errors?.map((item) => `${item.providerId}:${item.message}`).join(" | ") ||
          error.message ||
          "Bridge failed to fetch the upstream model list.";
        return openAiError(res, statusCode, "api_error", message);
      }
    }

    if (
      req.method === "GET" &&
      modelDetailPaths.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      try {
        const data = await fetchModelList(config, runtime);
        const matchedPrefix = modelDetailPaths.find((prefix) => url.pathname.startsWith(prefix));
        const modelId = decodeURIComponent(url.pathname.slice(matchedPrefix.length));
        const model = data.find((item) => item.id === modelId);

        if (!model) {
          return openAiError(res, 404, "not_found_error", `Unknown model: ${modelId}`);
        }

        return json(res, 200, model);
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message =
          error.payload?.error?.message ||
          error.payload?.errors?.map((item) => `${item.providerId}:${item.message}`).join(" | ") ||
          error.message ||
          "Bridge failed to fetch the upstream model detail.";
        return openAiError(res, statusCode, "api_error", message);
      }
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
      let body;
      try {
        body = await readJsonBody(req);
        const upstreamRequest = convertAnthropicToResponses(config, body);
        runtime.requestCount += 1;
        runtime.lastRequestAt = new Date().toISOString();

        if (body.stream) {
          const writer = createAnthropicStreamWriter(res, body);
          const usedProvider = await streamResponsesEvents(
            config,
            runtime,
            {
              ...upstreamRequest,
              stream: true,
            },
            writer,
          );
          if (!config.quiet) {
            console.log(
              `[bridge] ${new Date().toISOString()} ${usedProvider.id} ${body.model || "unknown"} -> ${upstreamRequest.model} (stream)`,
            );
          }
          return;
        }

        const { data: upstreamResponse, provider: usedProvider } = await requestAcrossProviders(
          config,
          runtime,
          {
            pathname: "/v1/responses",
            method: "POST",
            body: upstreamRequest,
          },
        );

        const anthropicMessage = buildAnthropicMessage(body, upstreamResponse);

        if (!config.quiet) {
          console.log(
            `[bridge] ${new Date().toISOString()} ${usedProvider.id} ${body.model || "unknown"} -> ${upstreamRequest.model}`,
          );
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
        if (body?.stream && res.headersSent) {
          res.end();
          return;
        }
        return anthropicError(res, statusCode, "api_error", message);
      }
    }

    if (req.method === "POST" && pathMatches(url.pathname, responsesPaths)) {
      let body;
      try {
        body = await readJsonBody(req);
        const upstreamRequest = {
          ...body,
          model: mapOpenAiModel(config, body.model),
        };
        runtime.requestCount += 1;
        runtime.lastRequestAt = new Date().toISOString();

        if (upstreamRequest.stream) {
          const usedProvider = await proxyResponsesStream(config, runtime, upstreamRequest, res);
          if (!config.quiet) {
            console.log(
              `[bridge] ${new Date().toISOString()} ${usedProvider.id} responses ${body.model || "default"} -> ${upstreamRequest.model} (stream)`,
            );
          }
          return;
        }

        const { data: upstreamResponse, provider: usedProvider } = await requestAcrossProviders(
          config,
          runtime,
          {
            pathname: "/v1/responses",
            method: "POST",
            body: upstreamRequest,
          },
        );

        if (!config.quiet) {
          console.log(
            `[bridge] ${new Date().toISOString()} ${usedProvider.id} responses ${body.model || "default"} -> ${upstreamRequest.model}`,
          );
        }

        return json(res, 200, upstreamResponse);
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message =
          error.payload?.error?.message ||
          error.payload?.errors?.map((item) => `${item.providerId}:${item.message}`).join(" | ") ||
          error.message ||
          "Bridge failed to proxy the upstream Responses API.";
        if (!config.quiet) {
          console.error(`[bridge] responses request failed: ${message}`);
        }
        if (body?.stream && res.headersSent) {
          res.end();
          return;
        }
        return openAiError(res, statusCode, "api_error", message);
      }
    }

    if (req.method === "POST" && pathMatches(url.pathname, chatCompletionsPaths)) {
      let body;
      try {
        body = await readJsonBody(req);
        const upstreamRequest = convertOpenAiChatToResponses(config, body);
        runtime.requestCount += 1;
        runtime.lastRequestAt = new Date().toISOString();

        if (body.stream) {
          const writer = createOpenAiChatStreamWriter(
            res,
            body,
            upstreamRequest.model,
          );
          const usedProvider = await streamResponsesEvents(
            config,
            runtime,
            {
              ...upstreamRequest,
              stream: true,
            },
            writer,
          );
          if (!config.quiet) {
            console.log(
              `[bridge] ${new Date().toISOString()} ${usedProvider.id} chat ${body.model || "default"} -> ${upstreamRequest.model} (stream)`,
            );
          }
          return;
        }

        const { data: upstreamResponse, provider: usedProvider } = await requestAcrossProviders(
          config,
          runtime,
          {
            pathname: "/v1/responses",
            method: "POST",
            body: upstreamRequest,
          },
        );
        const chatCompletion = buildOpenAiChatCompletion(body, upstreamResponse);

        if (!config.quiet) {
          console.log(
            `[bridge] ${new Date().toISOString()} ${usedProvider.id} chat ${body.model || "default"} -> ${upstreamRequest.model}${body.stream ? " (stream)" : ""}`,
          );
        }

        return json(res, 200, chatCompletion);
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const message =
          error.payload?.error?.message ||
          error.payload?.errors?.map((item) => `${item.providerId}:${item.message}`).join(" | ") ||
          error.message ||
          "Bridge failed to convert OpenAI chat completions to the upstream Responses API.";
        if (!config.quiet) {
          console.error(`[bridge] chat completion request failed: ${message}`);
        }
        if (body?.stream && res.headersSent) {
          res.end();
          return;
        }
        return openAiError(res, statusCode, "api_error", message);
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
