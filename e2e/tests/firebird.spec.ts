import { test, expect, request } from '@playwright/test';

/**
 * E2E tests for the FirebirdLite demo server.
 *
 * The server is started by the `webServer` configuration in playwright.config.ts
 * (or manually before running the tests).  All interactions go through the
 * HTTP API so these tests are independent of any browser UI.
 */

test.describe('FirebirdLite demo server', () => {
  test('health endpoint returns ok', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
    await ctx.dispose();
  });

  test('can query RDB$DATABASE', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.post('/query', {
      data: { sql: "SELECT 'hello' AS greeting FROM RDB$DATABASE" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].GREETING).toBe('hello');
    await ctx.dispose();
  });

  test('can create table and insert/query rows', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });

    await ctx.post('/exec', {
      data: { sql: 'CREATE TABLE e2e_items (id INTEGER, label VARCHAR(80))' },
    });
    await ctx.post('/exec', {
      data: { sql: "INSERT INTO e2e_items VALUES (1, 'playwright')" },
    });
    await ctx.post('/exec', {
      data: { sql: "INSERT INTO e2e_items VALUES (2, 'firebird')" },
    });

    const res = await ctx.post('/query', {
      data: { sql: 'SELECT id, label FROM e2e_items ORDER BY id' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ ID: 1, LABEL: 'playwright' });
    expect(body.rows[1]).toMatchObject({ ID: 2, LABEL: 'firebird' });

    await ctx.dispose();
  });

  test('parameterised queries work end-to-end', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });

    await ctx.post('/exec', {
      data: { sql: 'CREATE TABLE e2e_params (id INTEGER, txt VARCHAR(100))' },
    });
    await ctx.post('/query', {
      data: {
        sql: 'INSERT INTO e2e_params (id, txt) VALUES (?, ?)',
        params: [99, 'param-test'],
      },
    });

    const res = await ctx.post('/query', {
      data: {
        sql: 'SELECT txt FROM e2e_params WHERE id = ?',
        params: [99],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].TXT).toBe('param-test');

    await ctx.dispose();
  });

  test('fields metadata is returned', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });

    await ctx.post('/exec', {
      data: {
        sql: 'CREATE TABLE e2e_meta (id INTEGER, name VARCHAR(50), score NUMERIC(5,2))',
      },
    });
    await ctx.post('/exec', {
      data: { sql: "INSERT INTO e2e_meta VALUES (1, 'alice', 9.5)" },
    });

    const res = await ctx.post('/query', {
      data: { sql: 'SELECT id, name, score FROM e2e_meta' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.fields)).toBe(true);
    const names = body.fields.map((f: { name: string }) => f.name);
    expect(names).toEqual(['ID', 'NAME', 'SCORE']);

    await ctx.dispose();
  });

  test('unknown route returns 404', async ({ baseURL }) => {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.get('/not-a-route');
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });
});
