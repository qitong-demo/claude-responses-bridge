import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, parseArgs } from "../server.mjs";
import { pickRecommendedModel } from "../openai-compat.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const localCliPath = path.join(projectRoot, "cli.js");

function collectPositionals(argv) {
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    positionals.push(token);
  }

  return positionals;
}

async function fetchUpstreamModels(config) {
  try {
    const response = await fetch(`${config.upstreamBaseUrl}/v1/models`, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch {
    return [];
  }
}

function buildIdePayload(config, upstreamModels) {
  const recommendedModel = pickRecommendedModel(config, upstreamModels);
  const baseUrl = `http://${config.listenHost}:${config.port}/v1`;

  return {
    providerId: config.selectedProviderId || null,
    providerName: config.provider?.name || null,
    upstreamBaseUrl: config.upstreamBaseUrl,
    localBaseUrl: baseUrl,
    localApiKey: "bridge-local",
    recommendedModel,
    configuredDefaultModel: config.modelMap.default,
    availableModels: upstreamModels.map((model) => model.id).filter(Boolean),
    startCommands: {
      local: `node "${localCliPath}" serve`,
      global: "crb serve",
    },
    cursor: {
      apiProvider: "OpenAI",
      apiKey: "bridge-local",
      baseUrl,
      model: recommendedModel,
    },
    cline: {
      apiProvider: "OpenAI Compatible",
      apiKey: "bridge-local",
      baseUrl,
      modelId: recommendedModel,
      nativeToolCall: true,
    },
  };
}

function renderCommonSection(payload) {
  const lines = [
    "Bridge startup:",
    `  Local repo: ${payload.startCommands.local}`,
    `  Global install: ${payload.startCommands.global}`,
    "",
    "Local bridge endpoint:",
    `  Base URL: ${payload.localBaseUrl}`,
    `  API Key: ${payload.localApiKey}`,
    `  Recommended model: ${payload.recommendedModel}`,
  ];

  if (payload.availableModels.length) {
    lines.push(`  Upstream models: ${payload.availableModels.join(", ")}`);
  }

  return lines.join("\n");
}

function renderCursorSection(payload) {
  return [
    "Cursor setup:",
    "  1. Start the local bridge.",
    "  2. Open Cursor Settings -> Models -> API Keys.",
    "  3. Turn on OpenAI API Key and paste: bridge-local",
    `  4. Turn on Override OpenAI Base URL and paste: ${payload.cursor.baseUrl}`,
    `  5. Pick model: ${payload.cursor.model}`,
    "  6. If your Cursor plan blocks native BYOK, install Cline inside Cursor and use the VSCode/Cline setup below.",
  ].join("\n");
}

function renderClineSection(payload) {
  return [
    "VSCode / Cursor + Cline setup:",
    "  1. Start the local bridge.",
    "  2. Open Cline settings.",
    "  3. API Provider: OpenAI Compatible",
    `  4. Base URL: ${payload.cline.baseUrl}`,
    `  5. API Key: ${payload.cline.apiKey}`,
    `  6. Model ID: ${payload.cline.modelId}`,
    "  7. Turn on Native Tool Call if you want Cline to use the Responses API path directly.",
    "  8. Send a simple test prompt such as: Reply with OK",
  ].join("\n");
}

function printTarget(payload, target) {
  const sections = [renderCommonSection(payload)];

  if (target === "all" || target === "cursor") {
    sections.push(renderCursorSection(payload));
  }

  if (target === "all" || target === "vscode" || target === "cline") {
    sections.push(renderClineSection(payload));
  }

  console.log(sections.join("\n\n"));
}

export async function runIde(restArgs) {
  const args = parseArgs(restArgs);
  const positionals = collectPositionals(restArgs);
  const target = String(positionals[0] || "all").toLowerCase();

  if (!["all", "cursor", "vscode", "cline"].includes(target)) {
    console.error(`[bridge] Unsupported ide target: ${target}`);
    return 1;
  }

  const config = loadConfig({
    configPath: args.config,
    provider: args.provider,
    port: args.port,
    listenHost: args.host,
    quiet: true,
  });
  const upstreamModels = await fetchUpstreamModels(config);
  const payload = buildIdePayload(config, upstreamModels);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  printTarget(payload, target);
  return 0;
}
