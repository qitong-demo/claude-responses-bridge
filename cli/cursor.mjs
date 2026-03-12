import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { loadConfig, parseArgs } from "../server.mjs";
import { pickRecommendedModel } from "../openai-compat.mjs";

const CONTINUE_EXTENSION_ID = "Continue.continue";
const MANAGED_MARKER = "# Managed by Claude Responses Bridge";

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function resolveCursorCommand() {
  const whereCommand = process.platform === "win32" ? "where" : "which";
  const probe = runCommand(whereCommand, ["cursor"]);
  const candidates = []
    .concat(probe.status === 0 ? String(probe.stdout || "").split(/\r?\n/) : [])
    .map((item) => item.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        command: candidate,
        shellName: "cursor",
      };
    }
  }

  const fallbackWindows = [
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "Cursor",
      "resources",
      "app",
      "bin",
      "cursor.cmd",
    ),
    "E:\\1-tool\\cursor\\resources\\app\\bin\\cursor.cmd",
  ];

  for (const candidate of fallbackWindows) {
    if (candidate && existsSync(candidate)) {
      return {
        command: candidate,
        shellName: "cursor",
      };
    }
  }

  return null;
}

function resolveCursorExecutable(cursorCommandPath) {
  if (!cursorCommandPath) {
    return null;
  }

  const normalized = cursorCommandPath.toLowerCase();
  if (
    normalized.endsWith("cursor.cmd") ||
    normalized.endsWith(`${path.sep}cursor`) ||
    normalized.endsWith(`${path.sep}cursor.exe`)
  ) {
    const exePath = path.resolve(path.dirname(cursorCommandPath), "..", "..", "..", "Cursor.exe");
    return existsSync(exePath) ? exePath : null;
  }

  return cursorCommandPath;
}

function readContinueConfigStatus(configPath) {
  if (!existsSync(configPath)) {
    return {
      exists: false,
      managedByBridge: false,
      content: "",
    };
  }

  const content = readFileSync(configPath, "utf8");
  return {
    exists: true,
    managedByBridge: content.includes(MANAGED_MARKER),
    content,
  };
}

function fetchUpstreamModels(config) {
  const response = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const config = JSON.parse(process.argv[1]);
        fetch(config.url, {
          headers: { authorization: "Bearer " + config.apiKey },
        })
          .then(async (response) => {
            const body = await response.text();
            process.stdout.write(JSON.stringify({ ok: response.ok, body }));
          })
          .catch((error) => {
            process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
          });
      `,
      JSON.stringify({
        url: `${config.upstreamBaseUrl}/v1/models`,
        apiKey: config.apiKey,
      }),
    ],
    {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (response.status !== 0 || !response.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(response.stdout);
    if (!parsed.ok) {
      return [];
    }
    const payload = JSON.parse(parsed.body);
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch {
    return [];
  }
}

function buildContinueConfigYaml(config, recommendedModel) {
  const bridgeBaseUrl = `http://${config.listenHost}:${config.port}/v1`;

  return `${MANAGED_MARKER}
name: Claude Responses Bridge
version: 1.0.0
schema: v1

models:
  - name: Bridge Agent
    provider: openai
    model: ${recommendedModel}
    apiBase: ${bridgeBaseUrl}
    apiKey: bridge-local
    roles:
      - chat
      - edit
      - apply
    capabilities:
      - tool_use
`;
}

function installContinueExtension(cursorCommandPath) {
  const result = runCommand(cursorCommandPath, ["--install-extension", CONTINUE_EXTENSION_ID]);
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function listInstalledExtensions(cursorCommandPath) {
  const result = runCommand(cursorCommandPath, ["--list-extensions"]);
  if (result.status !== 0) {
    return [];
  }

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function writeContinueConfig(configPath, content) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, content, "utf8");
}

function makeBackupPath(targetPath) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${targetPath}.crb.bak.${stamp}`;
}

async function askYesNo(rl, label, defaultValue = true) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}

function buildCursorStatus(config, cursorInfo, continueStatus, upstreamModels) {
  const recommendedModel = pickRecommendedModel(config, upstreamModels);
  return {
    note: "This sets up an official third-party extension inside Cursor. It does not unlock Cursor native free-plan named models.",
    cursor: {
      detected: Boolean(cursorInfo),
      commandPath: cursorInfo?.command || null,
      executablePath: cursorInfo?.executablePath || null,
      continueInstalled: Boolean(cursorInfo?.extensions?.includes(CONTINUE_EXTENSION_ID)),
    },
    continue: {
      configPath: continueStatus.path,
      configExists: continueStatus.exists,
      managedByBridge: continueStatus.managedByBridge,
    },
    bridge: {
      localBaseUrl: `http://${config.listenHost}:${config.port}/v1`,
      localApiKey: "bridge-local",
      recommendedModel,
      availableModels: upstreamModels.map((model) => model.id).filter(Boolean),
    },
  };
}

function printStatus(status) {
  console.log("Cursor integration status:");
  console.log(`  Native free-plan limit: still applies to Cursor built-in chat/models`);
  console.log(`  Plugin path: ${status.cursor.commandPath || "(not found)"}`);
  console.log(`  Cursor executable: ${status.cursor.executablePath || "(not found)"}`);
  console.log(`  Continue installed: ${status.cursor.continueInstalled ? "yes" : "no"}`);
  console.log(`  Continue config: ${status.continue.configPath}`);
  console.log(`  Continue config exists: ${status.continue.configExists ? "yes" : "no"}`);
  console.log(`  Managed by bridge: ${status.continue.managedByBridge ? "yes" : "no"}`);
  console.log(`  Bridge base URL: ${status.bridge.localBaseUrl}`);
  console.log(`  Bridge API key: ${status.bridge.localApiKey}`);
  console.log(`  Recommended model: ${status.bridge.recommendedModel}`);
}

export async function runCursor(restArgs) {
  const args = parseArgs(restArgs);
  const config = loadConfig({
    configPath: args.config,
    provider: args.provider,
    quiet: true,
  });
  const cursorCommand = resolveCursorCommand();
  const continueConfigPath = path.join(os.homedir(), ".continue", "config.yaml");
  const continueStatus = {
    path: continueConfigPath,
    ...readContinueConfigStatus(continueConfigPath),
  };
  const upstreamModels = fetchUpstreamModels(config);
  const cursorInfo = cursorCommand
    ? {
        ...cursorCommand,
        executablePath: resolveCursorExecutable(cursorCommand.command),
        extensions: listInstalledExtensions(cursorCommand.command),
      }
    : null;
  const status = buildCursorStatus(config, cursorInfo, continueStatus, upstreamModels);

  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  printStatus(status);

  if (!cursorInfo) {
    console.error("\n[bridge] Cursor command was not found. Install Cursor or add it to PATH first.");
    return 1;
  }

  const shouldInstall =
    args.install === true
      ? true
      : args.install === false
        ? false
        : process.stdin.isTTY && process.stdout.isTTY
          ? await (async () => {
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                if (!status.cursor.continueInstalled) {
                  return await askYesNo(
                    rl,
                    "\nInstall the Continue extension into Cursor now?",
                    true,
                  );
                }
                return await askYesNo(
                  rl,
                  "\nReinstall/update the Continue extension now?",
                  false,
                );
              } finally {
                rl.close();
              }
            })()
          : false;

  if (shouldInstall) {
    const result = installContinueExtension(cursorInfo.command);
    if (!result.ok) {
      console.error(`\n[bridge] Failed to install ${CONTINUE_EXTENSION_ID}.`);
      if (result.stderr) {
        console.error(result.stderr);
      }
      return 1;
    }
    console.log(`\n[bridge] Installed ${CONTINUE_EXTENSION_ID}.`);
    if (result.stdout) {
      console.log(result.stdout);
    }
  }

  const latestContinueStatus = readContinueConfigStatus(continueConfigPath);
  const recommendedModel = status.bridge.recommendedModel;
  const configContent = buildContinueConfigYaml(config, recommendedModel);

  let shouldWriteConfig = Boolean(args["write-config"] || args.writeConfig);
  let forceWrite = Boolean(args.force);

  if (!shouldWriteConfig && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      shouldWriteConfig = await askYesNo(
        rl,
        "\nWrite/update ~/.continue/config.yaml so Continue uses the local bridge?",
        true,
      );
      if (
        shouldWriteConfig &&
        latestContinueStatus.exists &&
        !latestContinueStatus.managedByBridge
      ) {
        forceWrite = await askYesNo(
          rl,
          "Existing Continue config is not managed by the bridge. Backup and overwrite it?",
          false,
        );
      }
    } finally {
      rl.close();
    }
  }

  if (shouldWriteConfig) {
    if (latestContinueStatus.exists && !latestContinueStatus.managedByBridge && !forceWrite) {
      console.log(
        `\n[bridge] Skipped writing ${continueConfigPath} because it already exists and is not bridge-managed.`,
      );
    } else {
      if (latestContinueStatus.exists && !latestContinueStatus.managedByBridge) {
        const backupPath = makeBackupPath(continueConfigPath);
        writeFileSync(backupPath, latestContinueStatus.content, "utf8");
        console.log(`\n[bridge] Backed up existing Continue config to ${backupPath}.`);
      }

      writeContinueConfig(continueConfigPath, configContent);
      console.log(`\n[bridge] Wrote Continue config to ${continueConfigPath}.`);
    }
  }

  console.log("\nNext steps:");
  console.log("  1. Start the local bridge: node .\\cli.js serve");
  console.log("  2. Restart Cursor if it was already open.");
  console.log("  3. Open the Continue sidebar inside Cursor.");
  console.log(`  4. Use model: ${recommendedModel}`);
  console.log("\nNote:");
  console.log("  This does not remove Cursor's native free-plan restriction.");
  console.log("  It gives Cursor a separate extension that talks to your local bridge directly.");
  return 0;
}
