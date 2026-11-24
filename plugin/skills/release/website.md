# Settings that only the website supports

The App Store Connect API cannot set the following. Enter them on the App Store Connect website with Claude in Chrome, which works in the user's own Chrome, where the user is already signed in.

- [Creating an app](#create-an-app)
- [App Privacy](#app-privacy)
- [Availability on Apple silicon Macs and on Apple Vision Pro](#availability-on-mac-and-apple-vision-pro)

## Before you start

1. Read the values to enter from the app's repository (for example, `docs/app-store.md`, `docs/release.md`, or the README). Ask the user only for the values that you cannot find there.
2. Check that the Claude in Chrome tools (`mcp__claude-in-chrome__*`) are available. If a skill for Claude in Chrome is available, follow it. If the tools are not available, follow [When Claude in Chrome is not available](#when-claude-in-chrome-is-not-available).
3. Open [App Store Connect](https://appstoreconnect.apple.com/apps) in a new tab. If the sign-in page or a two-factor authentication prompt appears, ask the user to sign in. Never enter a password or a verification code.

The labels below are from the English website. If the website is in another language (for example, Japanese), find the label with the same meaning. Take a screenshot after each save, and compare the page with the values you entered.

## Create an app

Do this when `list_apps` does not return the bundle ID. The other tools cannot find the app until it exists.

The bundle ID must already be registered in [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list). If it is not, ask the user to register it with the procedure of the app's repository.

1. On the [Apps](https://appstoreconnect.apple.com/apps) page, click the add button (**+**) next to **Apps**, and then click **New App**.
2. Enter the values:
   - **Platforms**: only the platforms that the app supports (for example, **iOS**).
   - **Name**: the app name on the App Store (up to 30 characters).
   - **Primary Language**.
   - **Bundle ID**: select the bundle ID from the menu.
   - **SKU**: an ID for your own records. If the repository does not give one, propose the last part of the bundle ID.
   - **User Access**: **Full Access**.
3. Show the user the values, and click **Create** only after the user agrees. You cannot change the bundle ID or the SKU later.
4. Check with `list_apps` that the app exists.

## App Privacy

Set the privacy policy URL first with `set_localizations` (`privacyPolicyUrl`). App Privacy uses the same URL.

1. Open the app, and click **App Privacy** in the sidebar.
2. Under **Data Types**, click **Get Started**. If the app already has answers, click **Edit**.
3. For **Do you or your third-party partners collect data from this app?**, select the answer from the repository, and click **Next**.
4. Select every data type that the app collects, and click **Save**.
5. For each data type, click **Set Up**, and answer the questions:
   1. How the data is used (for example, **Analytics** or **App Functionality**). Select every purpose, and click **Next**.
   2. Whether the data is linked to the user's identity. Click **Next**.
   3. Whether the data is used for tracking. Click **Save**.
6. Compare the summary on the page with the values from the repository.
7. Show the user each data type with its purposes, whether it is linked to the user, and whether it is used for tracking. Click **Publish** only after the user agrees. The answers appear on the App Store as soon as you publish them.

## Availability on Mac and Apple Vision Pro

1. Open the app, and click **Pricing and Availability** in the sidebar.
2. Under **iPhone and iPad Apps on Apple Silicon Macs** and under **iPhone and iPad Apps on Apple Vision Pro**, select or clear **Make this app available** as the repository says. For an iPhone-only release, clear both.
3. If the app is already on the App Store, the change reaches users immediately. In that case, show the user the change and save only after the user agrees.
4. Click **Save**. Reload the page, and check that both settings stayed.

## When Claude in Chrome is not available

Ask the user to enter the settings on the website. Write the steps in a numbered list with the URL to open, the labels on the page, and the values to enter. Ask the user to tell you when they finish. Then check what you can: for a new app, check with `list_apps` that the app exists. For App Privacy and availability, which Claude cannot read, ask the user for a screenshot of the page.
