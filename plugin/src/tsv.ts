export type Row = Record<string, string>;
export type Table = { columns: string[]; rows: Row[] };

export type Aggregation = {
  filters?: Record<string, string[]> | undefined;
  groupBy?: string[] | undefined;
  metrics?: string[] | undefined;
  limit?: number | undefined;
};

export type Summary = {
  columns: string[];
  metrics: string[];
  totals: Record<string, number>;
  rows: Record<string, string | number>[];
  omittedRows: number;
  warnings: string[];
};

const DEFAULT_LIMIT = 200;
const LISTED_VALUES = 30;
const NUMBER = /^-?\d+(\.\d+)?$/;
// 数の列でも、ID・日付・版・価格は足しても意味が無い。売上の Developer Proceeds は1つあたりの額
const NOT_SUMMABLE = /identifier|apple id|\bsku\b|date|version|price|proceeds|\bcode\b/i;

export function parseTsv(text: string): Table {
  const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (header === undefined) {
    return { columns: [], rows: [] };
  }
  const columns = header.split('\t').map((column) => column.trim());
  const rows = lines.map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]?.trim() ?? '']));
  });
  return { columns, rows };
}

// Analytics Reports は 2026-01-31、Sales and Trends は 01/31/2026 の形で日付を書く
export function normalizeDate(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (us === null) {
    return value;
  }
  const [, month = '', day = '', year = ''] = us;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function summarize(table: Table, aggregation: Aggregation): Summary {
  const filters = Object.entries(aggregation.filters ?? {});
  const groupBy = aggregation.groupBy ?? [];
  requireColumns(table, [...filters.map(([column]) => column), ...groupBy]);
  const metrics = aggregation.metrics ?? summableColumns(table, groupBy);
  requireColumns(table, metrics);

  // Apple は、レポートの値の大文字と小文字を区別しない
  const rows = table.rows.filter((row) =>
    filters.every(([column, values]) =>
      values.some((value) => value.toLowerCase() === row[column]?.toLowerCase()),
    ),
  );
  const groups = new Map<string, { keys: Row; sums: number[] }>();
  for (const row of rows) {
    const keys = Object.fromEntries(groupBy.map((column) => [column, row[column] ?? '']));
    const id = JSON.stringify(groupBy.map((column) => keys[column]));
    const group = groups.get(id) ?? { keys, sums: metrics.map(() => 0) };
    metrics.forEach((metric, index) => {
      group.sums[index] = (group.sums[index] ?? 0) + numberOf(row[metric]);
    });
    groups.set(id, group);
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      (b.sums[0] ?? 0) - (a.sums[0] ?? 0) ||
      JSON.stringify(Object.values(a.keys)).localeCompare(JSON.stringify(Object.values(b.keys))),
  );
  const limit = aggregation.limit ?? DEFAULT_LIMIT;
  return {
    columns: table.columns,
    metrics,
    totals: Object.fromEntries(
      metrics.map((metric) => [
        metric,
        round(rows.reduce((sum, row) => sum + numberOf(row[metric]), 0)),
      ]),
    ),
    rows: sorted.slice(0, limit).map(({ keys, sums }) => ({
      ...keys,
      ...Object.fromEntries(metrics.map((metric, index) => [metric, round(sums[index] ?? 0)])),
    })),
    omittedRows: Math.max(0, sorted.length - limit),
    warnings: unmatchedFilters(table, filters),
  };
}

// 値の打ち間違いは、行が無いのと見分けがつかない。レポートにある値を挙げる
function unmatchedFilters(table: Table, filters: [string, string[]][]): string[] {
  return filters.flatMap(([column, values]) => {
    const present = [...new Set(table.rows.map((row) => row[column] ?? ''))].sort();
    const lower = new Set(present.map((value) => value.toLowerCase()));
    const missing = values.filter((value) => !lower.has(value.toLowerCase()));
    if (missing.length === 0 || table.rows.length === 0) {
      return [];
    }
    const listed = present.slice(0, LISTED_VALUES).join(', ');
    const more =
      present.length > LISTED_VALUES ? `, and ${present.length - LISTED_VALUES} more` : '';
    return [
      `No row has ${column} = ${missing.map((value) => `"${value}"`).join(' or ')}. Values in the report: ${listed}${more}.`,
    ];
  });
}

function summableColumns(table: Table, groupBy: string[]): string[] {
  return table.columns.filter(
    (column) =>
      !groupBy.includes(column) &&
      !NOT_SUMMABLE.test(column) &&
      table.rows.some((row) => row[column] !== '') &&
      table.rows.every((row) => row[column] === '' || NUMBER.test(row[column] ?? '')),
  );
}

function requireColumns(table: Table, wanted: string[]): void {
  // 行の無いレポートは、列も分からないので、確かめない
  if (table.columns.length === 0) {
    return;
  }
  const unknown = wanted.filter((column) => !table.columns.includes(column));
  if (unknown.length > 0) {
    throw new Error(
      `The report has no column ${unknown.map((column) => `"${column}"`).join(', ')}. Its columns are: ${table.columns.join(', ')}.`,
    );
  }
}

function numberOf(value: string | undefined): number {
  return value !== undefined && NUMBER.test(value) ? Number(value) : 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
