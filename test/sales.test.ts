import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { getSalesReport } from '../plugin/src/sales.ts';
import { fakeFetch, jsonResponse, requestedUrls } from './fake-api.ts';
import { app, APP_ID, BUNDLE_ID } from './subscription-fixtures.ts';

const HEADER = [
  'Provider',
  'SKU',
  'Title',
  'Version',
  'Product Type Identifier',
  'Units',
  'Developer Proceeds',
  'Begin Date',
  'Country Code',
  'Apple Identifier',
  'Customer Price',
];

function salesFile(rows: (string | number)[][]): Response {
  const text = `${[HEADER, ...rows].map((row) => row.join('\t')).join('\n')}\n`;
  return new Response(gzipSync(text), { headers: { 'Content-Type': 'application/a-gzip' } });
}

const REQUEST = {
  vendorNumber: '85012345',
  reportType: 'SALES' as const,
  reportSubType: 'SUMMARY' as const,
  frequency: 'DAILY' as const,
  reportDate: '2026-11-24',
};

describe('getSalesReport', () => {
  it('アプリの行だけを、列ごとにまとめて Units を足す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      '/v1/salesReports': salesFile([
        ['APPLE', 'snore', 'SnoreTalk', '1.0', '1', 3, '0', '11/24/2026', 'JP', APP_ID, '0'],
        ['APPLE', 'snore', 'SnoreTalk', '1.0', '1', 2, '0', '11/24/2026', 'US', APP_ID, '0'],
        ['APPLE', 'snore', 'SnoreTalk', '1.0', '7', 5, '0', '11/24/2026', 'JP', APP_ID, '0'],
        ['APPLE', 'other', 'Other', '2.0', '1', 9, '0', '11/24/2026', 'JP', '123', '0'],
      ]),
    });

    const result = await getSalesReport(
      createClient(() => 'TOKEN', fetchFn),
      {
        ...REQUEST,
        bundleId: BUNDLE_ID,
        filters: { 'Product Type Identifier': ['1'] },
        groupBy: ['Country Code'],
      },
    );

    expect(result).toMatchObject({
      status: 'READY',
      metrics: ['Units'],
      totals: { Units: 5 },
      rows: [
        { 'Country Code': 'JP', Units: 3 },
        { 'Country Code': 'US', Units: 2 },
      ],
    });
    const sales = requestedUrls(fetchFn).find(({ pathname }) => pathname === '/v1/salesReports');
    expect(Object.fromEntries(sales?.searchParams ?? [])).toEqual({
      'filter[vendorNumber]': '85012345',
      'filter[reportType]': 'SALES',
      'filter[reportSubType]': 'SUMMARY',
      'filter[frequency]': 'DAILY',
      'filter[reportDate]': '2026-11-24',
    });
    const headers = new Headers(fetchFn.mock.calls.at(-1)?.[1]?.headers);
    expect(headers.get('Accept')).toBe('application/a-gzip');
  });

  it('Apple が 404 を返す日は、NO_DATA を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/salesReports': jsonResponse(404, {
        errors: [
          {
            status: '404',
            code: 'NOT_FOUND',
            detail: 'There were no sales for the date specified.',
          },
        ],
      }),
    });

    const result = await getSalesReport(
      createClient(() => 'TOKEN', fetchFn),
      REQUEST,
    );

    expect(result).toMatchObject({ status: 'NO_DATA', app: null });
  });

  it('頻度に合わない日付は、送らずに止める', async () => {
    const fetchFn = fakeFetch({});

    const result = getSalesReport(
      createClient(() => 'TOKEN', fetchFn),
      {
        ...REQUEST,
        frequency: 'MONTHLY',
      },
    );

    await expect(result).rejects.toThrow('write reportDate like 2026-10');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
