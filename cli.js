#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createProviderId,
  defaultConfigPath,
  defaultProviderBaseUrl,
  defaultRouting,
  getProviderById,
  maskSecret,
  readBridgeConfig,
  resolveConfigPath,
  writeBridgeConfig,
} from "./config-store.mjs";
import {
  loadConfig,
  parseArgs,
  startBridgeServer,
} from "./server.mjs";
import { runCursor } from "./cli/cursor.mjs";
import { runIde } from "./cli/ide.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const supportsColor = isInteractive && process.env.NO_COLOR !== "1";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
};

const HEADER_ART = [
  "   ____ _                 _        ____        _     _            ",
  "  / ___| | __ _ _   _  __| | ___  | __ ) _ __(_) __| | __ _  ___ ",
  " | |   | |/ _` | | | |/ _` |/ _ \\ |  _ \\| '__| |/ _` |/ _` |/ _ \\",
  " | |___| | (_| | |_| | (_| |  __/ | |_) | |  | | (_| | (_| |  __/",
  "  \\____|_|\\__,_|\\__,_|\\__,_|\\___| |____/|_|  |_|\\__,_|\\__, |\\___|",
  "                                                      |___/       ",
];

function colorize(text, color) {
  if (!supportsColor || !color) {
    return text;
  }
  return `${color}${text}${ANSI.reset}`;
}

function bold(text) {
  return colorize(text, ANSI.bold);
}

function dim(text) {
  return colorize(text, ANSI.dim);
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  );
}

function visibleLength(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0);
    if (!codePoint) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function padVisible(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function trimVisible(text, width) {
  if (visibleLength(text) <= width) {
    return text;
  }

  const plain = stripAnsi(text);
  let result = "";
  let currentWidth = 0;

  for (const char of plain) {
    const codePoint = char.codePointAt(0);
    const charWidth = codePoint && isWideCodePoint(codePoint) ? 2 : 1;
    if (currentWidth + charWidth > Math.max(0, width - 1)) {
      return `${result}…`;
    }
    result += char;
    currentWidth += charWidth;
  }

  return result;
}

function shortenMiddle(value, maxLength = 44) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  const head = Math.max(10, Math.floor((maxLength - 1) / 2));
  const tail = Math.max(8, maxLength - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function shortenPath(value) {
  return shortenMiddle(value, 40);
}

function shortenUrl(value) {
  return shortenMiddle(value, 46);
}

function clearScreen() {
  if (isInteractive) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function releaseTerminalInput() {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
}

function terminalWidth() {
  return Math.max(88, Math.min(process.stdout.columns || 100, 120));
}

function buildBox(title, lines, options = {}) {
  const width = options.width || terminalWidth();
  const innerWidth = width - 4;
  const borderColor = options.borderColor || ANSI.cyan;
  const titleText = title ? ` ${title} ` : "";
  const topRaw = `┌${"─".repeat(Math.max(0, innerWidth - visibleLength(titleText)))}┐`;
  const top = title
    ? `┌${titleText}${"─".repeat(Math.max(0, innerWidth - visibleLength(titleText)))}┐`
    : topRaw;
  const bottom = `└${"─".repeat(innerWidth)}┘`;

  const body = lines.map((line) => {
    const fitted = trimVisible(line, innerWidth - 1);
    return `│ ${padVisible(fitted, innerWidth - 1)}│`;
  });
  return [
    colorize(top, borderColor),
    ...body.map((line) => colorize(line, borderColor)),
    colorize(bottom, borderColor),
  ].join("\n");
}

function renderHeaderBox(title, subtitle) {
  const art = HEADER_ART.map((line, index) =>
    index < 2 ? colorize(line, ANSI.magenta) : colorize(line, ANSI.cyan),
  );
  const lines = [
    ...art,
    "",
    bold(colorize(title, ANSI.white)),
    dim(subtitle),
  ];

  return buildBox(" Header ", lines, { borderColor: ANSI.magenta });
}

function formatStatusValue(value, state = "normal") {
  if (state === "active") {
    return colorize(value, ANSI.green);
  }
  if (state === "warning") {
    return colorize(value, ANSI.yellow);
  }
  if (state === "danger") {
    return colorize(value, ANSI.red);
  }
  if (state === "muted") {
    return dim(value);
  }
  return value;
}

function statusLine(label, value, options = {}) {
  const icon = options.icon || "•";
  const key = padVisible(`${icon} ${label}`, 14);
  return `${colorize(key, ANSI.yellow)} ${formatStatusValue(value, options.state)}`;
}

function printHelp() {
  const lines = [
    "用法：",
    "  node cli.js",
    "  node cli.js console [--config PATH]",
    "  node cli.js init [--config PATH] [--force]",
    "  node cli.js configure [--config PATH] [--provider ID] [--name NAME] [--base-url URL] [--api-key TOKEN]",
    "  node cli.js provider list [--config PATH]",
    "  node cli.js provider add [--config PATH] [--name NAME] [--base-url URL] [--api-key TOKEN] [--activate]",
    "  node cli.js provider update <id> [--config PATH] [--name NAME] [--base-url URL] [--api-key TOKEN] [--activate]",
    "  node cli.js provider remove <id> [--config PATH]",
    "  node cli.js provider use <id> [--config PATH]",
    "  node cli.js route show [--config PATH]",
    "  node cli.js route set <single|failover|round-robin> [--config PATH]",
    "  node cli.js serve [--config PATH] [--provider ID] [--port N] [--host HOST]",
    "  node cli.js claude [--config PATH] [--provider ID] [-- 本地参数 ] -- [claude 参数]",
    "  node cli.js doctor [--config PATH] [--provider ID] [--json]",
    "  node cli.js status [--host HOST] [--port N]",
    "  node cli.js cursor [--config PATH] [--install] [--write-config] [--force] [--json]",
    "",
    "示例：",
    "  node cli.js",
    "  node cli.js configure --name 主运营商 --base-url https://your-upstream.example.com --api-key sk-xxxx",
    "  node cli.js provider add --name 备用线路 --base-url https://backup.example.com --api-key sk-backup --activate",
    "  node cli.js provider use backup",
    "  node cli.js route set failover",
    "  node cli.js serve --provider backup",
    "  node cli.js cursor --install --write-config",
    "  node cli.js claude --provider default -- -p \"只回复 OK\"",
  ];

  console.log(buildBox(" 帮助 ", lines, { borderColor: ANSI.cyan }));
}

function parseCommand(argv) {
  const [command = "console", ...rest] = argv;
  return { command, rest };
}

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

function buildDashboardStatus(configPath, options = {}) {
  const store = readBridgeConfig(configPath);
  const provider = getProviderById(store, options.providerId || store.selectedProviderId);
  const warnings = [];

  if (!provider) {
    warnings.push("未选择运营商");
  } else if (!provider.apiKey) {
    warnings.push("当前运营商缺少 Token");
  }

  return {
    configPath,
    store,
    provider,
    rows: [
      statusLine("配置文件", colorize(shortenPath(configPath), ANSI.yellow), { icon: "📄" }),
      statusLine(
        "当前运营商",
        provider ? `${provider.name} (${provider.id})` : "未配置",
        { icon: "🛰", state: provider ? "active" : "warning" },
      ),
      statusLine(
        "上游地址",
        provider ? shortenUrl(provider.baseUrl) : "未配置",
        { icon: "🔗", state: provider ? "normal" : "warning" },
      ),
      statusLine(
        "Token 状态",
        provider ? maskSecret(provider.apiKey) : "(空)",
        { icon: "🔑", state: provider?.apiKey ? "active" : "warning" },
      ),
      statusLine(
        "本地监听",
        `http://${store.listenHost}:${store.port}`,
        { icon: "📡", state: "active" },
      ),
      statusLine("超时设置", `${store.requestTimeoutMs} ms`, { icon: "⏱️" }),
      statusLine("运营商数", `${store.providers.length} 个`, { icon: "📦" }),
      statusLine("路由模式", store.routing?.mode || defaultRouting.mode, { icon: "🧭", state: "active" }),
      statusLine(
        "默认模型",
        `${store.modelMap.default} / ${store.modelMap.opus}`,
        { icon: "🧠" },
      ),
      statusLine(
        "补充模型",
        `${store.modelMap.sonnet} / ${store.modelMap.haiku}`,
        { icon: "🧩" },
      ),
      statusLine(
        "辅助信息",
        warnings.length ? warnings.join(" | ") : "配置完整，可直接使用",
        { icon: "💬", state: warnings.length ? "warning" : "muted" },
      ),
    ],
  };
}

function menuLine(label, description, selected) {
  const cursor = selected ? colorize("❯", ANSI.green) : colorize(" ", ANSI.dim);
  const text = selected
    ? bold(colorize(label, ANSI.green))
    : colorize(label, ANSI.white);
  return `${cursor} ${padVisible(text, 24)} ${dim(description)}`;
}

function renderConsoleScreen(context) {
  clearScreen();
  const header = renderHeaderBox(
    "Claude Bridge 控制台",
    "更接近图形化的终端体验：方向键选择，回车确认，所有配置都能直接在命令行里完成。",
  );
  const status = buildBox(" Status Table / 状态看板 ", context.statusRows, {
    borderColor: ANSI.cyan,
  });
  const menuLines = context.menuOptions.map((option, index) =>
    menuLine(option.label, option.description, index === context.selectedIndex),
  );
  menuLines.push("");
  menuLines.push(dim("操作提示：↑/↓ 切换，Enter 确认，Esc 返回，Ctrl+C 退出。"));
  if (context.footer) {
    menuLines.push(dim(context.footer));
  }
  const menu = buildBox(" Interactive Menu / 交互菜单 ", menuLines, {
    borderColor: ANSI.magenta,
  });

  console.log(header);
  console.log("");
  console.log(status);
  console.log("");
  console.log(menu);
}

function renderInfoPanel(title, rows, footer = "") {
  clearScreen();
  console.log(renderHeaderBox("Claude Bridge 控制台", "命令执行结果与实时状态"));
  console.log("");
  console.log(buildBox(title, rows, { borderColor: ANSI.cyan }));
  if (footer) {
    console.log("");
    console.log(dim(footer));
  }
}

function printProviderTable(store) {
  const rows = store.providers.map((provider) => {
    const active = provider.id === store.selectedProviderId;
    const marker = active ? colorize("●", ANSI.green) : colorize("○", ANSI.dim);
    const name = active
      ? colorize(`${provider.name} (${provider.id})`, ANSI.green)
      : `${provider.name} (${provider.id})`;
    return `${marker} ${padVisible(name, 28)} ${shortenUrl(provider.baseUrl)}  ${dim(maskSecret(provider.apiKey))}`;
  });

  renderInfoPanel("运营商列表", rows.length ? rows : [dim("暂无运营商")]);
}

async function withInterface(run) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await run(rl);
  } finally {
    rl.close();
  }
}

async function ask(rl, label, options = {}) {
  const prefix = colorize("› ", ANSI.cyan);
  const suffix =
    options.defaultValue !== undefined && options.defaultValue !== ""
      ? dim(` [默认: ${options.defaultValue}]`)
      : "";

  while (true) {
    const answer = (await rl.question(`${prefix}${label}${suffix}: `)).trim();
    if (answer) {
      return answer;
    }

    if (options.defaultValue !== undefined) {
      return String(options.defaultValue);
    }

    if (!options.required) {
      return "";
    }

    console.log(colorize("该字段不能为空。", ANSI.yellow));
  }
}

async function confirm(rl, label, defaultValue = true) {
  const suffix = defaultValue ? dim(" [Y/n]") : dim(" [y/N]");
  const answer = (await rl.question(`${colorize("› ", ANSI.cyan)}${label}${suffix}: `))
    .trim()
    .toLowerCase();

  if (!answer) {
    return defaultValue;
  }

  return answer === "y" || answer === "yes";
}

async function selectMenu(rl, title, options, renderContext) {
  if (!isInteractive) {
    return options[0]?.value;
  }

  let selectedIndex = 0;

  return new Promise((resolve) => {
    const previousRawMode = process.stdin.isRaw;

    const render = () => {
      renderConsoleScreen({
        ...renderContext(selectedIndex),
        menuTitle: title,
        menuOptions: options,
        selectedIndex,
      });
    };

    const cleanup = () => {
      process.stdin.off("keypress", onKeyPress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(Boolean(previousRawMode));
      }
    };

    const onKeyPress = (_, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }

      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }

      if (key.name === "return") {
        const value = options[selectedIndex]?.value;
        cleanup();
        clearScreen();
        resolve(value);
        return;
      }

      if (key.name === "escape") {
        cleanup();
        clearScreen();
        resolve("__back__");
      }
    };

    emitKeypressEvents(process.stdin, rl);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", onKeyPress);
    render();
  });
}

async function pause(rl, message = "按 Enter 返回...") {
  await rl.question(`${dim(message)}`);
}

async function showLoader(message, durationMs = 1000) {
  if (!isInteractive) {
    return;
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const startedAt = Date.now();
  let frameIndex = 0;

  while (Date.now() - startedAt < durationMs) {
    clearScreen();
    console.log(renderHeaderBox("Claude Bridge 控制台", "正在处理中，请稍候..."));
    console.log("");
    console.log(buildBox(" 执行动作 ", [
      `${colorize(frames[frameIndex % frames.length], ANSI.green)} ${message}`,
      dim("这一步只是界面反馈，不会改动你的上游逻辑。"),
    ], { borderColor: ANSI.magenta }));
    frameIndex += 1;
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
}

function upsertProvider(store, provider, activate) {
  const providers = store.providers.slice();
  const index = providers.findIndex((item) => item.id === provider.id);

  if (index === -1) {
    providers.push(provider);
  } else {
    providers[index] = provider;
  }

  return {
    ...store,
    providers,
    selectedProviderId: activate ? provider.id : store.selectedProviderId,
  };
}

function removeProvider(store, providerId) {
  const providers = store.providers.filter((provider) => provider.id !== providerId);
  const nextSelectedProviderId =
    store.selectedProviderId === providerId
      ? providers[0]?.id || store.selectedProviderId
      : store.selectedProviderId;

  return {
    ...store,
    providers,
    selectedProviderId: nextSelectedProviderId,
  };
}

async function promptProviderDetails(rl, store, existingProvider = null) {
  renderInfoPanel(
    existingProvider ? "编辑运营商" : "新建运营商",
    [
      statusLine("说明", existingProvider ? "修改当前运营商参数" : "录入新的上游地址和 Token", { icon: "🛠" }),
      statusLine("当前数量", `${store.providers.length} 个`, { icon: "📦" }),
    ],
    "依次输入名称、上游地址和 Token。"
  );

  const name = await ask(rl, "运营商名称", {
    defaultValue: existingProvider?.name || "",
    required: true,
  });
  const baseUrl = await ask(rl, "上游 Base URL", {
    defaultValue: existingProvider?.baseUrl || defaultProviderBaseUrl,
    required: true,
  });
  const apiKey = await ask(
    rl,
    existingProvider
      ? `API Token（直接回车则保留 ${maskSecret(existingProvider.apiKey)}）`
      : "API Token",
    {
      defaultValue: existingProvider ? "" : undefined,
      required: !existingProvider,
    },
  );

  const takenIds = new Set(
    store.providers
      .filter((provider) => provider.id !== existingProvider?.id)
      .map((provider) => provider.id),
  );
  const id = existingProvider?.id || createProviderId(name, takenIds);

  return {
    id,
    name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: apiKey || existingProvider?.apiKey || "",
  };
}

async function promptGeneralSettings(rl, store) {
  renderInfoPanel(
    "桥接设置",
    [
      statusLine("本地监听", `http://${store.listenHost}:${store.port}`, { icon: "📡" }),
      statusLine("超时时间", `${store.requestTimeoutMs} ms`, { icon: "⏱️" }),
      statusLine("默认模型", store.modelMap.default, { icon: "🧠" }),
    ],
    "直接回车即可保留当前值。"
  );

  const port = Number(
    await ask(rl, "本地桥接端口", {
      defaultValue: store.port,
      required: true,
    }),
  );
  const listenHost = await ask(rl, "监听地址", {
    defaultValue: store.listenHost,
    required: true,
  });
  const requestTimeoutMs = Number(
    await ask(rl, "请求超时（毫秒）", {
      defaultValue: store.requestTimeoutMs,
      required: true,
    }),
  );
  const modelMap = {
    default: await ask(rl, "默认模型映射", {
      defaultValue: store.modelMap.default,
      required: true,
    }),
    opus: await ask(rl, "Opus 模型映射", {
      defaultValue: store.modelMap.opus,
      required: true,
    }),
    sonnet: await ask(rl, "Sonnet 模型映射", {
      defaultValue: store.modelMap.sonnet,
      required: true,
    }),
    haiku: await ask(rl, "Haiku 模型映射", {
      defaultValue: store.modelMap.haiku,
      required: true,
    }),
  };

  return {
    ...store,
    port,
    listenHost,
    requestTimeoutMs,
    modelMap,
  };
}

async function ensureProviderReady(configPath, providerId) {
  let store = readBridgeConfig(configPath);
  const provider = getProviderById(store, providerId);

  if (provider?.apiKey) {
    return store;
  }

  if (!isInteractive) {
    return store;
  }

  console.log(colorize("[bridge] 当前运营商缺少 Token，正在打开配置向导。", ANSI.yellow));
  await withInterface(async (rl) => {
    const nextProvider = await promptProviderDetails(rl, store, provider);
    store = upsertProvider(store, nextProvider, true);
    writeBridgeConfig(configPath, store);
    console.log(colorize(`[bridge] 已保存运营商 ${nextProvider.id}`, ANSI.green));
  });

  return readBridgeConfig(configPath);
}

function applyConfigOverrides(store, args) {
  return {
    ...store,
    port: Number(args.port || store.port),
    listenHost: args.host || store.listenHost,
    requestTimeoutMs: Number(args.timeout || store.requestTimeoutMs),
    modelMap: {
      default: args["map-default"] || store.modelMap.default,
      opus: args["map-opus"] || store.modelMap.opus,
      sonnet: args["map-sonnet"] || store.modelMap.sonnet,
      haiku: args["map-haiku"] || store.modelMap.haiku,
    },
  };
}

async function runInit(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config);

  if (existsSync(configPath) && !args.force) {
    console.log(colorize(`[bridge] 配置文件已存在：${configPath}`, ANSI.yellow));
    console.log(dim("[bridge] 使用 `node cli.js configure` 或 `node cli.js provider ...` 继续管理。"));
    return 0;
  }

  const store = readBridgeConfig(configPath);
  writeBridgeConfig(configPath, store);
  console.log(colorize(`[bridge] 已写入配置：${configPath}`, ANSI.green));
  console.log(dim("[bridge] 现在可以直接运行 `node cli.js` 打开交互控制台。"));
  return 0;
}

function buildProviderFromArgs(store, args, existingProvider = null) {
  const name = String(args.name || existingProvider?.name || "").trim();
  const baseUrl = String(
    args["base-url"] || args.upstream || existingProvider?.baseUrl || defaultProviderBaseUrl,
  )
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(args["api-key"] || existingProvider?.apiKey || "").trim();
  const enabled =
    args.enabled === undefined
      ? existingProvider?.enabled ?? true
      : String(args.enabled).toLowerCase() !== "false";
  const priority = Number(args.priority || existingProvider?.priority || store.providers.length + 1);
  const weight = Number(args.weight || existingProvider?.weight || 1);
  const tags = String(args.tags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const takenIds = new Set(
    store.providers
      .filter((provider) => provider.id !== existingProvider?.id)
      .map((provider) => provider.id),
  );

  return {
    id: existingProvider?.id || String(args.id || createProviderId(name || "provider", takenIds)),
    name: name || existingProvider?.name || "Provider",
    baseUrl,
    apiKey,
    enabled,
    priority,
    weight,
    tags: tags.length ? tags : existingProvider?.tags || [],
    notes: String(args.notes || existingProvider?.notes || ""),
    priceHint: String(args["price-hint"] || existingProvider?.priceHint || ""),
  };
}

async function runConfigure(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config);
  let store = readBridgeConfig(configPath);

  if (
    args.name ||
    args["base-url"] ||
    args["api-key"] ||
    args.provider ||
    args.port ||
    args.host ||
    args.timeout ||
    args["map-default"] ||
    args["map-opus"] ||
    args["map-sonnet"] ||
    args["map-haiku"]
  ) {
    const existingProvider = getProviderById(store, args.provider);
    const provider = buildProviderFromArgs(store, args, existingProvider);
    store = upsertProvider(store, provider, Boolean(args.activate || args.provider || !existingProvider));
    store = applyConfigOverrides(store, args);
    writeBridgeConfig(configPath, store);
    console.log(colorize(`[bridge] 配置已更新：${configPath}`, ANSI.green));
    return 0;
  }

  if (!isInteractive) {
    console.error("[bridge] 当前环境不是交互终端，请传入 --name/--base-url/--api-key。");
    return 1;
  }

  await withInterface(async (rl) => {
    store = await promptGeneralSettings(rl, store);
    const currentProvider = getProviderById(store, store.selectedProviderId);
    const provider = await promptProviderDetails(rl, store, currentProvider);
    store = upsertProvider(store, provider, true);
    writeBridgeConfig(configPath, store);
    console.log(colorize(`[bridge] 配置已更新：${configPath}`, ANSI.green));
  });

  return 0;
}

async function runProviderList(configPath) {
  const store = readBridgeConfig(configPath);
  printProviderTable(store);
  return 0;
}

async function runProvider(restArgs) {
  const [action = "list", ...tail] = restArgs;
  const args = parseArgs(tail);
  const positionals = collectPositionals(tail);
  const maybeId = positionals[0];
  const configPath = resolveConfigPath(args.config);
  let store = readBridgeConfig(configPath);

  switch (action) {
    case "list":
      return runProviderList(configPath);
    case "add": {
      let provider;
      if (args.name && args["base-url"] && args["api-key"]) {
        provider = buildProviderFromArgs(store, args);
      } else if (isInteractive) {
        provider = await withInterface((rl) => promptProviderDetails(rl, store));
      } else {
        console.error("[bridge] 新增运营商需要 --name、--base-url 和 --api-key。");
        return 1;
      }

      store = upsertProvider(store, provider, Boolean(args.activate || args["set-default"]));
      if (!store.selectedProviderId) {
        store.selectedProviderId = provider.id;
      }
      writeBridgeConfig(configPath, store);
      console.log(colorize(`[bridge] 已新增运营商 ${provider.id}`, ANSI.green));
      return 0;
    }
    case "update":
    case "replace": {
      const targetId = maybeId || args.provider;
      const existingProvider = getProviderById(store, targetId);
      if (!existingProvider) {
        console.error(`[bridge] 未找到运营商：${targetId || "(缺少 id)"}`);
        return 1;
      }

      let provider;
      if (args.name || args["base-url"] || args["api-key"]) {
        provider = buildProviderFromArgs(store, args, existingProvider);
      } else if (isInteractive) {
        provider = await withInterface((rl) => promptProviderDetails(rl, store, existingProvider));
      } else {
        console.error("[bridge] 更新运营商需要传入修改项，或在交互终端中执行。");
        return 1;
      }

      store = upsertProvider(store, provider, Boolean(args.activate || args["set-default"]));
      writeBridgeConfig(configPath, store);
      console.log(colorize(`[bridge] 已更新运营商 ${provider.id}`, ANSI.green));
      return 0;
    }
    case "use":
    case "switch": {
      const targetId = maybeId || args.provider;
      const provider = getProviderById(store, targetId);
      if (!provider) {
        console.error(`[bridge] 未找到运营商：${targetId || "(缺少 id)"}`);
        return 1;
      }

      store.selectedProviderId = provider.id;
      writeBridgeConfig(configPath, store);
      console.log(colorize(`[bridge] 当前运营商已切换为 ${provider.id}`, ANSI.green));
      return 0;
    }
    case "remove":
    case "delete": {
      const targetId = maybeId || args.provider;
      const provider = getProviderById(store, targetId);
      if (!provider) {
        console.error(`[bridge] 未找到运营商：${targetId || "(缺少 id)"}`);
        return 1;
      }

      if (store.providers.length <= 1) {
        console.error("[bridge] 不能删除最后一个运营商，请先新增或修改现有配置。");
        return 1;
      }

      store = removeProvider(store, provider.id);
      writeBridgeConfig(configPath, store);
      console.log(colorize(`[bridge] 已删除运营商 ${provider.id}`, ANSI.green));
      return 0;
    }
    default:
      console.error(`[bridge] 未知的运营商动作：${action}`);
      return 1;
  }
}

async function runRoute(restArgs) {
  const [action = "show", maybeMode, ...tail] = restArgs;
  const args = parseArgs(tail);
  const configPath = resolveConfigPath(args.config);
  const store = readBridgeConfig(configPath);

  if (action === "show") {
    const rows = [
      statusLine("当前模式", store.routing?.mode || defaultRouting.mode, { icon: "🧭", state: "active" }),
      statusLine("冷却时间", `${store.routing?.cooldownMs || defaultRouting.cooldownMs} ms`, { icon: "🕒" }),
      statusLine("失败阈值", `${store.routing?.maxConsecutiveFailures || defaultRouting.maxConsecutiveFailures}`, { icon: "📉" }),
    ];

    if (isInteractive) {
      renderInfoPanel("智能路由", rows, "可选模式：single / failover / round-robin");
    } else {
      console.log(JSON.stringify({
        mode: store.routing?.mode || defaultRouting.mode,
        cooldownMs: store.routing?.cooldownMs || defaultRouting.cooldownMs,
        maxConsecutiveFailures:
          store.routing?.maxConsecutiveFailures || defaultRouting.maxConsecutiveFailures,
      }, null, 2));
    }
    return 0;
  }

  if (action === "set") {
    const mode = String(maybeMode || "").trim();
    if (!["single", "failover", "round-robin"].includes(mode)) {
      console.error("[bridge] route set 只支持 single、failover、round-robin。");
      return 1;
    }

    writeBridgeConfig(configPath, {
      ...store,
      routing: {
        ...store.routing,
        mode,
      },
    });
    console.log(colorize(`[bridge] 路由模式已切换为 ${mode}`, ANSI.green));
    return 0;
  }

  console.error(`[bridge] 未知的路由动作：${action}`);
  return 1;
}

async function runStatus(restArgs) {
  const args = parseArgs(restArgs);
  const store = readBridgeConfig(args.config || defaultConfigPath);
  const host = args.host || store.listenHost || "127.0.0.1";
  const port = Number(args.port || store.port || 3456);
  const url = `http://${host}:${port}/bridge/status`;

  try {
    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
      console.error(`[bridge] status 接口返回异常：${response.status}`);
      console.log(JSON.stringify(payload, null, 2));
      return 1;
    }

    if (!isInteractive || args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    const providerLines = (payload.providers || []).map((provider) =>
      statusLine(
        provider.name || provider.id,
        `${provider.healthy ? "healthy" : "cooldown"} · avg ${provider.averageLatencyMs || 0} ms · ok ${provider.successCount} / fail ${provider.failureCount}`,
        {
          icon: provider.healthy ? "🟢" : "🟡",
          state: provider.healthy ? "active" : "warning",
        },
      ),
    );

    renderInfoPanel("桥状态", [
      statusLine("路由模式", payload.routing?.mode || "-", { icon: "🧭", state: "active" }),
      statusLine("请求总数", `${payload.requestCount || 0}`, { icon: "📊" }),
      statusLine("最近请求", payload.lastRequestAt || "暂无", { icon: "🕘" }),
      statusLine("当前运营商", payload.selectedProviderId || "-", { icon: "🛰" }),
      ...providerLines,
    ], "这个面板是这款桥和普通中转脚本拉开差距的关键：你能直接看到线路健康度。");
    return 0;
  } catch (error) {
    console.error(`[bridge] 无法读取 ${url} ：${error.message}`);
    return 1;
  }
}

async function buildDoctorReport(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config);
  const configExists = existsSync(configPath);
  const store = readBridgeConfig(configPath);
  const provider = getProviderById(store, args.provider || store.selectedProviderId);
  const claudeInvocation = await resolveClaudeCommand();
  const claudeOnPath = await commandExists(claudeInvocation.command);
  const warnings = [];

  if (!configExists) {
    warnings.push("配置文件尚未创建");
  }
  if (!provider) {
    warnings.push("当前没有可用运营商");
  }
  if (provider && !provider.apiKey) {
    warnings.push("当前运营商缺少 Token");
  }
  if (!claudeOnPath) {
    warnings.push("未在 PATH 中找到 Claude CLI");
  }

  return {
    configPath,
    configExists,
    schemaVersion: store.schemaVersion,
    providerCount: store.providers.length,
    activeProviderId: provider?.id || null,
    activeProviderName: provider?.name || null,
    upstreamBaseUrl: provider?.baseUrl || null,
    hasApiKey: Boolean(provider?.apiKey),
    apiKeyPreview: provider ? maskSecret(provider.apiKey) : "(empty)",
    claudeOnPath,
    nodeVersion: process.version,
    listenUrl: `http://${store.listenHost}:${store.port}`,
    requestTimeoutMs: store.requestTimeoutMs,
    warnings,
  };
}

async function runDoctor(restArgs) {
  const args = parseArgs(restArgs);
  const report = await buildDoctorReport(restArgs);

  if (args.json || !isInteractive) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderInfoPanel("诊断报告", [
      statusLine("配置存在", report.configExists ? "是" : "否", { icon: "📄", state: report.configExists ? "active" : "warning" }),
      statusLine("当前运营商", report.activeProviderName ? `${report.activeProviderName} (${report.activeProviderId})` : "未配置", { icon: "🛰", state: report.activeProviderName ? "active" : "warning" }),
      statusLine("上游地址", report.upstreamBaseUrl || "未配置", { icon: "🔗" }),
      statusLine("路由模式", readBridgeConfig(args.config || defaultConfigPath).routing?.mode || defaultRouting.mode, { icon: "🧭", state: "active" }),
      statusLine("Token", report.apiKeyPreview, { icon: "🔑", state: report.hasApiKey ? "active" : "warning" }),
      statusLine("Claude CLI", report.claudeOnPath ? "已检测到" : "未检测到", { icon: "🤖", state: report.claudeOnPath ? "active" : "warning" }),
      statusLine("本地监听", report.listenUrl, { icon: "📡" }),
      statusLine("告警", report.warnings.length ? report.warnings.join(" | ") : "无", { icon: "⚠️", state: report.warnings.length ? "warning" : "muted" }),
    ], "可使用 `doctor --json` 获取机器可读输出。");
  }

  return report.hasApiKey && report.claudeOnPath ? 0 : 1;
}

async function runServe(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config);
  releaseTerminalInput();
  await ensureProviderReady(configPath, args.provider);

  const config = loadConfig({
    configPath,
    provider: args.provider,
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

  if (!config.quiet) {
    renderInfoPanel("Bridge Session / 启动信息", [
      statusLine("当前运营商", `${config.provider?.name || "未配置"} (${config.selectedProviderId || "-"})`, { icon: "🛰", state: "active" }),
      statusLine("路由模式", config.routing?.mode || defaultRouting.mode, { icon: "🧭", state: "active" }),
      statusLine("上游地址", config.upstreamBaseUrl, { icon: "🔗" }),
      statusLine("Token", maskSecret(config.apiKey), { icon: "🔑", state: "active" }),
      statusLine("本地监听", `http://${config.listenHost}:${config.port}`, { icon: "📡", state: "active" }),
      statusLine("超时设置", `${config.requestTimeoutMs} ms`, { icon: "⏱️" }),
    ], "服务已接管当前终端。按 Ctrl+C 可停止。");
  }

  const server = await startBridgeServer(config);
  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {});
}

async function runClaude(restArgs) {
  const separatorIndex = restArgs.indexOf("--");
  const localArgs = separatorIndex === -1 ? restArgs : restArgs.slice(0, separatorIndex);
  const claudeArgs = separatorIndex === -1 ? [] : restArgs.slice(separatorIndex + 1);
  const args = parseArgs(localArgs);
  const configPath = resolveConfigPath(args.config);

  releaseTerminalInput();
  await ensureProviderReady(configPath, args.provider);

  const claudeInvocation = await resolveClaudeCommand();
  if (!(await commandExists(claudeInvocation.command))) {
    console.error("[bridge] 未在 PATH 中找到 claude 命令。");
    return 1;
  }

  const config = loadConfig({
    configPath,
    provider: args.provider,
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
    console.error(`[bridge] 缺少 API Token，请先配置运营商：${configPath}`);
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
      CLAUDE_BRIDGE_PROVIDER: config.selectedProviderId || "",
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
    console.error("[bridge] 子进程 bridge 启动失败。");
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

async function manageProvidersConsole(configPath, rl) {
  while (true) {
    const store = readBridgeConfig(configPath);
    const action = await selectMenu(
      rl,
      "运营商菜单",
      [
        { label: "新建运营商", description: "录入新的上游地址与 Token", value: "create" },
        { label: "编辑运营商", description: "修改现有运营商的名称、地址或 Token", value: "update" },
        { label: "切换运营商", description: "将所选运营商设为当前默认线路", value: "switch" },
        { label: "删除运营商", description: "移除不再使用的运营商配置", value: "delete" },
        { label: "返回上一级", description: "回到主菜单", value: "back" },
      ],
      () => ({
        statusRows: [
          ...buildDashboardStatus(configPath).rows.slice(0, 6),
          statusLine("运营商预览", store.providers.length ? `${store.providers.map((provider) => provider.id).join(" / ")}` : "暂无运营商", { icon: "📋" }),
        ],
        footer: "这里负责新增、更换、删除和切换运营商。",
      }),
    );

    if (action === "back" || action === "__back__") {
      return;
    }

    if (action === "create") {
      const provider = await promptProviderDetails(rl, store);
      const activate = await confirm(rl, "是否将它设为当前运营商", true);
      writeBridgeConfig(configPath, upsertProvider(store, provider, activate));
      console.log(colorize(`[bridge] 已新增运营商 ${provider.id}`, ANSI.green));
      await pause(rl);
      continue;
    }

    if (!store.providers.length) {
      console.log(colorize("[bridge] 当前没有可操作的运营商。", ANSI.yellow));
      await pause(rl);
      continue;
    }

    const targetId = await selectMenu(
      rl,
      "选择运营商",
      store.providers.map((provider) => ({
        label: provider.name,
        description: `${provider.id} · ${shortenUrl(provider.baseUrl)}`,
        value: provider.id,
      })),
      () => ({
        statusRows: [
          ...buildDashboardStatus(configPath).rows.slice(0, 7),
        ],
        footer: "方向键选择目标运营商，Enter 确认。",
      }),
    );

    if (targetId === "__back__") {
      continue;
    }

    const provider = getProviderById(store, targetId);

    if (action === "update") {
      const nextProvider = await promptProviderDetails(rl, store, provider);
      const activate = await confirm(rl, "是否同时切换为当前运营商", store.selectedProviderId === provider.id);
      writeBridgeConfig(configPath, upsertProvider(store, nextProvider, activate));
      console.log(colorize(`[bridge] 已更新运营商 ${provider.id}`, ANSI.green));
      await pause(rl);
      continue;
    }

    if (action === "switch") {
      writeBridgeConfig(configPath, {
        ...store,
        selectedProviderId: provider.id,
      });
      console.log(colorize(`[bridge] 当前运营商已切换为 ${provider.id}`, ANSI.green));
      await pause(rl);
      continue;
    }

    if (action === "delete") {
      if (store.providers.length <= 1) {
        console.log(colorize("[bridge] 不能删除最后一个运营商。", ANSI.yellow));
        await pause(rl);
        continue;
      }

      const approved = await confirm(rl, `确定删除运营商 ${provider.id} 吗`, false);
      if (!approved) {
        continue;
      }

      writeBridgeConfig(configPath, removeProvider(store, provider.id));
      console.log(colorize(`[bridge] 已删除运营商 ${provider.id}`, ANSI.green));
      await pause(rl);
    }
  }
}

async function runConsole(restArgs) {
  const args = parseArgs(restArgs);
  const configPath = resolveConfigPath(args.config || defaultConfigPath);

  if (!existsSync(configPath)) {
    writeBridgeConfig(configPath, readBridgeConfig(configPath));
  }

  if (!isInteractive) {
    printHelp();
    return 0;
  }

  return withInterface(async (rl) => {
    while (true) {
      const action = await selectMenu(
        rl,
        "主菜单",
        [
          { label: "快速启动 Bridge", description: "按当前配置启动本地桥接服务", value: "serve" },
          { label: "启动 Claude", description: "通过当前运营商直接拉起 Claude CLI", value: "claude" },
          { label: "Cursor 集成", description: "检测 Cursor 并可选安装 Continue 插件与桥接配置", value: "cursor" },
          { label: "管理运营商", description: "新建、切换、编辑、删除运营商", value: "providers" },
          { label: "智能路由", description: "查看或切换 single / failover / round-robin", value: "route" },
          { label: "实时状态", description: "查看本地桥的线路健康度和请求统计", value: "status" },
          { label: "修改桥接设置", description: "端口、监听地址、超时和模型映射", value: "settings" },
          { label: "运行诊断", description: "检查配置状态与命令可用性", value: "doctor" },
          { label: "查看帮助", description: "显示全部命令与示例", value: "help" },
          { label: "退出", description: "关闭当前控制台", value: "exit" },
        ],
        () => ({
          statusRows: buildDashboardStatus(configPath).rows,
          footer: "你要的三段式布局已经启用：标题区 / 状态看板 / 交互菜单。",
        }),
      );

      if (action === "exit" || action === "__back__") {
        clearScreen();
        return 0;
      }

      if (action === "serve") {
        await showLoader("正在检查配置并启动本地 Bridge ...", 900);
        rl.close();
        clearScreen();
        return runServe(["--config", configPath]);
      }

      if (action === "claude") {
        await showLoader("正在准备 Claude 的桥接环境 ...", 900);
        rl.close();
        clearScreen();
        return runClaude(["--config", configPath, "--"]);
      }

      if (action === "cursor") {
        await showLoader("正在检测 Cursor 与插件集成状态 ...", 700);
        rl.close();
        clearScreen();
        return runCursor(["--config", configPath]);
      }

      if (action === "providers") {
        await manageProvidersConsole(configPath, rl);
        continue;
      }

      if (action === "route") {
        const nextAction = await selectMenu(
          rl,
          "智能路由",
          [
            { label: "查看当前策略", description: "显示当前路由模式与阈值", value: "show" },
            { label: "切到 single", description: "固定只走当前运营商", value: "single" },
            { label: "切到 failover", description: "主线路失败后自动切到备用线路", value: "failover" },
            { label: "切到 round-robin", description: "多线路轮询分发", value: "round-robin" },
            { label: "返回上一级", description: "回到主菜单", value: "back" },
          ],
          () => ({
            statusRows: buildDashboardStatus(configPath).rows,
            footer: "这是这款桥的核心差异点之一：把多运营商真正变成可控的路由层。",
          }),
        );

        if (nextAction === "show") {
          await runRoute(["show", "--config", configPath]);
          await pause(rl);
        } else if (nextAction !== "back" && nextAction !== "__back__") {
          await runRoute(["set", nextAction, "--config", configPath]);
          await pause(rl);
        }
        continue;
      }

      if (action === "status") {
        await runStatus(["--config", configPath]);
        await pause(rl);
        continue;
      }

      if (action === "settings") {
        let store = readBridgeConfig(configPath);
        store = await promptGeneralSettings(rl, store);
        writeBridgeConfig(configPath, store);
        console.log(colorize(`[bridge] 配置已更新：${configPath}`, ANSI.green));
        await pause(rl);
        continue;
      }

      if (action === "doctor") {
        await runDoctor(["--config", configPath]);
        await pause(rl);
        continue;
      }

      printHelp();
      await pause(rl);
    }
  });
}

async function main() {
  const { command, rest } = parseCommand(process.argv.slice(2));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "console":
      return runConsole(rest);
    case "init":
      return runInit(rest);
    case "configure":
      return runConfigure(rest);
    case "provider":
    case "providers":
      return runProvider(rest);
    case "route":
      return runRoute(rest);
    case "status":
      return runStatus(rest);
    case "serve":
      return runServe(rest);
    case "claude":
      return runClaude(rest);
    case "doctor":
      return runDoctor(rest);
    case "cursor":
      return runCursor(rest);
    case "ide":
      return runIde(rest);
    default:
      return runConsole(process.argv.slice(2));
  }
}

const code = await main();
process.exitCode = code;
