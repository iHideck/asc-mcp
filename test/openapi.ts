import { readFileSync } from 'node:fs';

export type Method = 'get' | 'post' | 'patch' | 'delete';

type ValueSchema = {
  type?: string;
  enum?: string[];
  items?: { enum?: string[] };
  maximum?: number;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: ValueSchema };
type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  nullable?: boolean;
  deprecated?: boolean;
  oneOf?: Schema[];
  anyOf?: Schema[];
};
type Operation = {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema } | undefined> };
};
type PathItem = { parameters?: Parameter[] } & Partial<Record<Method, Operation>>;
type Spec = { paths: Record<string, PathItem> };

const spec = loadSpec();

// Apple は、次のページの URL に cursor を付ける。cursor は仕様の引数に無い
const PAGING_PARAMETERS = new Set(['cursor']);

export function specViolations(method: Method, url: URL, body?: unknown): string[] {
  const template = Object.keys(spec.paths)
    .filter((candidate) => matches(candidate, url.pathname))
    .sort((a, b) => literalSegments(b) - literalSegments(a))[0];
  const pathItem = template === undefined ? undefined : spec.paths[template];
  if (template === undefined || pathItem === undefined) {
    return [`${url.pathname} は、仕様に無いパスです`];
  }
  const operation = pathItem[method];
  if (operation === undefined) {
    return [`${method.toUpperCase()} ${template} は、仕様に無い操作です`];
  }
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].filter(
    (parameter) => parameter.in === 'query',
  );
  const violations: string[] = [];
  for (const [name, value] of url.searchParams) {
    if (PAGING_PARAMETERS.has(name)) {
      continue;
    }
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      violations.push(`${template} に、引数 ${name} はありません`);
      continue;
    }
    violations.push(...valueViolations(name, value, parameter.schema ?? {}));
  }
  for (const parameter of parameters) {
    if (parameter.required === true && !url.searchParams.has(parameter.name)) {
      violations.push(`${template} には、引数 ${parameter.name} が要ります`);
    }
  }
  violations.push(...bodyViolations(operation, body, `${method.toUpperCase()} ${template}`));
  return violations;
}

// JSON Pointer（例: /components/schemas/AppVersionState/enum）の指す値を返す
export function specAt(pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      spec,
    );
}

function loadSpec(): Spec {
  const path = new URL('../.local/openapi.oas.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Spec;
  } catch (error) {
    throw new Error(
      `Apple の OpenAPI の仕様 ${path.pathname} を読めません。make download-openapi で落としてください。`,
      { cause: error },
    );
  }
}

function bodyViolations(operation: Operation, body: unknown, where: string): string[] {
  const schema = operation.requestBody?.content['application/json']?.schema;
  if (schema === undefined) {
    return body === undefined ? [] : [`${where} は、本文を受け取りません`];
  }
  if (body === undefined) {
    return operation.requestBody?.required === true ? [`${where} には、本文が要ります`] : [];
  }
  return schemaViolations(schema, body, '本文');
}

// JSON Schema では仕様に無い名前も通るが、打ち間違いを見つけるために挙げる
function schemaViolations(schema: Schema, value: unknown, at: string): string[] {
  const resolved = resolve(schema);
  if (value === null) {
    return resolved.nullable === true ? [] : [`${at} に null は使えません`];
  }
  if (resolved.deprecated === true) {
    return [`${at} は、仕様で使わないことになっています`];
  }
  const branches = resolved.oneOf ?? resolved.anyOf;
  if (branches !== undefined) {
    return branches.some((branch) => schemaViolations(branch, value, at).length === 0)
      ? []
      : [`${at} が、仕様のどの形にも合いません`];
  }
  if (resolved.enum !== undefined && !resolved.enum.includes(value)) {
    return [`${at} に ${JSON.stringify(value)} は使えません`];
  }
  switch (resolved.type ?? (resolved.properties === undefined ? undefined : 'object')) {
    case 'object':
      return objectViolations(resolved, value, at);
    case 'array':
      return Array.isArray(value)
        ? value.flatMap((item, index) =>
            schemaViolations(resolved.items ?? {}, item, `${at}[${index}]`),
          )
        : [`${at} は配列です`];
    case 'string':
      return typeof value === 'string'
        ? formatViolations(resolved.format, value, at)
        : [`${at} は文字列です`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} は真偽値です`];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at} は整数です`];
    default:
      return [];
  }
}

function objectViolations(schema: Schema, value: unknown, at: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${at} はオブジェクトです`];
  }
  const missing = (schema.required ?? [])
    .filter((name) => !(name in value))
    .map((name) => `${at}.${name} が要ります`);
  const properties = schema.properties;
  const invalid = Object.entries(value).flatMap(([name, item]) => {
    if (properties === undefined) {
      return [];
    }
    const property = properties[name];
    return property === undefined
      ? [`${at}.${name} は、仕様にありません`]
      : schemaViolations(property, item, `${at}.${name}`);
  });
  return [...missing, ...invalid];
}

function formatViolations(format: string | undefined, value: string, at: string): string[] {
  if (format === 'date-time' && Number.isNaN(Date.parse(value))) {
    return [`${at} は日時です`];
  }
  if (format === 'uri' && !URL.canParse(value)) {
    return [`${at} は URL です`];
  }
  return [];
}

function resolve(schema: Schema): Schema {
  return schema.$ref === undefined ? schema : resolve(specAt(schema.$ref.slice(1)) as Schema);
}

function matches(template: string, pathname: string): boolean {
  const expected = template.split('/');
  const actual = pathname.split('/');
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => segment.startsWith('{') || segment === actual[index])
  );
}

function literalSegments(template: string): number {
  return template.split('/').filter((segment) => !segment.startsWith('{')).length;
}

function valueViolations(name: string, value: string, schema: ValueSchema): string[] {
  const allowed = schema.type === 'array' ? schema.items?.enum : schema.enum;
  const values = schema.type === 'array' ? value.split(',') : [value];
  const violations = (allowed === undefined ? [] : values.filter((v) => !allowed.includes(v))).map(
    (v) => `引数 ${name} に ${v} は使えません`,
  );
  if (schema.type === 'integer') {
    const number = Number(value);
    if (!Number.isInteger(number)) {
      violations.push(`引数 ${name} は整数です`);
    } else if (schema.maximum !== undefined && number > schema.maximum) {
      violations.push(`引数 ${name} は ${schema.maximum} までです`);
    }
  }
  return violations;
}
