import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { publicApiSpec } from '@/lib/server/api/openapi';
import { GET } from '@/app/api/v1/openapi.json/route';

test('the published specification covers every implemented v1 method and no deleted routes', async () => {
  const root = path.resolve(import.meta.dirname, '../../src/app/api/v1');
  const actual: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name === 'route.ts') {
        const route = '/' + path.relative(root, directory).replaceAll(path.sep, '/').replace(/\[([^\]]+)\]/g, '{$1}');
        for (const match of readFileSync(filename, 'utf8').matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\(/g)) actual.push(`${match[1]} ${route}`);
      }
    }
  }
  visit(root);
  const documented = Object.entries(publicApiSpec.paths).flatMap(([route, operations]) => Object.keys(operations)
    .filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).map(method => `${method.toUpperCase()} ${route}`));
  expect(documented.sort()).toEqual(actual.sort());
  const response = await GET();
  expect(response.status).toBe(200); expect(await response.json()).toEqual(publicApiSpec);
});

test('all schema references resolve and operation IDs are unique', () => {
  const names = Object.keys(publicApiSpec.components.schemas);
  const ids: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === 'string') expect(names).toContain(record.$ref.replace('#/components/schemas/', ''));
    if (typeof record.operationId === 'string') ids.push(record.operationId);
    Object.values(record).forEach(visit);
  }
  visit(publicApiSpec);
  expect(new Set(ids).size).toBe(ids.length);
  expect(publicApiSpec.components.securitySchemes.oauth.flows.authorizationCode.scopes).toHaveProperty('documents:read');
});
