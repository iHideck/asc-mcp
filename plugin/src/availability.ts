import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { nullIfMissing, sparseFields, toOne, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';

const AppAvailability = z.object({
  type: z.literal('appAvailabilities'),
  id: z.string(),
  attributes: z.object({ availableInNewTerritories: z.boolean().nullable() }),
});

const TerritoryAvailability = z.object({
  type: z.literal('territoryAvailabilities'),
  id: z.string(),
  attributes: z.object({ available: z.boolean().nullable() }),
  relationships: z.object({ territory: toOne }),
});

const Territory = z.object({
  type: z.literal('territories'),
  id: z.string(),
  attributes: z.object({ currency: z.string().nullable() }),
});

export type SetAvailabilityRequest = {
  bundleId: string;
  territories?: string[] | undefined;
  sameAsApp?: string | undefined;
  availableInNewTerritories?: boolean | undefined;
};

export type AvailabilityState = {
  availableInNewTerritories: boolean | null;
  territories: string[];
};

export type SetAvailabilityResult = {
  app: AppSummary;
  before: AvailabilityState | null;
  after: AvailabilityState | null;
  warnings: string[];
};

type Availability = {
  id: string;
  state: AvailabilityState;
  territoryAvailabilities: Map<string, { id: string; available: boolean }>;
};

export async function setAvailability(
  client: AscClient,
  request: SetAvailabilityRequest,
): Promise<SetAvailabilityResult> {
  if ((request.territories === undefined) === (request.sameAsApp === undefined)) {
    throw new Error(
      'territories（国の ID の一覧）か sameAsApp（同じ国にするアプリ）の、どちらか一方を渡してください。',
    );
  }
  const app = await findApp(client, request.bundleId);
  const wanted = await wantedTerritories(client, request);
  const allTerritories = await listTerritories(client);
  const unknown = [...wanted.territories].filter((id) => !allTerritories.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `国の ID ${unknown.join('、')} はありません。国の ID は、JPN・USA のような 3 文字です。何も変えていません。`,
    );
  }
  const read = () => readAvailability(client, app.appleId);
  const before = await read();
  const warnings: string[] = [];
  const newTerritories = request.availableInNewTerritories ?? wanted.availableInNewTerritories;
  const progress = trackProgress();
  let wrote = false;

  if (before === null) {
    wrote = true;
    await progress.write(
      `${wanted.territories.size} の国で配信する`,
      `${wanted.territories.size} の国で配信するようにしました`,
      () =>
        client.create(
          'appAvailabilities',
          { availableInNewTerritories: newTerritories ?? false },
          {
            app: { type: 'apps', id: app.appleId },
            territoryAvailabilities: allTerritories.map((id) => ({
              type: 'territoryAvailabilities',
              id: `\${${id}}`,
            })),
          },
          allTerritories.map((id) => ({
            type: 'territoryAvailabilities',
            id: `\${${id}}`,
            attributes: { available: wanted.territories.has(id) },
            relationships: { territory: { data: { type: 'territories', id } } },
          })),
        ),
    );
  } else {
    if (
      newTerritories !== undefined &&
      newTerritories !== null &&
      newTerritories !== before.state.availableInNewTerritories
    ) {
      if (request.availableInNewTerritories !== undefined) {
        throw new Error(
          '新しい国でも自動で配信するか（availableInNewTerritories）は、一度入れると API では変えられません。App Store Connect の「価格および配信状況」で変えてください。何も変えていません。',
        );
      }
      warnings.push(
        `新しい国でも自動で配信するかが、${request.sameAsApp ?? ''} と違います（${String(before.state.availableInNewTerritories)}）。変えるなら、App Store Connect の「価格および配信状況」で変えてください。`,
      );
    }
    const missing = [...wanted.territories].filter((id) => !before.territoryAvailabilities.has(id));
    if (missing.length > 0) {
      warnings.push(
        `次の国は、このアプリの配信の一覧に無いので、変えていません: ${missing.join('、')}`,
      );
    }
    for (const [territory, { id, available }] of before.territoryAvailabilities) {
      const shouldBe = wanted.territories.has(territory);
      if (available !== shouldBe) {
        wrote = true;
        await progress.write(
          `${territory} の配信を${shouldBe ? '始める' : 'やめる'}`,
          `${territory} の配信を${shouldBe ? '始め' : 'やめ'}ました`,
          () => client.update('territoryAvailabilities', id, { available: shouldBe }),
        );
      }
    }
  }
  const after = wrote ? await progress.read('配信する国を読み直す', read) : before;
  return { app, before: before?.state ?? null, after: after?.state ?? null, warnings };
}

async function wantedTerritories(
  client: AscClient,
  request: SetAvailabilityRequest,
): Promise<{ territories: Set<string>; availableInNewTerritories: boolean | null | undefined }> {
  if (request.territories !== undefined) {
    return { territories: new Set(request.territories), availableInNewTerritories: undefined };
  }
  const source = await findApp(client, request.sameAsApp ?? '');
  const availability = await readAvailability(client, source.appleId);
  if (availability === null) {
    throw new Error(`${source.bundleId} には、配信する国がまだありません。何も変えていません。`);
  }
  return {
    territories: new Set(availability.state.territories),
    availableInNewTerritories: availability.state.availableInNewTerritories,
  };
}

async function listTerritories(client: AscClient): Promise<string[]> {
  const { data } = await client.getAll(
    '/v1/territories',
    { ...sparseFields(Territory), limit: '200' },
    { data: Territory },
  );
  return data.map(({ id }) => id);
}

async function readAvailability(client: AscClient, appleId: string): Promise<Availability | null> {
  const availability = await nullIfMissing(
    client.getOne(
      `/v1/apps/${appleId}/appAvailabilityV2`,
      sparseFields(AppAvailability),
      AppAvailability,
    ),
  );
  if (availability === null) {
    return null;
  }
  const { data } = await client.getAll(
    `/v2/appAvailabilities/${availability.id}/territoryAvailabilities`,
    { ...sparseFields(TerritoryAvailability), limit: '200' },
    { data: TerritoryAvailability },
  );
  const territoryAvailabilities = new Map(
    data.flatMap(({ id, attributes, relationships }) => {
      const territory = relationships.territory?.data?.id;
      return territory === undefined
        ? []
        : [[territory, { id, available: attributes.available === true }] as const];
    }),
  );
  return {
    id: availability.id,
    state: {
      availableInNewTerritories: availability.attributes.availableInNewTerritories,
      territories: [...territoryAvailabilities]
        .filter(([, { available }]) => available)
        .map(([territory]) => territory)
        .sort(),
    },
    territoryAvailabilities,
  };
}
