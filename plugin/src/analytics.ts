import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { sparseFields, type AscClient } from './client.ts';
import {
  normalizeDate,
  parseTsv,
  summarize,
  type Aggregation,
  type Row,
  type Summary,
} from './tsv.ts';

export const GRANULARITIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
type Granularity = (typeof GRANULARITIES)[number];

const ReportRequest = z.object({
  type: z.literal('analyticsReportRequests'),
  id: z.string(),
  attributes: z.object({
    accessType: z.string().nullish(),
    stoppedDueToInactivity: z.boolean().nullish(),
  }),
});

const Report = z.object({
  type: z.literal('analyticsReports'),
  id: z.string(),
  attributes: z.object({ name: z.string(), category: z.string().nullish() }),
});

const Instance = z.object({
  type: z.literal('analyticsReportInstances'),
  id: z.string(),
  attributes: z.object({ granularity: z.string().nullish(), processingDate: z.string() }),
});

const Segment = z.object({
  type: z.literal('analyticsReportSegments'),
  id: z.string(),
  attributes: z.object({ url: z.string() }),
});

const FIRST_REPORT_WAIT =
  'Apple generates the first reports 1 to 2 days after the request is created, then adds new reports daily.';

export type ReportSummary = { name: string; category: string | null };

export type AnalyticsRequestStatus = {
  app: AppSummary;
  created: boolean;
  requestId: string;
  reports: ReportSummary[];
  message: string;
};

export async function ensureAnalyticsReports(
  client: AscClient,
  bundleId: string,
): Promise<AnalyticsRequestStatus> {
  const app = await findApp(client, bundleId);
  const existing = await activeRequest(client, app.appleId);
  // ONGOING のリクエストは、毎日の数を、作った日から先へ作り続ける
  const request =
    existing ??
    (await client.createResource(
      'analyticsReportRequests',
      { accessType: 'ONGOING' },
      { app: { type: 'apps', id: app.appleId } },
      ReportRequest,
    ));
  const reports = await listReports(client, request.id);
  return {
    app,
    created: existing === undefined,
    requestId: request.id,
    reports: reports.map(summaryOf),
    message:
      existing === undefined
        ? `Created the analytics report request. ${FIRST_REPORT_WAIT} Read a report with get_analytics_report.`
        : 'The analytics report request already exists. Read a report with get_analytics_report.',
  };
}

export type AnalyticsReportRequest = Aggregation & {
  bundleId: string;
  reportName: string;
  granularity: Granularity;
  startDate: string;
  endDate: string;
};

type NotReady = {
  app: AppSummary;
  status: 'NOT_REQUESTED' | 'STOPPED' | 'PROCESSING' | 'NO_DATA';
  message: string;
  reports?: ReportSummary[];
  latestProcessingDate?: string | null;
};

type Ready = {
  app: AppSummary;
  status: 'READY';
  report: ReportSummary & { granularity: Granularity };
  startDate: string;
  endDate: string;
  dataDates: { first: string; last: string } | null;
} & Summary;

export async function getAnalyticsReport(
  client: AscClient,
  request: AnalyticsReportRequest,
): Promise<NotReady | Ready> {
  if (request.startDate > request.endDate) {
    throw new Error(
      `startDate (${request.startDate}) must be on or before endDate (${request.endDate}).`,
    );
  }
  const app = await findApp(client, request.bundleId);
  const requests = await listRequests(client, app.appleId);
  const active = requests.find(({ attributes }) => attributes.stoppedDueToInactivity !== true);
  if (active === undefined) {
    return requests.length === 0
      ? {
          app,
          status: 'NOT_REQUESTED',
          message:
            'The app has no analytics report request. Create one with ensure_analytics_reports.',
        }
      : {
          app,
          status: 'STOPPED',
          message:
            'Apple stopped the analytics report request because no reports were downloaded for a long time. Create a new request with ensure_analytics_reports.',
        };
  }

  const reports = await listReports(client, active.id);
  const summaries = reports.map(summaryOf);
  if (reports.length === 0) {
    return { app, status: 'PROCESSING', message: FIRST_REPORT_WAIT };
  }
  const report = reports.find(
    ({ attributes }) => attributes.name.toLowerCase() === request.reportName.toLowerCase(),
  );
  if (report === undefined) {
    throw new Error(
      `The app has no analytics report named "${request.reportName}". Available reports: ${summaries.map(({ name }) => name).join(', ')}.`,
    );
  }

  const { data: instances } = await client.getAll(
    `/v1/analyticsReports/${report.id}/instances`,
    { ...sparseFields(Instance), 'filter[granularity]': request.granularity, limit: '200' },
    { data: Instance },
  );
  const latestProcessingDate =
    instances
      .map(({ attributes }) => attributes.processingDate)
      .sort()
      .at(-1) ?? null;
  if (latestProcessingDate === null) {
    return {
      app,
      status: 'PROCESSING',
      message: `The report has no ${request.granularity} data yet. ${FIRST_REPORT_WAIT}`,
      reports: summaries,
    };
  }
  // ある日の数は、その日か、それより後に処理された instance にある
  const candidates = instances.filter(
    ({ attributes }) => attributes.processingDate >= request.startDate,
  );
  if (candidates.length === 0) {
    return {
      app,
      status: 'NO_DATA',
      message: `No ${request.granularity} data was processed on or after ${request.startDate}. Apple keeps each report instance for 35 days.`,
      latestProcessingDate,
    };
  }

  const tagged = (
    await Promise.all(
      candidates.map(async ({ id, attributes }) =>
        (await readInstance(client, id)).map((row) => ({
          row,
          processingDate: attributes.processingDate,
        })),
      ),
    )
  ).flat();
  const columns = [...new Set(tagged.flatMap(({ row }) => Object.keys(row)))];
  if (tagged.length > 0 && !columns.includes('Date')) {
    throw new Error(`The report has no Date column. Its columns are: ${columns.join(', ')}.`);
  }
  // 同じ日の数が複数の instance にあるときは、処理の新しいものだけを使う（足すと二重になる）
  const latestByDate = new Map<string, string>();
  for (const { row, processingDate } of tagged) {
    const date = normalizeDate(row.Date ?? '');
    if (processingDate > (latestByDate.get(date) ?? '')) {
      latestByDate.set(date, processingDate);
    }
  }
  const rows = tagged
    .filter(({ row, processingDate }) => {
      const date = normalizeDate(row.Date ?? '');
      return (
        date >= request.startDate &&
        date <= request.endDate &&
        latestByDate.get(date) === processingDate
      );
    })
    .map(({ row }) => row);
  const dates = rows.map((row) => normalizeDate(row.Date ?? '')).sort();
  const [first, last] = [dates[0], dates.at(-1)];
  return {
    app,
    status: 'READY',
    report: { ...summaryOf(report), granularity: request.granularity },
    startDate: request.startDate,
    endDate: request.endDate,
    dataDates: first === undefined || last === undefined ? null : { first, last },
    ...summarize({ columns, rows }, request),
  };
}

function summaryOf({ attributes }: z.infer<typeof Report>): ReportSummary {
  return { name: attributes.name, category: attributes.category ?? null };
}

async function listRequests(client: AscClient, appleId: string) {
  const { data } = await client.getAll(
    `/v1/apps/${appleId}/analyticsReportRequests`,
    { ...sparseFields(ReportRequest), 'filter[accessType]': 'ONGOING', limit: '200' },
    { data: ReportRequest },
  );
  return data;
}

async function activeRequest(client: AscClient, appleId: string) {
  return (await listRequests(client, appleId)).find(
    ({ attributes }) => attributes.stoppedDueToInactivity !== true,
  );
}

async function listReports(client: AscClient, requestId: string) {
  const { data } = await client.getAll(
    `/v1/analyticsReportRequests/${requestId}/reports`,
    { ...sparseFields(Report), limit: '200' },
    { data: Report },
  );
  return data.sort((a, b) => a.attributes.name.localeCompare(b.attributes.name));
}

async function readInstance(client: AscClient, instanceId: string): Promise<Row[]> {
  const { data: segments } = await client.getAll(
    `/v1/analyticsReportInstances/${instanceId}/segments`,
    { ...sparseFields(Segment), limit: '200' },
    { data: Segment },
  );
  const tables = await Promise.all(
    segments.map(async ({ attributes }) => parseTsv(await client.download(attributes.url))),
  );
  return tables.flatMap(({ rows }) => rows);
}
