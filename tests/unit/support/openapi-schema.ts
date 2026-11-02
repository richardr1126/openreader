import { publicApiSpec } from '@/lib/server/api/openapi';

type Schema = Record<string, unknown>;

function typeMatches(type: string, value: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === type;
}

/** The keywords the published specification uses. Returns where a value breaks its schema. */
export function schemaProblems(schema: Schema, value: unknown, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const schemas = publicApiSpec.components.schemas as Record<string, Schema>;
    return schemaProblems(schemas[name], value, at);
  }
  const problems: string[] = [];
  for (const part of (schema.allOf ?? []) as Schema[]) problems.push(...schemaProblems(part, value, at));
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const parts = schema[keyword] as Schema[] | undefined;
    if (parts && !parts.some(part => schemaProblems(part, value, at).length === 0)) problems.push(`${at}: matches no ${keyword} branch`);
  }
  if (schema.type !== undefined) {
    const types = [schema.type].flat() as string[];
    if (!types.some(type => typeMatches(type, value))) return [...problems, `${at}: ${JSON.stringify(value)} is not ${types.join(' or ')}`];
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) problems.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
  if ('const' in schema && schema.const !== value) problems.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${at}: ${value} is below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${at}: ${value} is above ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push(`${at}: too short`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: ${value} does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaProblems(schema.items as Schema, item, `${at}[${index}]`)));
  }
  if (typeMatches('object', value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in record)) problems.push(`${at}.${key}: missing`);
    for (const [key, property] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
      if (key in record) problems.push(...schemaProblems(property, record[key], `${at}.${key}`));
    }
  }
  return problems;
}

/** Where a real JSON response breaks what the specification publishes for its operation and status. */
export function responseProblems(route: keyof typeof publicApiSpec.paths, method: string, status: number, body: unknown): string[] {
  const operation = (publicApiSpec.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[method];
  const documented = operation.responses[String(status)] ?? operation.responses.default;
  const schema = documented?.content?.['application/json']?.schema;
  return schema ? schemaProblems(schema, body) : [`${method} ${route} documents no JSON for ${status}`];
}
