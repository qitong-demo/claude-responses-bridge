# Changelog

All notable changes to this project will be documented in this file.  
本项目的重要变更会记录在这里。

The format is based on Keep a Changelog, and this project follows Semantic Versioning.  
格式参考 Keep a Changelog，版本遵循 Semantic Versioning。

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
