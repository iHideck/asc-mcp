# asc-mcp

English | [日本語](README.ja.md)

An unofficial MCP server for the App Store Connect API. Install it as a Claude Code plugin, then ask Claude Code to do your App Store release work.

## Tools

| Tool | What it does |
| :- | :- |
| `list_apps` | Returns the name, bundle ID, and Apple ID of each app. |
| `get_release_status` | Returns the five newest builds, the live version, and the next version. Each build includes its processing status, its TestFlight status, the groups that received it, and the `ITMS-` warnings from its upload. |
| `get_localizations` | Returns the localized text of a version (description, keywords, promotional text, what's new, and URLs) and of App Information (name, subtitle, and privacy policy URL). |
| `ensure_version` | Prepares the next version. Creates the version if no version has that number. Changes the number of the editable version if the number differs. Also sets the release type and the phased release to the values you pass. |
| `select_build` | Selects the build to submit for the editable version. Does not select a build that is still processing, expired, or for internal testing only. |
| `set_localizations` | Writes localized App Store text to the editable version and App Information. Checks the character limits and URL formats before it writes. |
| `replace_screenshots` | Replaces the screenshots for one language and one display type of the editable version with the files you pass. Checks that the format and size of each image fit the display type before it uploads. |
| `set_review_detail` | Sets the review notes of the editable version and whether the app requires sign-in. Reports a missing contact or demo account. |
| `copy_review_contact` | Copies the App Review contact from a version of another app. Does not return the contact details. |
| `set_app_info` | Sets the categories, the content rights declaration, and the age rating answers in App Information. Returns the age rating that the App Store assigns. |
| `set_price` | Sets the app price. The only supported price is free. Each call requires your confirmation. |
| `set_availability` | Sets the territories where the app is available. Pass a list of territories or an app to match. Each call requires your confirmation. |
| `submit_for_review` | Submits a version for App Review. Checks the selected build first. Each call requires your confirmation. |
| `cancel_review` | Withdraws a version that is waiting for App Review or in App Review. Each call requires your confirmation. |
| `release_version` | Releases a version that passed App Review and is waiting for release. You cannot undo a release. Each call requires your confirmation. |
| `set_phased_release` | Pauses, resumes, or completes a phased release. You cannot undo a release to all users. Each call requires your confirmation. |

## Skill

`/asc-mcp:release` uses the tools above to take a version from preparation through App Review to release. Preparation includes the first-time setup of a new app. When you say something like "Prepare the next version" or "Submit it for review", Claude loads the skill.

## Install

The MCP server runs on the Node in your PATH. It requires Node 24 or later.

1. In App Store Connect, go to **Users and Access** > **Integrations** > **App Store Connect API** and create a team key. Set the role to App Manager or Admin. If you already have a team key with one of these roles, you can use that key.
2. Move the downloaded `AuthKey_<Key ID>.p8` file to `~/.appstoreconnect/private_keys/`. Run `chmod 600` on the file so that only you can read it.
3. In Claude Code, run these commands:

   ```
   /plugin marketplace add iHideck/asc-mcp
   /plugin install asc-mcp@asc-mcp
   ```

4. On the configuration screen, enter the Issuer ID and the Key ID. To change them later, run `/plugin configure asc-mcp@asc-mcp`.

## Development

The plugin is in `plugin/`. With the plugin, Claude Code installs only the dependencies in `plugin/package.json`. Keep development tools such as ESLint in the root `package.json`.

| Command | What it does |
| :- | :- |
| `make setup` | Installs the dependencies and downloads the OpenAPI specification from Apple. |
| `make check` | Runs the same checks as CI (ESLint, formatting, type checks, and tests). |
| `make download-openapi` | Downloads the current OpenAPI specification from Apple to `.local/` again. |
| `make validate-plugin` | Validates the plugin and marketplace configuration. |
| `make run-claude` | Starts Claude Code connected to the MCP server from your local source. |

The tests check that the path, parameters, and values of each request exist in the OpenAPI specification. Each CI run downloads the current specification from Apple and checks against it.

To test your local source against the real API, put the Issuer ID and the Key ID in the `ASC_ISSUER_ID` and `ASC_KEY_ID` environment variables, then run `make run-claude`. The plugin configuration does not reach a plugin that `claude --plugin-dir` loads. In this setup, tools that write do not change App Store Connect. Instead, they return the request they would have sent as an error. To write to App Store Connect, also set `ASC_READ_ONLY=0`.
