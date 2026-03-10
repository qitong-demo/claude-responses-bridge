#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultConfigPath,
  loadConfig,
  parseArgs,
  resolveConfigPath,
  startBridgeServer,
} from "./server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`claude-responses-bridge

Usage:
  node cli.js init [--config PATH]
  node cli.js serve [--config PATH] [--port N] [--host HOST]
  node cli.js claude [claude args...]
  node cli.js doctor [--config PATH]

Examples:
  node cli.js init
  node cli.js serve
  node cli.js claude -p "Reply with just OK."
`);
}

async function waitForHealth(port, host, timeoutMs) {
  const startedAt = Date.now();
  const url = `http://${host}:${port}/health`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Bridge did not become healthy at ${url} within ${timeoutMs}ms.`);
}

function buildSettingsFile(dir, config) {
  const settingsPath = path.join(dir, "claude-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: `http://${config.listenHost}:${config.port}`,
          ANTHROPIC_API_KEY: "local-bridge",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return settingsPath;
}

function commandExists(command) {
  if (command.includes("\\") || command.includes("/") || path.isAbsolute(command)) {
    return Promise.resolve(existsSync(command));
  }

  const checker = process.platform === "win32" ? "where" : "which";
  const probe = spawn(checker, [command], {
    stdio: "ignore",
    shell: false,
  });

  return new Promise((resolve) => {
    probe.on("close", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

function findCommandPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(checker, [command], {
    encoding: "utf8",
    shell: false,
  });

  if (probe.status !== 0 || !probe.stdout) {
    return null;
  }

  return probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

async function resolveClaudeCommand() {
  if (process.platform !== "win32") {
    return {
      command: "claude",
      argsPrefix: [],
    };
  }

  const candidates = ["claude.cmd", "claude.exe", "claude"];

  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      const commandPath = findCommandPath(candidate) || candidate;
      const shimDir = path.dirname(commandPath);
      const cliJsPath = path.join(
        shimDir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      );

      if (existsSync(cliJsPath)) {
        return {
          command: process.execPath,
          argsPrefix: [cliJsPath],
        };
      }

      return {
        command: commandPath,
        argsPrefix: [],
      };
    }
  }

  return {
    command: "claude",
    argsPrefix: [],
  };
}

function parseCommand(argv) {
  const [command = "help", ...rest] = argv;
  return { command, rest };
}

async function runInit(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config);

  if (existsSync(configPath)) {
    console.log(`[bridge] config already exists: ${configPath}`);
    return 0;
  }

  const examplePath = path.join(__dirname, "config.example.json");
  copyFileSync(examplePath, configPath);
  console.log(`[bridge] wrote ${configPath}`);
  console.log("[bridge] add your apiKey to that file, or set GMN_API_KEY in the shell.");
  return 0;
}

async function runServe(restArgs) {
  const args = parseArgs(restArgs);
  const config = loadConfig({
    configPath: args.config,
    port: args.port,
    listenHost: args.host,
    upstreamBaseUrl: args.upstream,
    apiKey: args["api-key"],
    requestTimeoutMs: args.timeout,
    quiet: false,
    modelMap: {
      default: args["map-default"],
      opus: args["map-opus"],
      sonnet: args["map-sonnet"],
      haiku: args["map-haiku"],
    },
  });

  const server = await startBridgeServer(config);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

async function runDoctor(restArgs) {
  const args = parseArgs(restArgs);
  const config = loadConfig({
    configPath: args.config,
    apiKey: args["api-key"],
    quiet: true,
  });

  const checks = {
    configPath: config.configPath,
    configExists: existsSync(config.configPath),
    hasApiKey: Boolean(config.apiKey),
    claudeOnPath: await commandExists("claude"),
    nodeVersion: process.version,
    listenUrl: `http://${config.listenHost}:${config.port}`,
    upstreamBaseUrl: config.upstreamBaseUrl,
  };

  console.log(JSON.stringify(checks, null, 2));
  return checks.hasApiKey && checks.claudeOnPath ? 0 : 1;
}

async function runClaude(restArgs) {
  const separatorIndex = restArgs.indexOf("--");
  const localArgs = separatorIndex === -1 ? [] : restArgs.slice(0, separatorIndex);
  const claudeArgs = separatorIndex === -1 ? restArgs : restArgs.slice(separatorIndex + 1);
  const args = parseArgs(localArgs);

  const claudeInvocation = await resolveClaudeCommand();

  if (!(await commandExists(claudeInvocation.command))) {
    console.error("[bridge] claude command was not found on PATH.");
    return 1;
  }

  const config = loadConfig({
    configPath: args.config,
    port: args.port,
    listenHost: args.host,
    upstreamBaseUrl: args.upstream,
    apiKey: args["api-key"],
    requestTimeoutMs: args.timeout,
    quiet: true,
    modelMap: {
      default: args["map-default"],
      opus: args["map-opus"],
      sonnet: args["map-sonnet"],
      haiku: args["map-haiku"],
    },
  });

  if (!config.apiKey) {
    console.error(
      `[bridge] missing API key. Set GMN_API_KEY or create ${defaultConfigPath}.`,
    );
    return 1;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "claude-bridge-"));
  const settingsPath = buildSettingsFile(tempDir, config);
  const bridgeChild = spawn(process.execPath, ["bridge.mjs", "--config", config.configPath], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GMN_API_KEY: config.apiKey,
      CLAUDE_BRIDGE_QUIET: "1",
    },
  });

  let bridgeOutput = "";
  bridgeChild.stdout.on("data", (chunk) => {
    bridgeOutput += String(chunk);
  });
  bridgeChild.stderr.on("data", (chunk) => {
    bridgeOutput += String(chunk);
  });

  const cleanup = () => {
    if (!bridgeChild.killed) {
      bridgeChild.kill("SIGTERM");
    }

    rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(config.port, config.listenHost, 10000);
  } catch (error) {
    cleanup();
    console.error("[bridge] failed to start child bridge.");
    if (bridgeOutput.trim()) {
      console.error(bridgeOutput.trim());
    }
    console.error(error.message);
    return 1;
  }

  const claudeSpawn = spawn(
    claudeInvocation.command,
    [...claudeInvocation.argsPrefix, "--settings", settingsPath, ...claudeArgs],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
      shell: false,
    },
  );

  const exitCode = await new Promise((resolve) => {
    claudeSpawn.on("close", (code) => resolve(code ?? 0));
    claudeSpawn.on("error", () => resolve(1));
  });

  cleanup();
  return exitCode;
}

async function main() {
  const { command, rest } = parseCommand(process.argv.slice(2));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "init":
      return runInit(rest);
    case "serve":
      return runServe(rest);
    case "doctor":
      return runDoctor(rest);
    case "claude":
      return runClaude(rest);
    default:
      console.error(`[bridge] unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

const code = await main();
process.exit(code);
