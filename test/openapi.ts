import { readFileSync } from 'node:fs';

export type Method = 'get' | 'post' | 'patch' | 'delete';

type ValueSchema = {
  type?: string;
  enum?: string[];
  items?: { enum?: string[] };
  maximum?: number;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: ValueSchema };
type PathItem = { parameters?: Parameter[] } & Partial<
  Record<Method, { parameters?: Parameter[] }>
>;
type Spec = { paths: Record<string, PathItem> };

const spec = loadSpec();

// Apple は、次のページの URL に cursor を付ける。cursor は仕様の引数に無い
const PAGING_PARAMETERS = new Set(['cursor']);

export function specViolations(method: Method, url: URL): string[] {
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
  return violations;
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
