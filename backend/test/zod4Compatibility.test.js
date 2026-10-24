import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('patched dependency graph is pinned in backend and root workspace locks', () => {
  const pkg = JSON.parse(read('../package.json'));
  const backend = JSON.parse(read('../package-lock.json'));
  const workspace = JSON.parse(read('../../package-lock.json'));
  assert.equal(pkg.dependencies.zod, '4.6.6');
  assert.equal(backend.packages['node_modules/zod'].version, '4.6.6');
  assert.equal(workspace.packages['backend/node_modules/zod'].version, '4.6.6');
  assert.equal(backend.packages['node_modules/body-parser'].version, '1.20.9');
  assert.equal(workspace.packages['node_modules/body-parser'].version, '1.20.9');
  for (const node of [
    backend.packages['node_modules/zod'], workspace.packages['backend/node_modules/zod'],
    backend.packages['node_modules/body-parser'], workspace.packages['node_modules/body-parser']
  ]) {
    assert.match(node.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(node.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  }
});

test('Zod 4 still supports required objects, UUIDs, temporal fields and flattened 422 issues', () => {
  const schema = z.object({
    id: z.string().uuid(),
    year: z.coerce.number().int().min(2000),
    date: z.coerce.date(),
    status: z.enum(['planned', 'active'])
  }).strict();
  const id = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
  const parsed = schema.safeParse({ id, year: '2026', date: '2026-10-23', status: 'planned' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.year, 2026);
  assert.ok(parsed.data.date instanceof Date);
  const invalid = schema.safeParse({ id: 'wrong', year: 2026, date: 'bad', status: 'planned', extra: 1 });
  assert.equal(invalid.success, false);
  const flattened = invalid.error.flatten();
  assert.ok(flattened.fieldErrors.id?.length);
  assert.ok(flattened.fieldErrors.date?.length);
  assert.ok(flattened.formErrors.length);
});

test('Zod 4 record key and value schemas preserve metadata/config JSON semantics', () => {
  const schema = z.object({
    metadata: z.record(z.string(), z.any()).default({})
  });
  assert.deepEqual(schema.parse({}), { metadata: {} });
  const content = { machine: { year: 2026 }, flags: [true, null, false], bool: false };
  assert.deepEqual(schema.parse({ metadata: content }).metadata, content);
  assert.equal(schema.safeParse({ metadata: [1, 2] }).success, false);
  assert.equal(schema.safeParse({ metadata: 42 }).success, false);
  for (const router of [
    '../src/modules/assets/router.js',
    '../src/modules/reports/router.js'
  ]) {
    const source = read(router);
    assert.doesNotMatch(source, /z\.record\(z\.any\(\)\)/);
    assert.match(source, /z\.record\(z\.string\(\), z\.any\(\)\)/);
  }
});

test('custom issues and bounded collections used by scouting/sync remain available', () => {
  const schema = z.object({ operations: z.array(z.object({
    id: z.string().min(1)
  }).strict()).min(1).max(50) }).strict().superRefine((data, ctx) => {
    if (data.operations[0]?.id === 'invalid') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['operations', 0, 'id'],
        message: 'Operation ID denied' });
    }
  });
  assert.equal(schema.safeParse({ operations: [{ id: 'valid' }] }).success, true);
  const invalid = schema.safeParse({ operations: [{ id: 'invalid' }] });
  assert.equal(invalid.success, false);
  assert.ok(invalid.error.flatten().fieldErrors.operations?.length);
  assert.equal(schema.safeParse({
    operations: Array.from({ length: 51 }, (_, n) => ({ id: String(n) }))
  }).success, false);
});
