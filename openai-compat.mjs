import crypto from "node:crypto";

function normalizeTimestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return Math.floor(Date.now() / 1000);
}

function normalizeChatContentParts(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(Boolean);
}

function extractTextFromChatContent(content) {
  return normalizeChatContentParts(content)
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return part.text || "";
      }

      if (part.type === "image_url" || part.type === "input_image") {
        return "[Image omitted by local bridge]";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function createResponsesTextPart(role, text) {
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text,
  };
}

function mapOpenAiToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "required") {
      return "required";
    }
    if (toolChoice === "none") {
      return "none";
    }
    return "auto";
  }

  if (toolChoice.type === "function") {
    return {
      type: "function",
      name: toolChoice.function?.name || toolChoice.name,
    };
  }

  return undefined;
}

function mapOpenAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return undefined;
  }

  return tools
    .map((tool) => {
      const fn = tool?.function || tool;
      const name = fn?.name;
      if (!name) {
        return null;
      }

      return {
        type: "function",
        name,
        description: fn.description || "",
        parameters: fn.parameters || tool.parameters || { type: "object", properties: {} },
        strict: fn.strict ?? false,
      };
    })
    .filter(Boolean);
}

function mapOpenAiReasoning(requestBody) {
  if (requestBody?.reasoning && typeof requestBody.reasoning === "object") {
    const effort = requestBody.reasoning.effort;
    if (typeof effort === "string" && effort.trim()) {
      return {
        effort,
        ...(requestBody.reasoning.summary ? { summary: requestBody.reasoning.summary } : {}),
      };
    }
  }

  if (typeof requestBody?.reasoning_effort === "string" && requestBody.reasoning_effort.trim()) {
    return {
      effort: requestBody.reasoning_effort,
    };
  }

  return undefined;
}

function splitChatInstructions(messages, explicitInstructions) {
  const instructions = [];
  const conversationalMessages = [];

  if (typeof explicitInstructions === "string" && explicitInstructions.trim()) {
    instructions.push(explicitInstructions.trim());
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role || "user";
    if (role === "system" || role === "developer") {
      const text = extractTextFromChatContent(message.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    conversationalMessages.push(message);
  }

  return {
    instructions: instructions.filter(Boolean).join("\n\n"),
    conversationalMessages,
  };
}

function normalizeToolArguments(rawArguments) {
  if (typeof rawArguments === "string") {
    return rawArguments;
  }

  return JSON.stringify(rawArguments || {});
}

function toolOutputText(content) {
  const text = extractTextFromChatContent(content);
  return text || JSON.stringify(content || "");
}

export function mapOpenAiModel(config, requestModel) {
  const requested = String(requestModel || "").trim();
  if (!requested) {
    return config.modelMap.default;
  }

  if (config.modelMap[requested]) {
    return config.modelMap[requested];
  }

  const lower = requested.toLowerCase();
  if (lower === "default") {
    return config.modelMap.default;
  }
  if (lower === "opus" || lower.includes("claude") && lower.includes("opus")) {
    return config.modelMap.opus;
  }
  if (lower === "sonnet" || lower.includes("claude") && lower.includes("sonnet")) {
    return config.modelMap.sonnet;
  }
  if (lower === "haiku" || lower.includes("claude") && lower.includes("haiku")) {
    return config.modelMap.haiku;
  }

  return requested;
}

export function convertOpenAiChatToResponses(config, requestBody = {}) {
  const { instructions, conversationalMessages } = splitChatInstructions(
    requestBody.messages,
    requestBody.instructions,
  );
  const input = [];

  for (const message of conversationalMessages) {
    const role = message?.role || "user";

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || message.id || crypto.randomUUID(),
        output: toolOutputText(message.content),
      });
      continue;
    }

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

    for (const part of normalizeChatContentParts(message.content)) {
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        textParts.push(createResponsesTextPart(role, part.text || ""));
        continue;
      }

      if (part.type === "image_url" || part.type === "input_image") {
        textParts.push(createResponsesTextPart(role, "[Image omitted by local bridge]"));
      }
    }

    flushTextParts();

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id || crypto.randomUUID(),
          name: toolCall.function?.name || toolCall.name || "tool",
          arguments: normalizeToolArguments(toolCall.function?.arguments || toolCall.arguments),
        });
      }
    }
  }

  const body = {
    model: mapOpenAiModel(config, requestBody.model),
    input,
  };

  if (instructions) {
    body.instructions = instructions;
  }

  const maxOutputTokens =
    requestBody.max_output_tokens ||
    requestBody.max_completion_tokens ||
    requestBody.max_tokens;
  if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
    body.max_output_tokens = maxOutputTokens;
  }

  if (typeof requestBody.temperature === "number") {
    body.temperature = requestBody.temperature;
  }

  if (typeof requestBody.top_p === "number") {
    body.top_p = requestBody.top_p;
  }

  if (requestBody.stop !== undefined) {
    body.stop = requestBody.stop;
  }

  if (typeof requestBody.store === "boolean") {
    body.store = requestBody.store;
  }

  if (requestBody.metadata && typeof requestBody.metadata === "object") {
    body.metadata = requestBody.metadata;
  }

  const tools = mapOpenAiTools(requestBody.tools);
  if (tools?.length) {
    body.tools = tools;
    body.parallel_tool_calls =
      typeof requestBody.parallel_tool_calls === "boolean"
        ? requestBody.parallel_tool_calls
        : true;
  }

  const toolChoice = mapOpenAiToolChoice(requestBody.tool_choice);
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }

  const reasoning = mapOpenAiReasoning(requestBody);
  if (reasoning) {
    body.reasoning = reasoning;
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

function collectChatMessage(responseBody) {
  const textParts = [];
  const toolCalls = [];
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];

  for (const item of output) {
    if (!item) {
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || crypto.randomUUID(),
        type: "function",
        function: {
          name: item.name || "tool",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
      continue;
    }

    if (item.type !== "message" && item.role !== "assistant") {
      continue;
    }

    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part) {
        continue;
      }

      if (part.type === "output_text" || part.type === "text") {
        if (part.text) {
          textParts.push(part.text);
        }
      }
    }
  }

  if (!textParts.length && typeof responseBody?.output_text === "string" && responseBody.output_text) {
    textParts.push(responseBody.output_text);
  }

  const content = textParts.join("");
  return {
    role: "assistant",
    content: toolCalls.length && !content ? null : content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function mapFinishReason(responseBody, message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return "tool_calls";
  }

  if (
    responseBody?.status === "incomplete" &&
    responseBody?.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length";
  }

  return "stop";
}

function mapUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(usage.input_tokens_details
      ? { prompt_tokens_details: usage.input_tokens_details }
      : {}),
    ...(usage.output_tokens_details
      ? { completion_tokens_details: usage.output_tokens_details }
      : {}),
  };
}

export function buildOpenAiChatCompletion(requestBody = {}, responseBody = {}) {
  const message = collectChatMessage(responseBody);
  const finishReason = mapFinishReason(responseBody, message);

  return {
    id: responseBody.id || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: normalizeTimestampSeconds(responseBody.created_at),
    model: responseBody.model || String(requestBody.model || "unknown"),
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(mapUsage(responseBody.usage) ? { usage: mapUsage(responseBody.usage) } : {}),
  };
}

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function streamOpenAiChatCompletion(res, completion, options = {}) {
  const includeUsage = Boolean(options.includeUsage);
  const choice = completion.choices?.[0] || {
    message: {
      role: "assistant",
      content: "",
    },
    finish_reason: "stop",
  };
  const baseChunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  writeSseChunk(res, {
    ...baseChunk,
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

  if (choice.message?.content) {
    writeSseChunk(res, {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            content: choice.message.content,
          },
          finish_reason: null,
        },
      ],
    });
  }

  for (const [toolIndex, toolCall] of (choice.message?.tool_calls || []).entries()) {
    writeSseChunk(res, {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.function?.name || "tool",
                  arguments: toolCall.function?.arguments || "{}",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }

  writeSseChunk(res, {
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: choice.finish_reason || "stop",
      },
    ],
  });

  if (includeUsage && completion.usage) {
    writeSseChunk(res, {
      ...baseChunk,
      choices: [],
      usage: completion.usage,
    });
  }

  res.end("data: [DONE]\n\n");
}

function normalizeModelEntry(model) {
  const id = String(model?.id || "").trim();
  if (!id) {
    return null;
  }

  const created = normalizeTimestampSeconds(model.created || model.created_at);
  return {
    id,
    object: model.object || "model",
    created,
    owned_by: model.owned_by || "upstream",
    type: model.type || "model",
    display_name: model.display_name || id,
    created_at: model.created_at || new Date(created * 1000).toISOString(),
  };
}

function buildClaudeAliasModels(config) {
  return [
    {
      id: "claude-opus-4-1-20250805",
      object: "model",
      created: normalizeTimestampSeconds("2025-08-05T00:00:00Z"),
      owned_by: "bridge",
      type: "model",
      display_name: `Claude Opus -> ${config.modelMap.opus}`,
      created_at: "2025-08-05T00:00:00Z",
    },
    {
      id: "claude-sonnet-4-5-20250929",
      object: "model",
      created: normalizeTimestampSeconds("2025-09-29T00:00:00Z"),
      owned_by: "bridge",
      type: "model",
      display_name: `Claude Sonnet -> ${config.modelMap.sonnet}`,
      created_at: "2025-09-29T00:00:00Z",
    },
    {
      id: "claude-3-5-haiku-20241022",
      object: "model",
      created: normalizeTimestampSeconds("2024-10-22T00:00:00Z"),
      owned_by: "bridge",
      type: "model",
      display_name: `Claude Haiku -> ${config.modelMap.haiku}`,
      created_at: "2024-10-22T00:00:00Z",
    },
  ];
}

export function buildUnifiedModelList(config, upstreamModels = []) {
  const records = [];
  const seen = new Set();

  for (const model of upstreamModels) {
    const normalized = normalizeModelEntry(model);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    records.push(normalized);
  }

  for (const alias of buildClaudeAliasModels(config)) {
    if (seen.has(alias.id)) {
      continue;
    }
    seen.add(alias.id);
    records.push(alias);
  }

  return records;
}

export function pickRecommendedModel(config, upstreamModels = []) {
  const availableIds = new Set(
    upstreamModels
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean),
  );
  const preferred = [
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5-codex",
    config.modelMap.default,
    config.modelMap.sonnet,
    "gpt-5.2",
    "gpt-5",
  ];

  for (const candidate of preferred) {
    if (candidate && availableIds.has(candidate)) {
      return candidate;
    }
  }

  return preferred.find(Boolean) || "gpt-5.2-codex";
}
