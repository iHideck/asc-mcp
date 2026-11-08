import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { findIncluded, nullIfMissing, sparseFields, toOne, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';

const PriceSchedule = z.object({
  type: z.literal('appPriceSchedules'),
  id: z.string(),
  relationships: z.object({ baseTerritory: toOne }),
});

const ManualPrice = z.object({
  type: z.literal('appPrices'),
  id: z.string(),
  attributes: z.object({ startDate: z.string().nullable(), endDate: z.string().nullable() }),
  relationships: z.object({ appPricePoint: toOne }),
});

const PricePoint = z.object({
  type: z.literal('appPricePoints'),
  id: z.string(),
  attributes: z.object({ customerPrice: z.string().nullable() }),
});

export type SetPriceRequest = { bundleId: string; baseTerritory: string };

export type PriceState = { baseTerritory: string | null; customerPrice: string | null };

export type SetPriceResult = {
  app: AppSummary;
  before: PriceState | null;
  after: PriceState | null;
};

export async function setFreePrice(
  client: AscClient,
  request: SetPriceRequest,
  now: () => Date = () => new Date(),
): Promise<SetPriceResult> {
  const app = await findApp(client, request.bundleId);
  const read = () => readPrice(client, app.appleId, now());
  const before = await read();
  if (before?.baseTerritory === request.baseTerritory && isFree(before.customerPrice)) {
    return { app, before, after: before };
  }
  const { data } = await client.getAll(
    `/v1/apps/${app.appleId}/appPricePoints`,
    {
      ...sparseFields(PricePoint),
      'filter[territory]': request.baseTerritory,
      limit: '200',
    },
    { data: PricePoint },
  );
  const free = data.find(({ attributes }) => isFree(attributes.customerPrice));
  if (free === undefined) {
    throw new Error(
      `${request.baseTerritory} に、無料の価格の点がありません。国の ID（例: JPN）を確かめてください。`,
    );
  }
  const progress = trackProgress();
  await progress.write('価格を無料にする', '価格を無料にしました', () =>
    client.create(
      'appPriceSchedules',
      {},
      {
        app: { type: 'apps', id: app.appleId },
        baseTerritory: { type: 'territories', id: request.baseTerritory },
        manualPrices: [{ type: 'appPrices', id: '${price}' }],
      },
      [
        {
          type: 'appPrices',
          id: '${price}',
          attributes: { startDate: null },
          relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } },
        },
      ],
    ),
  );
  return { app, before, after: await progress.read('入れた価格を読み直す', read) };
}

async function readPrice(
  client: AscClient,
  appleId: string,
  today: Date,
): Promise<PriceState | null> {
  const schedule = await nullIfMissing(
    client.getOne(
      `/v1/apps/${appleId}/appPriceSchedule`,
      { 'fields[appPriceSchedules]': 'baseTerritory', include: 'baseTerritory' },
      PriceSchedule,
    ),
  );
  if (schedule === null) {
    return null;
  }
  const baseTerritory = schedule.relationships.baseTerritory?.data?.id ?? null;
  if (baseTerritory === null) {
    return { baseTerritory, customerPrice: null };
  }
  const { data, included } = await client.getAll(
    `/v1/appPriceSchedules/${schedule.id}/manualPrices`,
    { ...sparseFields(ManualPrice, PricePoint), 'filter[territory]': baseTerritory, limit: '200' },
    { data: ManualPrice, included: PricePoint },
  );
  const date = today.toISOString().slice(0, 10);
  const current = data.find(
    ({ attributes }) =>
      (attributes.startDate === null || attributes.startDate <= date) &&
      (attributes.endDate === null || attributes.endDate > date),
  );
  return {
    baseTerritory,
    customerPrice:
      findIncluded(included, 'appPricePoints', current?.relationships.appPricePoint?.data)
        ?.attributes.customerPrice ?? null,
  };
}

function isFree(price: string | null | undefined): boolean {
  return price !== null && price !== undefined && Number(price) === 0;
}
