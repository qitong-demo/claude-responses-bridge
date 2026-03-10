# Claude Responses Bridge

Claude Responses Bridge is a small local CLI that lets Claude-style `/v1/messages` clients talk to an upstream OpenAI-compatible `/v1/responses` server.  
Claude Responses Bridge 是一个轻量本地 CLI，用来把 Claude 风格的 `/v1/messages` 请求桥接到上游兼容 OpenAI `/v1/responses` 的服务。

## Install | 安装

```powershell
npm install -g claude-responses-bridge
```

## 3 Steps | 三步完成

### 1. Init | 初始化

Create a local config template in the current folder.  
在当前目录生成本地配置模板。

```powershell
crb init
```

### 2. Edit Config | 修改配置

Edit `config.local.json` and fill in your own upstream address and API key.  
编辑 `config.local.json`，填入你自己的上游地址和 API key。

Redacted example | 脱敏示例:

```json
{
  "port": 3456,
  "listenHost": "127.0.0.1",
  "upstreamBaseUrl": "https://your-upstream.example.com",
  "apiKey": "<YOUR_API_KEY>",
  "requestTimeoutMs": 600000,
  "modelMap": {
    "default": "gpt-5.1-codex",
    "opus": "gpt-5.1-codex-max",
    "sonnet": "gpt-5.1-codex",
    "haiku": "gpt-5.1-codex-mini"
  }
}
```

You can also use the environment variable `GMN_API_KEY` instead of writing the key into the file.  
你也可以使用环境变量 `GMN_API_KEY`，而不是把 key 直接写进文件。

### 3. Start | 启动

Run a quick self-check first, then start the bridge or launch Claude through it.  
先做一次自检，然后启动 bridge，或者直接通过它启动 Claude。

```powershell
crb doctor
crb serve
```

Or:

```powershell
crb claude
```

One-shot example | 一次性调用示例:

```powershell
crb claude -p "Reply with just OK."
```

## Commands | 命令

- `crb init`
- `crb doctor`
- `crb serve`
- `crb claude [claude args...]`

Equivalent local form | 等价本地写法:

- `node .\cli.js init`
- `node .\cli.js doctor`
- `node .\cli.js serve`
- `node .\cli.js claude [claude args...]`

## What It Does | 它做了什么

- Starts a local bridge on `127.0.0.1` by default.  
  默认在 `127.0.0.1` 上启动本地 bridge。
- Accepts Anthropic-style `/v1/messages` requests.  
  接收 Anthropic 风格的 `/v1/messages` 请求。
- Forwards them to an upstream `/v1/responses` API.  
  转发到上游 `/v1/responses` API。
- Provides a wrapper command for Claude CLI.  
  为 Claude CLI 提供包装命令。

## Endpoints | 端点

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Troubleshooting | 故障排查

### `Cannot find module ...\\cli.js`

You are likely running `node .\cli.js ...` from the wrong folder.  
你大概率是在错误目录下执行了 `node .\cli.js ...`。

Use either:

```powershell
crb doctor
```

Or run the local file from the project folder:

```powershell
Set-Location .\Claude-Responses-Bridge
node .\cli.js doctor
```

### `hasApiKey: false`

The bridge did not receive your API key.  
这表示 bridge 没有拿到你的 API key。

Fix it by either:

- adding `apiKey` to `config.local.json`
- setting `GMN_API_KEY` in the current shell

### Claude still cannot connect

Check these items:

- `crb doctor` shows both `hasApiKey: true` and `claudeOnPath: true`
- your upstream really supports `POST /v1/responses`
- your API key is valid for that upstream
- your chosen port is not already in use

## Privacy | 隐私

- This README intentionally uses redacted examples only.  
  本 README 只使用脱敏示例。
- No local username, private domain, or real API key is shown here.  
  这里不会展示本机用户名、私有域名或真实 API key。
- If you share logs or screenshots, redact file paths, domains, and tokens first.  
  如果你需要分享日志或截图，请先遮住路径、域名和密钥。

## Open Source Release | 开源发布

- Repository: `https://github.com/qitong-demo/claude-responses-bridge`
- Homepage: `https://github.com/qitong-demo/claude-responses-bridge#readme`
- Issues: `https://github.com/qitong-demo/claude-responses-bridge/issues`
- Release notes: see `CHANGELOG.md`
- Recommended first git tag: `v0.1.0`
