---
description: Reads App Store numbers of an app (impressions, product page views, first-time downloads, conversion, sessions, deletions, sales, and the same numbers by territory) through the asc-mcp tools instead of screenshots of App Store Connect. Use when asked something like "How many impressions did the app get last week?", "Show downloads by country", "What is the conversion rate?", or "Write the weekly App Store report".
---

# Read App Store analytics

Use `get_analytics_report` for App Analytics (impressions, product page views, downloads, sessions, and deletions) and `get_sales_report` for Sales and Trends (units). If you do not know the bundle ID of the app, look it up with `list_apps`.

## 1. Request the reports once

1. Call `ensure_analytics_reports` for the app. It creates the report request if the app has none, and returns the names of the reports.
   - Creating the request requires an API key with the Admin role.
   - If `created` is `true`, tell the user that Apple generates the first reports in 1 to 2 days, and stop. The reports start from the day of the request.
2. Use the report names exactly as `ensure_analytics_reports` returns them.

If `get_analytics_report` returns `NOT_REQUESTED` or `STOPPED`, call `ensure_analytics_reports`. If it returns `PROCESSING`, the reports are not ready yet. Try again the next day.

## 2. Read the numbers

Pass `startDate` and `endDate`, then narrow the rows with `filters` and group them with `groupBy`. Add `Territory` to `groupBy` to get the numbers by territory.

| Number | Report | `filters` | Column to read |
| :- | :- | :- | :- |
| Impressions | App Store Discovery and Engagement Standard | `{"Event": ["Impression"]}` | `Counts` |
| Product page views | App Store Discovery and Engagement Standard | `{"Event": ["Page view"], "Page Type": ["Product page"]}` | `Counts` |
| First-time downloads | App Store Downloads Standard | `{"Download Type": ["First-time Download"]}` | `Counts` |
| Redownloads | App Store Downloads Standard | `{"Download Type": ["Redownload"]}` | `Counts` |
| Sessions and active devices | App Sessions Standard | none | the session columns and `Unique Devices` |
| Deletions | App Store Installations and Deletions Standard | `{"Event": ["Delete"]}` | `Counts` |

- The names in this table come from Apple's documentation. If a report or column has another name, the error lists the names that exist. If a filter value matches no rows, `warnings` lists the values that exist. Use those names and values.
- `Unique Counts` and `Unique Devices` are unique only within one row of the report. Do not add them over days and call the sum unique users. For a period, report `Counts`.
- Product page conversion is first-time downloads divided by product page views for the same period. App Store Connect computes its conversion rate from unique impressions with its own deduplication, so its value can differ. Say which formula you used.
- Apple omits values from fewer than 5 users or devices, and the numbers of the last 2 to 5 days can still change. For a weekly report, read the week that ended at least 5 days ago, or mark the last days as preliminary.

The API has no report for retention (the share of users who come back after they download the app). Do not compute retention from these reports. If the user asks for it, say that only the Retention page of App Store Connect shows it, and offer sessions and deletions instead.

## 3. Read sales

1. Ask the user for the vendor number if you do not know it. It is in App Store Connect under **Payments and Financial Reports**.
2. Call `get_sales_report` with the date. Pass `bundleId` to keep only the rows of the app, and group by `Country Code` or `Product Type Identifier`.
   - `DAILY` reports are usually ready the next day. `NO_DATA` means that nothing was recorded on that date or that the report is not ready yet.
   - For a week, use `WEEKLY` with the Sunday that ends the week.
   - For the meaning of each product type identifier, see [Product type identifiers](https://developer.apple.com/help/app-store-connect/reference/product-type-identifiers).

## 4. Report

Report each number with its period, the report that it came from, and the formula of each rate. If a number is preliminary or missing, say so.
