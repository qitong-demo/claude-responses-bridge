# Changelog

All notable changes to this project will be documented in this file.
The format is based on Keep a Changelog, and this project follows Semantic Versioning.

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
