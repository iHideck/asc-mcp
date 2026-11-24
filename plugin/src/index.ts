#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { ageRatingInput, CONTENT_RIGHTS, setAppInfo } from './app-info.ts';
import { listApps } from './apps.ts';
import { setAvailability } from './availability.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { createClient, isReadOnly, type AscClient } from './client.ts';
import { ensureVersion, RELEASE_TYPES } from './ensure-version.ts';
import { getLocalizations } from './localizations.ts';
import { setFreePrice } from './price.ts';
import { getReleaseStatus } from './release-status.ts';
import { PHASED_RELEASE_ACTIONS, releaseVersion, setPhasedRelease } from './release.ts';
import { copyReviewContact, setReviewDetail } from './review-detail.ts';
import { cancelReview, submitForReview } from './review-submission.ts';
import {
  DISPLAY_TYPE_NAMES,
  DISPLAY_TYPES,
  MAX_SCREENSHOTS,
  replaceScreenshots,
} from './screenshots.ts';
import { selectBuild } from './select-build.ts';
import { localizationInput, setLocalizations } from './set-localizations.ts';
import { PLATFORMS } from './versions.ts';

let client: AscClient | undefined;

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
async function getClient(): Promise<AscClient> {
  client ??= createClient(
    createTokenSource(await loadCredentials(process.env)),
    fetch,
    isReadOnly(process.env.ASC_READ_ONLY),
  );
  return client;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const appArguments = {
  bundleId: z.string().min(1).describe('Bundle ID of the app (for example, com.example.myapp)'),
  platform: z.enum(PLATFORMS).default('IOS'),
};

// 外に出る操作は、Claude Code が呼ぶたびに、利用者の確認を求める（どの権限のモードでも、許可の決まりでも省けない）
const NEEDS_APPROVAL = { 'anthropic/requiresUserInteraction': true };

const server = new McpServer({ name: 'asc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'List apps',
    description: 'Returns the name, bundle ID, and Apple ID of each app in App Store Connect.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => json({ apps: await listApps(await getClient()) }),
);

server.registerTool(
  'get_release_status',
  {
    title: 'Get release status',
    description:
      'Returns the five newest builds, the live version, and the next version. Each build includes its processing status, its TestFlight status, the groups that received it, and the ITMS- errors and warnings from its upload (uploadIssues; null if no record exists). Each version includes its state, its release type, its selected build, and its phased release.',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ bundleId, platform }) =>
    json(await getReleaseStatus(await getClient(), bundleId, platform)),
);

server.registerTool(
  'get_localizations',
  {
    title: 'Get localized text',
    description:
      "Returns the localized text of a version for each language (description, keywords, promotional text, what's new, support URL, and marketing URL) and the localized text of App Information for each language (name, subtitle, and privacy policy URL). App Information is not tied to a version. It can have a live copy and a copy that is being edited for the next version, so each copy is returned with its state. If the app has many languages and the output is large, use locales to narrow it.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to read (for example, 1.0.1). If omitted, reads the newest version: the next version if one exists, otherwise the live version',
        ),
      locales: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('Locales to read (for example, ["ja", "en-US"]). If omitted, reads all locales'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getLocalizations(await getClient(), request)),
);

server.registerTool(
  'ensure_version',
  {
    title: 'Prepare version',
    description:
      'Prepares the next version. Creates the version if no version has that number. If the editable version (prepare for submission or rejected) has a different number, changes its number. Sets the release type and the phased release only when you pass them. Does not change a version that is in App Review, and does not reuse a number that was already released. Returns the version before and after the change, and any warnings.',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .describe(
          'Version number (for example, 1.0.2). Must match the version (CFBundleShortVersionString) of the build that you upload',
        ),
      releaseType: z
        .enum(RELEASE_TYPES)
        .optional()
        .describe(
          'Release type. MANUAL releases manually after App Review, AFTER_APPROVAL releases as soon as the version passes App Review, and SCHEDULED releases at earliestReleaseDate. If omitted, the release type does not change',
        ),
      earliestReleaseDate: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          'Release date and time for SCHEDULED. Must be on the hour and in the future (for example, 2026-12-01T10:00:00+09:00)',
        ),
      phasedRelease: z
        .boolean()
        .optional()
        .describe(
          'Whether to use a phased release, which releases the update gradually over 7 days to users with automatic updates turned on. If omitted, the setting does not change',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await ensureVersion(await getClient(), request)),
);

server.registerTool(
  'select_build',
  {
    title: 'Select build',
    description:
      'Selects the build to submit for App Review for a version. You can select only a build that finished processing (VALID), has not expired, and has a version (CFBundleShortVersionString) that matches the version number. The version must be editable (prepare for submission or rejected). Returns the build before and after the selection, and any warnings.',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to select the build for (for example, 1.0.2). If omitted, uses the editable version',
        ),
      buildNumber: z.string().min(1).describe('Build number (CFBundleVersion; for example, 12)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await selectBuild(await getClient(), request)),
);

server.registerTool(
  'set_localizations',
  {
    title: 'Set localized text',
    description:
      "Writes localized App Store text for each language to the editable version (prepare for submission or rejected). Changes only the fields you pass, among the version text (description, keywords, promotional text, what's new, and URLs) and the App Information text (name, subtitle, and privacy policy URL). Checks the character limits and URL formats before it writes, and changes nothing if any value fails. Skips what's new for the first version of an app. Does not add languages. Returns each changed field before and after the change, and any warnings.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to write the text to (for example, 1.0.2). If omitted, uses the editable version',
        ),
      localizations: z
        .array(localizationInput)
        .min(1)
        .describe('Localized text for each locale. Fields that you omit do not change'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setLocalizations(await getClient(), request)),
);

server.registerTool(
  'replace_screenshots',
  {
    title: 'Replace screenshots',
    description:
      'Replaces the screenshots for one locale and one display type (displayType) of the editable iOS version (prepare for submission or rejected) with the files you pass, in the order you pass them. Before it uploads, checks that every file is PNG or JPEG and that each image size fits the display type, and changes nothing if any file fails. Does not upload an identical screenshot (same MD5) again. First uploads the missing screenshots, as many as the display type has room for, confirms that Apple accepted them, and then deletes the screenshots that are no longer needed. Waits up to 2 minutes for Apple to process each call. If processing does not finish, stops and reports it in warnings; call the tool again to continue. Returns the screenshots before and after the replacement, and the names of the uploaded and deleted screenshots.',
    inputSchema: z.object({
      bundleId: appArguments.bundleId,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version whose screenshots to replace (for example, 1.1.0). If omitted, uses the editable version',
        ),
      locale: z.string().min(1).describe('Locale whose screenshots to replace (for example, ja)'),
      displayType: z.enum(DISPLAY_TYPE_NAMES).describe(
        `Display type to replace. The categories from Apple's Screenshot specifications and the image sizes that each accepts: ${Object.entries(
          DISPLAY_TYPES,
        )
          .map(([name, { label, sizes }]) => `${name} (${label}): ${sizes.join(', ')}`)
          .join('; ')}`,
      ),
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_SCREENSHOTS)
        .describe(
          'Absolute paths of the screenshot files (PNG or JPEG) for the display type, in the order to display them',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await replaceScreenshots(await getClient(), request)),
);

server.registerTool(
  'set_review_detail',
  {
    title: 'Set App Review information',
    description:
      'Sets the review notes and whether the app requires sign-in in the App Review Information of the editable version (prepare for submission or rejected). Changes only the fields you pass. Does not set the contact or the demo account, and reports a missing one in warnings. Never reads or writes the demo account password. Returns the values before and after the change.',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to set the App Review information for (for example, 1.0.2). If omitted, uses the editable version',
        ),
      notes: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Review notes. Apple documents a limit of 4000 bytes. Pass null or an empty string to clear them. If omitted, they do not change',
        ),
      demoAccountRequired: z
        .boolean()
        .optional()
        .describe(
          'Whether the app requires sign-in. If it does, enter the demo account in App Store Connect. If omitted, the setting does not change',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setReviewDetail(await getClient(), request)),
);

server.registerTool(
  'copy_review_contact',
  {
    title: 'Copy App Review contact',
    description:
      'Copies the App Review contact (first name, last name, phone number, and email) from a version of another app to the editable version (prepare for submission or rejected). Uses the newest version of the other app that has a complete contact. Copies only the fields that differ, and creates the App Review information if the version has none. Never includes the contact details in the result or in error messages. Returns the names of the copied fields and of any missing fields.',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to copy the contact to (for example, 1.0.0). If omitted, uses the editable version',
        ),
      fromBundleId: z
        .string()
        .min(1)
        .describe('Bundle ID of the app to copy the contact from (for example, com.example.myapp)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await copyReviewContact(await getClient(), request)),
);

const categoryId = (description: string) => z.string().min(1).optional().describe(description);

server.registerTool(
  'set_app_info',
  {
    title: 'Set App Information',
    description:
      'Sets the categories, the content rights declaration, and the age rating answers in App Information. Writes the categories and the age rating to the editable App Information (prepare for submission or rejected). Changes only the fields you pass that differ from the current values. After it writes, returns the age rating that the App Store assigns (appStoreAgeRating). If you pass nothing, returns the current values. Returns the values before and after the change, and any warnings, including the age rating questions that are not answered.',
    inputSchema: z.object({
      ...appArguments,
      primaryCategory: categoryId('Primary category ID (for example, GAMES or EDUCATION)'),
      primarySubcategoryOne: categoryId(
        'Subcategory ID of the primary category (for example, GAMES_TRIVIA). Only for categories that have subcategories, such as Games',
      ),
      primarySubcategoryTwo: categoryId('Second subcategory ID of the primary category'),
      secondaryCategory: categoryId('Secondary category ID'),
      secondarySubcategoryOne: categoryId('Subcategory ID of the secondary category'),
      secondarySubcategoryTwo: categoryId('Second subcategory ID of the secondary category'),
      contentRightsDeclaration: z
        .enum(CONTENT_RIGHTS)
        .optional()
        .describe(
          'Whether the app uses content made by others, such as text, images, or audio. USES_THIRD_PARTY_CONTENT declares that you have the rights to use it',
        ),
      ageRating: ageRatingInput
        .optional()
        .describe(
          'Age rating answers. Some fields are booleans, and others are frequencies (NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE, INFREQUENT, or FREQUENT). Changes only the fields you pass',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setAppInfo(await getClient(), request)),
);

const territoryId = z
  .string()
  .regex(/^[A-Z]{3}$/, 'A territory ID is 3 letters, such as JPN or USA');

server.registerTool(
  'set_price',
  {
    title: 'Set price',
    description:
      "Sets the app price. The only supported price is free. Creates a price schedule with the free price point of the base territory. If the app is already free, returns without changes. For a released app, the change reaches users immediately, without App Review. Each call requires the user's confirmation. Returns the price before and after the change.",
    inputSchema: z.object({
      bundleId: appArguments.bundleId,
      price: z.literal('FREE').describe('Price. The only supported value is FREE'),
      baseTerritory: territoryId
        .default('JPN')
        .describe('ID of the base territory (for example, JPN or USA)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async ({ bundleId, baseTerritory }) =>
    json(await setFreePrice(await getClient(), { bundleId, baseTerritory })),
);

server.registerTool(
  'set_availability',
  {
    title: 'Set territories',
    description:
      "Sets the territories where the app is available. Pass either a list of territory IDs (territories) or the bundle ID of an app whose territories to match (sameAsApp), not both. Makes the app available only in those territories and removes it from all others. Creates the availability settings if they do not exist; otherwise changes each territory. For a released app, the change reaches users immediately, without App Review. Does not change availability on Mac or Apple Vision Pro, because the API does not support it. Each call requires the user's confirmation. Returns the territories before and after the change.",
    inputSchema: z.object({
      bundleId: appArguments.bundleId,
      territories: z
        .array(territoryId)
        .min(1)
        .optional()
        .describe('IDs of the territories (for example, ["JPN", "USA"])'),
      sameAsApp: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Bundle ID of the app whose territories to match (for example, com.example.myapp)',
        ),
      availableInNewTerritories: z
        .boolean()
        .optional()
        .describe(
          'Whether to make the app available automatically in new territories that the App Store adds. You can set this only when the availability settings are first created. If omitted, matches the sameAsApp app (false when you pass territories)',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await setAvailability(await getClient(), request)),
);

server.registerTool(
  'submit_for_review',
  {
    title: 'Submit for App Review',
    description:
      "Submits a version for App Review. First checks that a build is selected, that the build version matches the version number, that the build finished processing, and that the export compliance answers exist. Reuses an unfinished submission if one exists. If the version is already submitted, returns without changes. Each call requires the user's confirmation. Returns the state before and after the submission. If App Store Connect refuses the submission and some age rating questions are not answered, the error lists them.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to submit (for example, 1.0.2). If omitted, submits the editable version',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await submitForReview(await getClient(), request)),
);

server.registerTool(
  'cancel_review',
  {
    title: 'Withdraw from App Review',
    description:
      "Withdraws a version that is waiting for App Review or in App Review. The withdrawn version becomes editable. If the version is not submitted, returns without changes. Each call requires the user's confirmation. Returns the state before and after the withdrawal.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to withdraw (for example, 1.0.2). If omitted, withdraws the submitted version',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await cancelReview(await getClient(), request)),
);

server.registerTool(
  'release_version',
  {
    title: 'Release version',
    description:
      "Releases a version that passed App Review and is waiting for manual release (PENDING_DEVELOPER_RELEASE) to the App Store. You cannot undo a release. If the version is already released, returns without changes. If the version has a phased release, releasing it starts the phased release. Each call requires the user's confirmation. Returns the version before and after the release.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version to release (for example, 1.0.2). If omitted, releases the version that is waiting for release',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await releaseVersion(await getClient(), request)),
);

server.registerTool(
  'set_phased_release',
  {
    title: 'Change phased release',
    description:
      "Pauses (pause), resumes (resume), or completes (complete) an active phased release. Completing releases the update to all users, and you cannot undo it. If the phased release is already in that state, returns without changes. Does not change a phased release that has not started or has already finished. Each call requires the user's confirmation. Returns the version before and after the change.",
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Version whose phased release to change (for example, 1.0.2). If omitted, uses the version with an active phased release',
        ),
      action: z
        .enum(PHASED_RELEASE_ACTIONS)
        .describe(
          'pause pauses the phased release, resume resumes it, and complete releases the update immediately to all remaining users',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await setPhasedRelease(await getClient(), request)),
);

await server.connect(new StdioServerTransport());
