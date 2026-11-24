---
description: Takes an App Store release (preparing the next version, setting up a new app, submitting for App Review, and releasing) through the asc-mcp tools. Use when asked something like "Ship the next version", "Publish this app on the App Store for the first time", "Replace the screenshots", "Submit it for review", "Release it", or "Pause the phased release".
---

# Release to the App Store

Use the asc-mcp tools to take the next version from preparation to release. If you do not know the bundle ID of the app, look it up with `list_apps`.

Each time you call a tool that you cannot undo (`release_version`, `set_phased_release`, `set_price`, and `set_availability`), Claude Code asks the user to confirm. Before you call one, describe in text what it will do, and call it only after the user agrees.

`submit_for_review` and `cancel_review` do not ask for confirmation, because you can withdraw a submission. Call them without waiting when the user has asked to submit or to withdraw, so that the work continues while the user is away.

## 1. Check the current state

1. Read the state of the builds and versions with `get_release_status`.
2. Decide the number of the next version and the build to submit. If they are not decided, ask the user.
   - A build that you can submit has a build version (`version`) equal to the version number and has finished processing (`VALID`).
   - If the user has not uploaded the build yet, ask them to upload it with the procedure of the app's repository (for example, `make release-testflight`). asc-mcp does not upload builds.

## 2. Prepare the version

The tools that write compare the current state with your input and change only the differences. You can repeat the same call.

1. Prepare the version with `ensure_version`. Pass the release type (`MANUAL`, `AFTER_APPROVAL`, or `SCHEDULED`) and the phased release that the user decided.
   - If you omit `copyright`, `ensure_version` copies the copyright of the previous version into a version that has none. For the first version, or to change the year or the owner, pass `copyright` (the year and the owner, such as `2026 Example Inc.`, without the © symbol). App Review requires it.
2. Select the build with `select_build`.
3. Read the current text with `get_localizations`, then write the text to change with `set_localizations`. Unless this is the first version of the app, every locale needs the What's New text (`whatsNew`).
   - If the app's repository has rules or a source of truth for the App Store text (for example, `docs/release.md`), follow them. After you write the text, check that it matches the source of truth.
4. To change the screenshots, use `replace_screenshots` for each locale and display type (`displayType`). A new version starts with a copy of the screenshots of the previous version.
   - If the app's repository has rules for taking screenshots or for the display types to fill (for example, `docs/release.md`), follow them.
   - The first version needs at least one screenshot for the `APP_IPHONE_61` display type. An app that also supports iPad also needs screenshots for `APP_IPAD_PRO_3GEN_129`.
5. Set the review notes and whether the app requires sign-in with `set_review_detail`. If the App Review contact is missing, copy it from a version of another app with `copy_review_contact`.
6. Tell the user the `warnings` and `skipped` of each tool.

If anything remains that only the App Store Connect website can set, such as App Privacy, enter it with the steps in [website.md](website.md). Ask the user to enter the demo account for App Review, because it includes a password.

## Setup for a new app

For an app that has never been on the App Store, also set the following in addition to step 2. You can repeat each call.

If `list_apps` does not return the app, create the app first with [Create an app](website.md#create-an-app).

1. Set the categories, the content rights declaration, and the age rating answers with `set_app_info`. The returned `appStoreAgeRating` is the age rating that the App Store assigns.
2. Set the price with `set_price`. The only supported price is free.
3. Set the territories with `set_availability`. To use the same territories as another app, use `sameAsApp`.
4. Copy the App Review contact from a version of another app with `copy_review_contact`.

Each call to set the price or the territories asks the user to confirm. Before the call, show the user the values you will set.

The API does not support the following. Enter them on the website with the steps in [website.md](website.md).

- [App Privacy](website.md#app-privacy)
- [Availability on Apple silicon Macs and on Apple Vision Pro](website.md#availability-on-mac-and-apple-vision-pro). For an iPhone-only release, clear both.

## 3. Submit for App Review

1. Call `submit_for_review` if the user has asked to submit (for example, "Ship the next version" or "Submit it for review"). Otherwise, ask the user first. If the error lists age rating questions that are not answered, ask the user for the answers, set them with `set_app_info` (`ageRating`), and call `submit_for_review` again.
2. Report the version number, the build number, the release type, whether the phased release is on, the text you changed (the full What's New text), and the screenshots you replaced. After submission, neither the text nor the screenshots can change until the submission is withdrawn with `cancel_review`.
3. After submission, check the state with `get_release_status`. The result of App Review takes from a few hours to a few days.

## 4. Release

- A version with `AFTER_APPROVAL` or `SCHEDULED` is released automatically after it passes App Review.
- A version with `MANUAL` changes to `PENDING_DEVELOPER_RELEASE` after it passes App Review. When the user says to release it, call `release_version`. You cannot undo a release.
- A phased release releases the version gradually over 7 days. With `set_phased_release`, you can pause it (`pause`), resume it (`resume`), or release to all users (`complete`). You cannot undo a release to all users.

## When App Review rejects the version or you withdraw it

- Ask the user to read the reason for the rejection in App Store Connect (Resolution Center). The API cannot read it.
- After the fix, update the version with step 2 and submit it again with step 3.
- To change a version that is in App Review, withdraw it with `cancel_review`. You can edit a withdrawn version again.
