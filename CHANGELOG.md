# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The `release` skill enters the settings that the API does not support (creating an app, App Privacy, and availability on Mac and Apple Vision Pro) on the App Store Connect website with Claude in Chrome. It asks the user before it creates the app or publishes App Privacy. Without Claude in Chrome, it asks the user to enter them as before.

- `submit_for_review` and `cancel_review` no longer ask for confirmation in Claude Code, because you can withdraw a submission. `release_version`, `set_phased_release`, `set_price`, and `set_availability` still ask.

### Added

- `set_app_info` reads and sets the age rating questions `sharedLocation` and `datingAndRelationships`.
- `set_app_info` warns about age rating questions that are not answered, even when the App Store age rating is already set.
- When App Store Connect refuses `submit_for_review` and some age rating questions are not answered, the error lists them.
- `ensure_version` sets the copyright (`copyright`). If you omit it and the version has none, it copies the copyright of the previous version. `get_release_status` returns the copyright of each version, and `submit_for_review` stops before submission when the copyright is empty.

## [1.0.0] - 2026-11-17

The first release.

### Added

- Claude Code plugin and marketplace. Install with `/plugin marketplace add iHideck/asc-mcp` and `/plugin install asc-mcp@asc-mcp`.
- npm package `@ihideck/asc-mcp` for other MCP clients, such as Claude Desktop and Cursor. Start the server with `npx -y @ihideck/asc-mcp`.
- Tools that read: `list_apps`, `get_release_status` (including `ITMS-` warnings from the upload), and `get_localizations`.
- Tools that prepare a version: `ensure_version`, `select_build`, `set_localizations`, `replace_screenshots`, `set_review_detail`, and `copy_review_contact`.
- Tools that set up a new app: `set_app_info` (categories, content rights declaration, and age rating), `set_price` (free only), and `set_availability`.
- Tools that submit and release: `submit_for_review`, `cancel_review`, `release_version`, and `set_phased_release`. Claude Code asks for confirmation each time one of them, `set_price`, or `set_availability` is called.
- `release` skill that takes a version from preparation through App Review to release.
- Read-only mode (`ASC_READ_ONLY=1`): tools that write return the request instead of sending it.
- Tests that check every request against the OpenAPI specification that Apple currently publishes. CI also runs on the 1st and 15th of each month to detect changes in the specification.

[Unreleased]: https://github.com/iHideck/asc-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/iHideck/asc-mcp/releases/tag/v1.0.0
