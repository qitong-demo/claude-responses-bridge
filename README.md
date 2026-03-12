# Claude Responses Bridge

Claude Responses Bridge is a local CLI that lets Claude-style `/v1/messages`
clients talk to an upstream OpenAI-compatible `/v1/responses` server.

This project now ships with:

- an interactive startup console
- direct provider and token configuration inside the CLI
- multi-provider management with create, switch, update, and delete flows
- a local OpenAI-compatible `/v1/chat/completions` bridge for Cursor and Cline
- a local OpenAI-compatible `/v1/responses` passthrough for tools that already use Responses API
- a Cursor integration command that can detect Cursor, install Continue, and write a bridge-backed Continue config
- backward compatibility for older single-provider `config.local.json` files
- a three-section terminal layout with Header, Status Table, and Interactive Menu
- Chinese UI copy, ANSI colors, box borders, and keyboard navigation
- local-first smart routing with `single`, `failover`, and `round-robin`
- live provider telemetry from `/bridge/status`

## Install

```powershell
npm install -g claude-responses-bridge
```

## Quick Start

Open the interactive console:

```powershell
crb
```

Or run the local file:

```powershell
node .\cli.js
```

The console shows the current bridge state and gives you guided actions for:

- starting the bridge
- launching Claude through the bridge
- editing bridge settings
- managing providers
- running diagnostics

The interactive console now uses:

- a branded ASCII Art header
- a status dashboard with provider and bridge state
- an arrow-key menu instead of typing `1`, `2`, `3`
- a short loader before high-impact actions such as starting the bridge

## Direct CLI Configuration

You can also configure everything without opening the console:

```powershell
crb configure --name Main --base-url https://your-upstream.example.com --api-key sk-xxxx
```

That command creates or updates the active provider and writes the config file.

You can override bridge settings at the same time:

```powershell
crb configure `
  --name Main `
  --base-url https://your-upstream.example.com `
  --api-key sk-xxxx `
  --port 3456 `
  --host 127.0.0.1 `
  --timeout 600000 `
  --map-default gpt-5.1-codex
```

## Cursor Plugin Setup

If Cursor Free blocks the native BYOK model picker, use the bridge through an
official third-party extension instead of trying to unlock Cursor's built-in
named models.

Guided Cursor integration:

```powershell
crb cursor
```

Non-interactive install + config write:

```powershell
crb cursor --install --write-config
```

This flow:

- detects the local Cursor command path
- checks whether the official `Continue` extension is installed
- optionally installs `Continue` into Cursor
- optionally writes `~/.continue/config.yaml` so Continue uses the local bridge

This flow does not:

- unlock Cursor's built-in named model picker
- remove Cursor's native free-plan restriction
- modify your upstream provider key inside Cursor's native account system

## Provider Management

List providers:

```powershell
crb provider list
```

Add a provider:

```powershell
crb provider add --name Backup --base-url https://backup.example.com --api-key sk-backup
```

Add and activate it immediately:

```powershell
crb provider add --name Backup --base-url https://backup.example.com --api-key sk-backup --activate
```

Switch the active provider:

```powershell
crb provider use backup
```

Update or replace a provider:

```powershell
crb provider update backup --base-url https://new-upstream.example.com --api-key sk-new
```

Delete a provider:

```powershell
crb provider remove backup
```

The CLI prevents deleting the last remaining provider so the bridge does not
fall into an unusable state.

## Start the Bridge

Start the local bridge with the active provider:

```powershell
crb serve
```

Start it with a specific provider:

```powershell
crb serve --provider backup
```

On startup the CLI now prints a short session overview that shows the selected
provider, upstream, token preview, and local listen address.

## Launch Claude Through the Bridge

```powershell
crb claude
```

Choose a provider for one run:

```powershell
crb claude --provider backup
```

Pass Claude CLI arguments after `--`:

```powershell
crb claude --provider backup -- -p "Reply with just OK."
```

## Diagnostics

Human-readable doctor output:

```powershell
crb doctor
```

JSON doctor output:

```powershell
crb doctor --json
```

The doctor report includes:

- config path
- active provider
- upstream base URL
- masked token state
- Claude CLI detection
- local listen URL
- warnings

## Cursor and VSCode / Cline

Start the bridge:

```powershell
node .\cli.js serve
```

Print IDE-ready local settings:

```powershell
node .\cli.js ide
node .\cli.js ide --json
```

Or use the guided Cursor integration flow:

```powershell
node .\cli.js cursor
```

The bridge now exposes an OpenAI-compatible local endpoint:

```text
http://127.0.0.1:3456/v1
```

Use this local endpoint inside Cursor or Cline instead of your upstream proxy:

- Base URL: `http://127.0.0.1:3456/v1`
- API Key: `bridge-local`
- Recommended model: `gpt-5.2-codex`

### Cursor

In `Settings -> Models -> API Keys`:

- enable `OpenAI API Key`
- set the key to `bridge-local`
- enable `Override OpenAI Base URL`
- set the base URL to `http://127.0.0.1:3456/v1`
- choose `gpt-5.2-codex`

If your Cursor plan blocks native BYOK flows, install Cline inside Cursor and use
the Cline setup below, or run `crb cursor` to set up Continue automatically.

### VSCode / Cursor + Cline

In Cline settings:

- `API Provider`: `OpenAI Compatible`
- `Base URL`: `http://127.0.0.1:3456/v1`
- `API Key`: `bridge-local`
- `Model ID`: `gpt-5.2-codex`
- `Native Tool Call`: optional, but supported by the bridge

## Smart Routing

This bridge is no longer just a static relay. It now supports:

- `single`: always use the selected provider
- `failover`: use the selected provider first, then automatically retry other enabled providers
- `round-robin`: distribute requests across enabled providers

Show the current route mode:

```powershell
crb route show
```

Switch to automatic failover:

```powershell
crb route set failover
```

Inspect live provider health:

```powershell
crb status
```

Local status endpoint:

```text
GET /bridge/status
```

## Config File

The config format now supports multiple providers. A simplified example:

```json
{
  "schemaVersion": 2,
  "port": 3456,
  "listenHost": "127.0.0.1",
  "upstreamBaseUrl": "https://your-upstream.example.com",
  "apiKey": "<YOUR_ACTIVE_PROVIDER_TOKEN>",
  "requestTimeoutMs": 600000,
  "selectedProviderId": "main",
  "providers": [
    {
      "id": "main",
      "name": "Main Provider",
      "baseUrl": "https://your-upstream.example.com",
      "apiKey": "<YOUR_ACTIVE_PROVIDER_TOKEN>"
    }
  ],
  "modelMap": {
    "default": "gpt-5.1-codex",
    "opus": "gpt-5.1-codex-max",
    "sonnet": "gpt-5.1-codex",
    "haiku": "gpt-5.1-codex-mini"
  }
}
```

Older configs with only `upstreamBaseUrl` and `apiKey` still work. They are
normalized into the new provider model when the CLI loads them.

## Endpoints

- `GET /health`
- `GET /models`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /chat/completions`
- `POST /v1/chat/completions`
- `POST /responses`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Notes

- `config.local.json` remains ignored by git.
- Keep real domains and tokens out of screenshots and logs.
- Use `config.example.json` as a safe public example.
