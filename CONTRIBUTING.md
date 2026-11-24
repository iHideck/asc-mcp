# Contributing

Thank you for your interest in asc-mcp. You can write issues and pull requests in English or Japanese.

## Report a bug or request a feature

Open an issue with a template:

- [Bug report](https://github.com/iHideck/asc-mcp/issues/new?template=bug_report.yml)
- [Feature request](https://github.com/iHideck/asc-mcp/issues/new?template=feature_request.yml)

Do not put your Issuer ID, Key ID, private key, or App Review contact details in an issue. To report a security vulnerability, follow [SECURITY.md](SECURITY.md).

## Send a pull request

1. For a change larger than a typo fix, open an issue first so that we can agree on the approach.
2. Set up the repository and run the checks as described in [Development](README.md#development) in the README.
3. Keep each pull request to one purpose. If a change adds or changes a tool, update the tool table in both `README.md` and `README.ja.md`, and add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
4. Before you open the pull request, make sure that `make check` and `make validate-plugin` pass.

### Rules for changes

- Every request that the server sends must exist in Apple's OpenAPI specification. The tests check each request against the specification that Apple currently publishes.
- Tests must not call the real App Store Connect API. Use the fake API in `test/fake-api.ts`.
- Text that users see (tool descriptions, parameter descriptions, errors, progress messages, and the skill) is in English.
- A tool that does something you cannot undo, such as releasing or changing what customers can buy, must require user confirmation. Do not require it for a tool that you can undo, such as `submit_for_review` (undone by `cancel_review`), because it stops unattended sessions. Set `_meta["anthropic/requiresUserInteraction"]` on it.
- Do not return or log secrets or App Review contact details, including in error messages.

When you try your change against the real API, keep the default `ASC_READ_ONLY=1` unless you mean to write to App Store Connect.
