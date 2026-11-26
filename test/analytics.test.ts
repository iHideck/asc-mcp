import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ensureAnalyticsReports, getAnalyticsReport } from '../plugin/src/analytics.ts';
import { createClient } from '../plugin/src/client.ts';
import { created, fakeFetch, page, requestedUrls, resource, sentWrites } from './fake-api.ts';
import { app, APP_ID, BUNDLE_ID } from './subscription-fixtures.ts';

const REQUESTS = `/v1/apps/${APP_ID}/analyticsReportRequests`;
const REPORTS = '/v1/analyticsReportRequests/r1/reports';
const INSTANCES = '/v1/analyticsReports/rep1/instances';
const STORAGE = 'https://reports.example.com';
const ENGAGEMENT = 'App Store Discovery and Engagement Standard';
const HEADER = ['Date', 'App Apple Identifier', 'Event', 'Territory', 'Counts', 'Unique Counts'];

function reportRequest(id = 'r1', stoppedDueToInactivity = false) {
  return resource('analyticsReportRequests', id, { accessType: 'ONGOING', stoppedDueToInactivity });
}

function report(id: string, name: string, category = 'APP_STORE_ENGAGEMENT') {
  return resource('analyticsReports', id, { name, category });
}

function instance(id: string, processingDate: string) {
  return resource('analyticsReportInstances', id, { granularity: 'DAILY', processingDate });
}

function segment(id: string) {
  return resource('analyticsReportSegments', id, { url: `${STORAGE}/${id}.txt.gz` });
}

function file(rows: (string | number)[][]): Response {
  const text = [HEADER, ...rows].map((row) => row.join('\t')).join('\n');
  return new Response(gzipSync(text));
}

const REQUEST = {
  bundleId: BUNDLE_ID,
  reportName: ENGAGEMENT,
  granularity: 'DAILY' as const,
  startDate: '2026-11-19',
  endDate: '2026-11-20',
};

function readyRoutes() {
  return {
    '/v1/apps': app(),
    [REQUESTS]: page([reportRequest('r0', true), reportRequest()]),
    [REPORTS]: page([
      report('rep2', 'App Store Downloads Standard', 'COMMERCE'),
      report('rep1', ENGAGEMENT),
    ]),
    [INSTANCES]: page([
      instance('i0', '2026-11-18'),
      instance('i1', '2026-11-20'),
      instance('i2', '2026-11-21'),
    ]),
    '/v1/analyticsReportInstances/i1/segments': page([segment('s1')]),
    '/v1/analyticsReportInstances/i2/segments': page([segment('s2'), segment('s3')]),
    [`${STORAGE}/s1.txt.gz`]: file([
      // 新しい instance（i2）にも 11-19 があるので、使わない
      ['2026-11-19', APP_ID, 'Impression', 'JP', 999, 999],
    ]),
    [`${STORAGE}/s2.txt.gz`]: file([
      ['2026-11-19', APP_ID, 'Impression', 'JP', 100, 80],
      ['2026-11-19', APP_ID, 'Page view', 'JP', 10, 9],
      ['2026-11-20', APP_ID, 'Impression', 'US', 30, 25],
    ]),
    [`${STORAGE}/s3.txt.gz`]: file([
      ['2026-11-20', APP_ID, 'impression', 'JP', 50, 40],
      ['2026-11-21', APP_ID, 'Impression', 'JP', 7, 7],
    ]),
  };
}

describe('ensureAnalyticsReports', () => {
  it('リクエストが無ければ ONGOING で作り、読めるレポートの名前を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [REQUESTS]: page([reportRequest('r0', true)]),
      'POST /v1/analyticsReportRequests': created('analyticsReportRequests', 'r1'),
      [REPORTS]: page([]),
    });

    const result = await ensureAnalyticsReports(
      createClient(() => 'TOKEN', fetchFn),
      BUNDLE_ID,
    );

    expect(result).toMatchObject({ created: true, requestId: 'r1', reports: [] });
    expect(result.message).toContain('1 to 2 days');
    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/analyticsReportRequests',
        body: {
          data: {
            type: 'analyticsReportRequests',
            attributes: { accessType: 'ONGOING' },
            relationships: { app: { data: { type: 'apps', id: APP_ID } } },
          },
        },
      },
    ]);
  });

  it('止まっていないリクエストがあれば、作らずにレポートの名前を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [REQUESTS]: page([reportRequest()]),
      [REPORTS]: page([report('rep1', ENGAGEMENT)]),
    });

    const result = await ensureAnalyticsReports(
      createClient(() => 'TOKEN', fetchFn),
      BUNDLE_ID,
    );

    expect(result).toMatchObject({
      created: false,
      reports: [{ name: ENGAGEMENT, category: 'APP_STORE_ENGAGEMENT' }],
    });
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('読み取りだけのモードでは、作るリクエストを送らずに返す', async () => {
    const fetchFn = fakeFetch({ '/v1/apps': app(), [REQUESTS]: page([]) });

    const result = ensureAnalyticsReports(
      createClient(() => 'TOKEN', fetchFn, true),
      BUNDLE_ID,
    );

    await expect(result).rejects.toThrow('read-only mode: POST /v1/analyticsReportRequests');
  });
});

describe('getAnalyticsReport', () => {
  it('期間の行を、日ごとに新しい instance だけから集め、絞ってまとめる', async () => {
    const fetchFn = fakeFetch(readyRoutes());

    const result = await getAnalyticsReport(
      createClient(() => 'TOKEN', fetchFn),
      {
        ...REQUEST,
        filters: { Event: ['Impression'] },
        groupBy: ['Territory'],
      },
    );

    expect(result).toMatchObject({
      status: 'READY',
      report: { name: ENGAGEMENT, category: 'APP_STORE_ENGAGEMENT', granularity: 'DAILY' },
      dataDates: { first: '2026-11-19', last: '2026-11-20' },
      metrics: ['Counts', 'Unique Counts'],
      totals: { Counts: 180, 'Unique Counts': 145 },
      rows: [
        { Territory: 'JP', Counts: 150, 'Unique Counts': 120 },
        { Territory: 'US', Counts: 30, 'Unique Counts': 25 },
      ],
      omittedRows: 0,
    });
    // startDate より前に処理された instance は、落とさない
    expect(requestedUrls(fetchFn).map(({ pathname }) => pathname)).not.toContain(
      '/v1/analyticsReportInstances/i0/segments',
    );
  });

  it('区切りのファイルは、API のトークンを付けずに落とす', async () => {
    const fetchFn = fakeFetch(readyRoutes());

    await getAnalyticsReport(
      createClient(() => 'TOKEN', fetchFn),
      REQUEST,
    );

    const downloads = fetchFn.mock.calls.filter(([input]) => String(input).startsWith(STORAGE));
    expect(downloads).toHaveLength(3);
    for (const [, init] of downloads) {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    }
  });

  it('リクエストが無ければ NOT_REQUESTED、止まったものだけなら STOPPED を返す', async () => {
    const none = await getAnalyticsReport(
      createClient(() => 'TOKEN', fakeFetch({ '/v1/apps': app(), [REQUESTS]: page([]) })),
      REQUEST,
    );
    const stopped = await getAnalyticsReport(
      createClient(
        () => 'TOKEN',
        fakeFetch({ '/v1/apps': app(), [REQUESTS]: page([reportRequest('r0', true)]) }),
      ),
      REQUEST,
    );

    expect(none.status).toBe('NOT_REQUESTED');
    expect(stopped.status).toBe('STOPPED');
  });

  it('レポートか instance がまだ無ければ、PROCESSING を返す', async () => {
    const noReports = await getAnalyticsReport(
      createClient(
        () => 'TOKEN',
        fakeFetch({ '/v1/apps': app(), [REQUESTS]: page([reportRequest()]), [REPORTS]: page([]) }),
      ),
      REQUEST,
    );
    const noInstances = await getAnalyticsReport(
      createClient(() => 'TOKEN', fakeFetch({ ...readyRoutes(), [INSTANCES]: page([]) })),
      REQUEST,
    );

    expect(noReports).toMatchObject({
      status: 'PROCESSING',
      message: expect.stringContaining('1 to 2 days'),
    });
    expect(noInstances).toMatchObject({ status: 'PROCESSING' });
  });

  it('期間のあとに処理された instance が無ければ、NO_DATA と最後の処理の日を返す', async () => {
    const result = await getAnalyticsReport(
      createClient(
        () => 'TOKEN',
        fakeFetch({ ...readyRoutes(), [INSTANCES]: page([instance('i0', '2026-11-18')]) }),
      ),
      { ...REQUEST, startDate: '2026-11-19' },
    );

    expect(result).toMatchObject({ status: 'NO_DATA', latestProcessingDate: '2026-11-18' });
  });

  it('レポートの名前が無ければ、読める名前を挙げて止める', async () => {
    const result = getAnalyticsReport(
      createClient(() => 'TOKEN', fakeFetch(readyRoutes())),
      {
        ...REQUEST,
        reportName: 'App Retention',
      },
    );

    await expect(result).rejects.toThrow(
      `Available reports: ${ENGAGEMENT}, App Store Downloads Standard.`,
    );
  });

  it('無い列を指すと、レポートの列を挙げて止める', async () => {
    const result = getAnalyticsReport(
      createClient(() => 'TOKEN', fakeFetch(readyRoutes())),
      {
        ...REQUEST,
        groupBy: ['Country'],
      },
    );

    await expect(result).rejects.toThrow(`Its columns are: ${HEADER.join(', ')}.`);
  });

  it('どの行にも当たらない値で絞ると、レポートにある値を warnings に挙げる', async () => {
    const result = await getAnalyticsReport(
      createClient(() => 'TOKEN', fakeFetch(readyRoutes())),
      {
        ...REQUEST,
        filters: { Event: ['Impressions', 'page VIEW'] },
      },
    );

    expect(result).toMatchObject({
      status: 'READY',
      totals: { Counts: 10 },
      warnings: [
        'No row has Event = "Impressions". Values in the report: Impression, Page view, impression.',
      ],
    });
  });

  it('startDate が endDate より後なら、何も読まずに止める', async () => {
    const fetchFn = fakeFetch({});

    const result = getAnalyticsReport(
      createClient(() => 'TOKEN', fetchFn),
      {
        ...REQUEST,
        startDate: '2026-11-21',
      },
    );

    await expect(result).rejects.toThrow('must be on or before endDate');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
