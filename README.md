# Claude Responses Bridge

Claude Responses Bridge is a small local CLI that lets Claude-style `/v1/messages` clients talk to an upstream OpenAI-compatible `/v1/responses` server.  
Claude Responses Bridge ??????? CLI,??? Claude ??? `/v1/messages` ????????? OpenAI `/v1/responses` ????

## Install | ??

```powershell
npm install -g claude-responses-bridge
```

## 3 Steps | ????

### 1. Init | ???

Create a local config template in the current folder.  
??????????????

```powershell
crb init
```

### 2. Edit Config | ????

Edit `config.local.json` and fill in your own upstream address and API key.  
?? `config.local.json`,??????????? API key?

Redacted example | ????:

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
?????????? `GMN_API_KEY`,???? key ???????

### 3. Start | ??

Run a quick self-check first, then start the bridge or launch Claude through it.  
??????,???? bridge,????????? Claude?

```powershell
crb doctor
crb serve
```

Or:

```powershell
crb claude
```

One-shot example | ???????:

```powershell
crb claude -p "Reply with just OK."
```

## Commands | ??

- `crb init`
- `crb doctor`
- `crb serve`
- `crb claude [claude args...]`

Equivalent local form | ??????:

- `node .\cli.js init`
- `node .\cli.js doctor`
- `node .\cli.js serve`
- `node .\cli.js claude [claude args...]`

## What It Does | ?????

- Starts a local bridge on `127.0.0.1` by default.  
  ??? `127.0.0.1` ????? bridge?
- Accepts Anthropic-style `/v1/messages` requests.  
  ?? Anthropic ??? `/v1/messages` ???
- Forwards them to an upstream `/v1/responses` API.  
  ????? `/v1/responses` API?
- Provides a wrapper command for Claude CLI.  
  ? Claude CLI ???????

## Endpoints | ??

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Troubleshooting | ????

### `Cannot find module ...\\cli.js`

You are likely running `node .\cli.js ...` from the wrong folder.  
?????????????? `node .\cli.js ...`?

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
??? bridge ?????? API key?

Fix it by either:

- adding `apiKey` to `config.local.json`
- setting `GMN_API_KEY` in the current shell

### Claude still cannot connect

Check these items:

- `crb doctor` shows both `hasApiKey: true` and `claudeOnPath: true`
- your upstream really supports `POST /v1/responses`
- your API key is valid for that upstream
- your chosen port is not already in use

## Privacy | ??

- This README intentionally uses redacted examples only.  
  ? README ????????
- No local username, private domain, or real API key is shown here.  
  ??????????????????? API key?
- If you share logs or screenshots, redact file paths, domains, and tokens first.  
  ????????????,?????????????

## Open Source Release | ????

- Repository: `https://github.com/qitong-demo/claude-responses-bridge`
- Homepage: `https://github.com/qitong-demo/claude-responses-bridge#readme`
- Issues: `https://github.com/qitong-demo/claude-responses-bridge/issues`
- Release notes: see `CHANGELOG.md`
- Recommended first git tag: `v0.1.0`
