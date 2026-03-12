# Changelog

All notable changes to this project will be documented in this file.
The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.3.1] - 2026-03-12

### Fixed

- `cursor` interactive install prompt now correctly waits for user input instead of exiting with an unsettled top-level await warning
- Removed accidental self-dependency metadata after release packaging
- Ignore `node_modules/` and `package-lock.json` in this repo to keep local release artifacts out of git

## [0.3.2] - 2026-03-12

### Fixed

- Cursor extension detection on Windows now invokes `cursor.cmd` through PowerShell, so installed extensions like Continue are detected reliably
- Cursor integration no longer flips between installed and not-installed states depending on how the CLI resolves the Cursor command

## [0.3.3] - 2026-03-12

### Fixed

- Bridge now serializes upstream requests per provider to reduce `Concurrency limit exceeded for account` errors from low-concurrency upstream gateways
- Provider status output now exposes queue and in-flight counts for easier troubleshooting

## [0.3.4] - 2026-03-12

### Fixed

- Cursor integration now writes both `~/.continue/config.yaml` and a bridge-managed `~/.continue/config.ts`, so Continue can show configured models more reliably across config loading modes
- Cursor status output now reports both YAML and TypeScript Continue config states

## [0.3.0] - 2026-03-12

### Added

- Local OpenAI-compatible `/v1/chat/completions` bridge that converts Cursor/Cline requests into upstream `/v1/responses`
- Local OpenAI-compatible `/v1/responses` passthrough with provider failover support
- `ide` CLI command that prints Cursor and VSCode/Cline setup values
- `cursor` CLI command that detects Cursor, can install Continue, and can write bridge-backed Continue config
- `/models` and `/chat/completions` aliases so clients can use base URLs with or without `/v1`

### Changed

- `/health` now includes IDE-friendly local bridge settings
- `/v1/models` now returns upstream model ids plus Claude alias entries
- CLI shutdown now uses `process.exitCode` to avoid Windows assertion failures after network requests
- Streaming chat and messages routes now forward upstream Responses SSE in real time instead of waiting for a full response first
- `.npmrc` is now ignored so local npm tokens do not get committed accidentally

## [0.2.1] - 2026-03-10

### Changed

- Replaced hard-coded default upstream domain with a neutral example domain
- Replaced package author and repository metadata with neutral placeholders
- Removed remaining public identity hints from the distributed source

## [0.2.0] - 2026-03-10

### Added

- Interactive CLI console as the default startup experience
- Multi-provider config model with active provider selection
- `configure`, `provider list`, `provider add`, `provider update`, `provider use`, and `provider remove` commands
- Guided provider setup when `serve` or `claude` is missing a token
- Richer `doctor` output with provider context and warnings
- Provider details in the local `/health` endpoint
- Three-section terminal layout with Header, Status Table, and Interactive Menu
- ANSI-colored Chinese console UI with arrow-key navigation and action loader feedback
- Local-first smart routing with `single`, `failover`, and `round-robin`
- `/bridge/status` telemetry endpoint for provider health and recent request stats

### Changed

- `config.example.json` now documents the multi-provider schema
- Existing single-provider configs remain backward compatible and are normalized on load
- README now focuses on CLI-first setup and provider workflows
- Bridge startup logs include the selected provider identity
- Provider metadata now supports enablement, priority, weight, tags, notes, and price hints

## [0.1.0] - 2026-03-10

### Added

- Local bridge for Anthropic-style `/v1/messages` to upstream `/v1/responses`
- `crb` and `claude-responses-bridge` CLI commands
- `init`, `doctor`, `serve`, and `claude` subcommands
- Model mapping from Claude-family names to upstream Responses models
- Local config template with redacted public example
- User-focused bilingual README with a 3-step setup flow

### Changed

- Corrected CLI docs to use `cli.js` instead of `cli.mjs`
- Sanitized package docs and config example to avoid local/private information
- Prepared package metadata for npm publishing

### Notes

- Recommended first git release tag: `v0.1.0`
- Recommended npm dist-tag: `latest`
