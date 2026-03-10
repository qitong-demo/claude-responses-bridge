import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const defaultConfigPath = path.join(__dirname, "config.local.json");
export const defaultProviderBaseUrl = "https://api.example.com";
export const defaultModelMap = {
  default: "gpt-5.1-codex",
  opus: "gpt-5.1-codex-max",
  sonnet: "gpt-5.1-codex",
  haiku: "gpt-5.1-codex-mini",
};
export const defaultRouting = {
  mode: "failover",
  cooldownMs: 30000,
  maxConsecutiveFailures: 2,
};

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "1" || lowered === "yes") {
      return true;
    }
    if (lowered === "false" || lowered === "0" || lowered === "no") {
      return false;
    }
  }

  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeText(item, ""))
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  return normalizeText(value || defaultProviderBaseUrl, defaultProviderBaseUrl).replace(/\/+$/, "");
}

export function resolveConfigPath(configArg) {
  return path.resolve(
    String(configArg || process.env.CLAUDE_BRIDGE_CONFIG || defaultConfigPath),
  );
}

export function createProviderId(value, takenIds = new Set()) {
  const baseId =
    normalizeText(value, "provider")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";

  let candidate = baseId;
  let suffix = 2;
  while (takenIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function normalizeProvider(provider, index, takenIds) {
  const rawName = normalizeText(provider?.name, `Provider ${index + 1}`);
  const id = createProviderId(provider?.id || rawName, takenIds);
  takenIds.add(id);

  return {
    id,
    name: rawName,
    baseUrl: normalizeBaseUrl(provider?.baseUrl || provider?.upstreamBaseUrl),
    apiKey: normalizeText(provider?.apiKey, ""),
    enabled: normalizeBoolean(provider?.enabled, true),
    priority: normalizeNumber(provider?.priority, index + 1),
    weight: normalizeNumber(provider?.weight, 1),
    tags: normalizeStringArray(provider?.tags),
    notes: normalizeText(provider?.notes, ""),
    priceHint: normalizeText(provider?.priceHint, ""),
  };
}

function providersFromRecord(record) {
  return Object.entries(record || {}).map(([id, value]) => ({
    id,
    ...(value || {}),
  }));
}

function createLegacyProvider(raw) {
  return {
    id: "default",
    name: normalizeText(raw?.providerName, "Default Provider"),
    baseUrl: normalizeBaseUrl(raw?.upstreamBaseUrl),
    apiKey: normalizeText(raw?.apiKey, ""),
  };
}

export function normalizeBridgeConfig(raw = {}) {
  const takenIds = new Set();
  const sourceProviders = Array.isArray(raw.providers)
    ? raw.providers
    : raw.providers && typeof raw.providers === "object"
      ? providersFromRecord(raw.providers)
      : [createLegacyProvider(raw)];

  const providers = sourceProviders
    .map((provider, index) => normalizeProvider(provider, index, takenIds))
    .filter(Boolean);

  if (!providers.length) {
    providers.push(normalizeProvider(createLegacyProvider(raw), 0, takenIds));
  }

  const requestedProviderId = normalizeText(
    raw.selectedProviderId ||
      raw.selectedProvider ||
      raw.activeProvider ||
      raw.defaultProviderId,
    providers[0].id,
  );

  const selectedProviderId =
    providers.find((provider) => provider.id === requestedProviderId)?.id || providers[0].id;

  return {
    schemaVersion: 2,
    port: normalizeNumber(raw.port, 3456),
    listenHost: normalizeText(raw.listenHost, "127.0.0.1"),
    requestTimeoutMs: normalizeNumber(raw.requestTimeoutMs, 600000),
    selectedProviderId,
    providers,
    routing: {
      mode: normalizeText(raw.routing?.mode, defaultRouting.mode),
      cooldownMs: normalizeNumber(raw.routing?.cooldownMs, defaultRouting.cooldownMs),
      maxConsecutiveFailures: normalizeNumber(
        raw.routing?.maxConsecutiveFailures,
        defaultRouting.maxConsecutiveFailures,
      ),
    },
    modelMap: {
      default: normalizeText(raw.modelMap?.default, defaultModelMap.default),
      opus: normalizeText(raw.modelMap?.opus, defaultModelMap.opus),
      sonnet: normalizeText(raw.modelMap?.sonnet, defaultModelMap.sonnet),
      haiku: normalizeText(raw.modelMap?.haiku, defaultModelMap.haiku),
    },
  };
}

export function readBridgeConfig(configArg) {
  const configPath = resolveConfigPath(configArg);
  const rawConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  const config = normalizeBridgeConfig(rawConfig);
  return {
    ...config,
    configPath,
  };
}

export function getProviderById(config, providerId) {
  if (!providerId) {
    return config.providers.find((provider) => provider.id === config.selectedProviderId)
      || config.providers[0];
  }

  return config.providers.find(
    (provider) =>
      provider.id === providerId ||
      provider.name.toLowerCase() === String(providerId).trim().toLowerCase(),
  ) || null;
}

export function updateProviderCollection(config, providers, selectedProviderId) {
  return normalizeBridgeConfig({
    ...config,
    providers,
    selectedProviderId,
  });
}

export function writeBridgeConfig(configArg, config) {
  const configPath = resolveConfigPath(configArg || config.configPath);
  const normalized = normalizeBridgeConfig(config);
  const activeProvider = getProviderById(normalized, normalized.selectedProviderId);
  const serialized = {
    schemaVersion: 2,
    port: normalized.port,
    listenHost: normalized.listenHost,
    upstreamBaseUrl: activeProvider?.baseUrl || defaultProviderBaseUrl,
    apiKey: activeProvider?.apiKey || "",
    requestTimeoutMs: normalized.requestTimeoutMs,
    selectedProviderId: normalized.selectedProviderId,
    providers: normalized.providers,
    routing: normalized.routing,
    modelMap: normalized.modelMap,
  };

  writeFileSync(configPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  return {
    ...normalized,
    configPath,
  };
}

export function maskSecret(value) {
  const text = String(value || "");
  if (!text) {
    return "(empty)";
  }

  if (text.length <= 8) {
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }

  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}
