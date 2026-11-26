# asc-mcp

English | [日本語](README.ja.md)

An unofficial MCP server for the App Store Connect API. Install it as a Claude Code plugin, then ask Claude Code to do your App Store release work.

## Tools

| Tool | What it does |
| :- | :- |
| `list_apps` | Returns the name, bundle ID, and Apple ID of each app. |
| `get_release_status` | Returns the five newest builds, the live version, and the next version. Each build includes its processing status, its TestFlight status, the groups that received it, and the `ITMS-` warnings from its upload. Each version includes its copyright. |
| `get_localizations` | Returns the localized text of a version (description, keywords, promotional text, what's new, and URLs) and of App Information (name, subtitle, and privacy policy URL). |
| `ensure_version` | Prepares the next version. Creates the version if no version has that number. Changes the number of the editable version if the number differs. Also sets the release type, the phased release, and the copyright to the values you pass. If you omit the copyright and the version has none, copies it from the previous version. |
| `select_build` | Selects the build to submit for the editable version. Does not select a build that is still processing, expired, or for internal testing only. |
| `set_localizations` | Writes localized App Store text to the editable version and App Information. Adds a locale that the app does not have yet (`name` is required to add it to App Information). Checks the locale codes, character limits, and URL formats before it writes. |
| `replace_screenshots` | Replaces the screenshots for one language and one display type of the editable version with the files you pass. Checks that the format and size of each image fit the display type before it uploads. |
| `set_review_detail` | Sets the review notes of the editable version and whether the app requires sign-in. Reports a missing contact or demo account. |
| `copy_review_contact` | Copies the App Review contact from a version of another app. Does not return the contact details. |
| `set_app_info` | Sets the categories, the content rights declaration, and the age rating answers in App Information. Returns the age rating that the App Store assigns, and warns about age rating questions that are not answered. |
| `set_price` | Sets the app price. The only supported price is free. Each call requires your confirmation. |
| `set_availability` | Sets the territories where the app is available. Pass a list of territories or an app to match. Each call requires your confirmation. |
| `get_subscriptions` | Returns the auto-renewable subscription groups and subscriptions of an app, with their localized text, review screenshot, territories, prices, and free trials. |
| `ensure_subscription` | Creates or updates a subscription group and a subscription: product ID, duration, reference name, Family Sharing, localized display names and descriptions, review notes, and review screenshot. Changes only the values that differ. |
| `set_subscription_price` | Sets the territories of a subscription and its price in every territory, from the price in a base territory. Each call requires your confirmation. |
| `set_introductory_offer` | Sets a free trial for new subscribers in each territory. Each call requires your confirmation. |
| `submit_for_review` | Submits a version for App Review. Checks the copyright and the selected build first. If the submission is refused, lists the age rating questions that are not answered. You can withdraw it with `cancel_review`. |
| `cancel_review` | Withdraws a version that is waiting for App Review or in App Review. |
| `release_version` | Releases a version that passed App Review and is waiting for release. You cannot undo a release. Each call requires your confirmation. |
| `set_phased_release` | Pauses, resumes, or completes a phased release. You cannot undo a release to all users. Each call requires your confirmation. |
| `ensure_analytics_reports` | Creates the analytics report request of an app if it has none, and returns the names of its reports. Apple generates the first reports 1 to 2 days later. |
| `get_analytics_report` | Reads an analytics report (impressions, product page views, downloads, sessions, and more) for a date range, then filters, groups, and sums its rows. Returns whether the reports are still being generated. |
| `get_sales_report` | Reads a Sales and Trends report for one date, then filters, groups, and sums its rows. |

## Skill

`/asc-mcp:release` uses the tools above to take a version from preparation through App Review to release. Preparation includes the first-time setup of a new app. When you say something like "Prepare the next version" or "Submit it for review", Claude loads the skill.

`/asc-mcp:analytics` reads impressions, product page views, first-time downloads, conversion, and sales of an app, also by territory. Retention is not in the API. Claude loads it when you ask something like "How many downloads did the app get last week?"

## Install

The MCP server runs on the Node in your PATH. It requires Node 24 or later.

1. In App Store Connect, go to **Users and Access** > **Integrations** > **App Store Connect API** and create a team key. Set the role to App Manager or Admin. `ensure_analytics_reports` requires Admin. If you already have a team key with one of these roles, you can use that key.
2. Move the downloaded `AuthKey_<Key ID>.p8` file to `~/.appstoreconnect/private_keys/`. Run `chmod 600` on the file so that only you can read it.
3. In Claude Code, run these commands:

   ```
   /plugin marketplace add iHideck/asc-mcp
   /plugin install asc-mcp@asc-mcp
   ```

4. On the configuration screen, enter the Issuer ID and the Key ID. To change them later, run `/plugin configure asc-mcp@asc-mcp`.

## Use with other MCP clients

The MCP server also works in other MCP clients, such as Claude Desktop and Cursor. The `release` skill is for Claude Code only.

1. Do steps 1 and 2 of [Install](#install).
2. Add the server to the MCP configuration of your client. In Claude Desktop, go to **Settings** > **Developer** > **Edit Config**. In Cursor, edit `~/.cursor/mcp.json`.

   ```json
   {
     "mcpServers": {
       "asc": {
         "command": "npx",
         "args": ["-y", "@ihideck/asc-mcp"],
         "env": {
           "ASC_ISSUER_ID": "<Issuer ID>",
           "ASC_KEY_ID": "<Key ID>"
         }
       }
     }
   }
   ```

3. Restart the client. Check that the client lists `list_apps` among the tools.

To run the server from source instead, run `git clone https://github.com/iHideck/asc-mcp.git` and `npm ci --prefix asc-mcp/plugin`. Then set `"command": "node"` and `"args": ["/absolute/path/to/asc-mcp/plugin/src/index.ts"]`.

Tools that release or change the price or territories ask for confirmation only in Claude Code. In other clients, set the client to ask before it calls those tools. To make every tool that writes return the request instead of sending it, add `"ASC_READ_ONLY": "1"` to `env`.

## Development

The plugin is in `plugin/`. With the plugin, Claude Code installs only the dependencies in `plugin/package.json`. Keep development tools such as ESLint in the root `package.json`.

| Command | What it does |
| :- | :- |
| `make setup` | Installs the dependencies and downloads the OpenAPI specification from Apple. |
| `make check` | Runs the same checks as CI (ESLint, formatting, type checks, and tests). |
| `make download-openapi` | Downloads the current OpenAPI specification from Apple to `.local/` again. |
| `make validate-plugin` | Validates the plugin and marketplace configuration. |
| `make run-claude` | Starts Claude Code connected to the MCP server from your local source. |
| `make pack-npm` | Builds the npm package (`@ihideck/asc-mcp`) into a `.tgz` file in `plugin/`. |

The tests check that the path, parameters, and values of each request exist in the OpenAPI specification. Each CI run downloads the current specification from Apple and checks against it.

To test your local source against the real API, put the Issuer ID and the Key ID in the `ASC_ISSUER_ID` and `ASC_KEY_ID` environment variables, then run `make run-claude`. The plugin configuration does not reach a plugin that `claude --plugin-dir` loads. In this setup, tools that write do not change App Store Connect. Instead, they return the request they would have sent as an error. To write to App Store Connect, also set `ASC_READ_ONLY=0`.

## Contributing

To report a bug, request a feature, or send a pull request, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
