import { findApp, type AppSummary } from './apps.ts';
import { AscApiError, type AscClient } from './client.ts';
import { parseTsv, summarize, type Aggregation, type Summary } from './tsv.ts';

export const SALES_REPORT_TYPES = [
  'SALES',
  'PRE_ORDER',
  'NEWSSTAND',
  'SUBSCRIPTION',
  'SUBSCRIPTION_EVENT',
  'SUBSCRIBER',
  'SUBSCRIPTION_OFFER_CODE_REDEMPTION',
  'INSTALLS',
  'FIRST_ANNUAL',
  'WIN_BACK_ELIGIBILITY',
] as const;
export const SALES_REPORT_SUBTYPES = [
  'SUMMARY',
  'DETAILED',
  'SUMMARY_INSTALL_TYPE',
  'SUMMARY_TERRITORY',
  'SUMMARY_CHANNEL',
] as const;
export const SALES_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;

type Frequency = (typeof SALES_FREQUENCIES)[number];

const DATE_FORMATS: Record<Frequency, { pattern: RegExp; example: string }> = {
  DAILY: { pattern: /^\d{4}-\d{2}-\d{2}$/, example: '2026-11-24' },
  WEEKLY: { pattern: /^\d{4}-\d{2}-\d{2}$/, example: '2026-11-22' },
  MONTHLY: { pattern: /^\d{4}-\d{2}$/, example: '2026-10' },
  YEARLY: { pattern: /^\d{4}$/, example: '2025' },
};

// レポートの種類で、アプリの Apple ID を入れる列の名前が違う
const APP_ID_COLUMNS = ['Apple Identifier', 'App Apple ID'];

export type SalesReportRequest = Aggregation & {
  vendorNumber: string;
  reportType: (typeof SALES_REPORT_TYPES)[number];
  reportSubType: (typeof SALES_REPORT_SUBTYPES)[number];
  frequency: Frequency;
  reportDate: string;
  version?: string | undefined;
  bundleId?: string | undefined;
};

export type SalesReport =
  | { status: 'NO_DATA'; app: AppSummary | null; message: string }
  | ({ status: 'READY'; app: AppSummary | null } & Summary);

export async function getSalesReport(
  client: AscClient,
  request: SalesReportRequest,
): Promise<SalesReport> {
  const format = DATE_FORMATS[request.frequency];
  if (!format.pattern.test(request.reportDate)) {
    throw new Error(
      `For ${request.frequency} reports, write reportDate like ${format.example}. You passed ${request.reportDate}.`,
    );
  }
  const app = request.bundleId === undefined ? null : await findApp(client, request.bundleId);
  let text: string;
  try {
    text = await client.getReportFile('/v1/salesReports', {
      'filter[vendorNumber]': request.vendorNumber,
      'filter[reportType]': request.reportType,
      'filter[reportSubType]': request.reportSubType,
      'filter[frequency]': request.frequency,
      'filter[reportDate]': request.reportDate,
      ...(request.version === undefined ? {} : { 'filter[version]': request.version }),
    });
  } catch (error) {
    // Apple は、売上の無い日と、まだ作っていない日のレポートに 404 を返す
    if (error instanceof AscApiError && error.status === 404) {
      return {
        status: 'NO_DATA',
        app,
        message: `App Store Connect has no ${request.frequency} ${request.reportType} report for ${request.reportDate}. Either nothing was recorded, or the report is not ready yet. Daily reports are usually ready the next day.`,
      };
    }
    throw error;
  }
  const table = parseTsv(text);
  const filters = { ...request.filters };
  if (app !== null) {
    const column = APP_ID_COLUMNS.find((candidate) => table.columns.includes(candidate));
    if (column === undefined && table.columns.length > 0) {
      throw new Error(
        `Cannot filter this report by app because it has no column for the Apple ID of the app (${APP_ID_COLUMNS.join(' or ')}). Omit bundleId and use filters instead. Its columns are: ${table.columns.join(', ')}.`,
      );
    }
    if (column !== undefined) {
      filters[column] = [app.appleId];
    }
  }
  return { status: 'READY', app, ...summarize(table, { ...request, filters }) };
}
