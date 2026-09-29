import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, safePath } from '../src/server/api';
import { etagOf } from '../src/server/files';
import { OPENAPI } from '../src/server/openapi';

describe('safePath', () => {
  it('resolves files inside the root', () => {
    expect(safePath('/data', 'a/b.xml')).toBe('/data/a/b.xml');
  });

  it.each([['../x.xml'], ['/etc/x.xml'], ['a/../../x.xml'], ['a.txt'], ['']])('refuses %j', (path) => {
    expect(() => safePath('/data', path)).toThrow();
  });
});

const XML = '<root BTCPP_format="4"><BehaviorTree ID="A"><AlwaysSuccess/></BehaviorTree></root>\n';

describe('the API', () => {
  let base: string;
  let root: string;
  let other: string;
  let server: Server;
  let url: string;

  const call = async (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
    const res = await fetch(url + path, { method, ...init });
    return { status: res.status, etag: res.headers.get('etag'), data: await res.json() as Record<string, unknown> };
  };
  const put = (path: string, body: string, headers: Record<string, string> = {}) =>
    call('PUT', `/api/files/${path}`, { body, headers });
  const onDisk = (path: string) => readFile(join(root, path), 'utf8');

  beforeAll(async () => {
    // No native validator, whatever is built in the repo.
    process.env.BTCPP_VALIDATOR = '/nonexistent';
    base = await mkdtemp(join(tmpdir(), 'api-test-'));
    root = join(base, 'behaviors');
    other = join(base, 'other');
    await mkdir(root);
    await mkdir(other);
    const api = createApi(root, { base });
    server = createServer((req, res) => void api(req, res));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(root, 'a.xml'), { force: true });
    await writeFile(join(root, 'a.xml'), XML);
    await writeFile(join(root, 'package.xml'), '<package/>');
  });

  it('lists the behavior files with their ETags', async () => {
    const { status, data } = await call('GET', '/api/workspace');
    expect(status).toBe(200);
    expect(data.root).toBe(root);
    expect(data.files).toEqual([{ path: 'a.xml', content: XML, etag: etagOf(XML) }]);
    expect(data.nativeValidator).toBe(false);
  });

  it('saves over the version read, and returns 200 and the new ETag', async () => {
    const res = await put('a.xml', 'new', { 'If-Match': etagOf(XML) });
    expect(res.status).toBe(200);
    expect(res.etag).toBe(etagOf('new'));
    expect(res.data.etag).toBe(etagOf('new'));
    expect(await onDisk('a.xml')).toBe('new');
  });

  it('refuses to save over a version changed since, with 412 and the current ETag', async () => {
    await writeFile(join(root, 'a.xml'), 'changed by hand');
    const res = await put('a.xml', 'mine', { 'If-Match': etagOf(XML) });
    expect(res.status).toBe(412);
    expect(res.data).toMatchObject({ error: 'a.xml was changed on disk', etag: etagOf('changed by hand') });
    expect(await onDisk('a.xml')).toBe('changed by hand');
  });

  it('refuses to save over a file deleted since', async () => {
    await rm(join(root, 'a.xml'));
    const res = await put('a.xml', 'mine', { 'If-Match': etagOf(XML) });
    expect(res.status).toBe(412);
    expect(res.data.etag).toBeUndefined();
  });

  it('creates a file only if it does not exist, with If-None-Match: *', async () => {
    expect((await put('a.xml', 'mine', { 'If-None-Match': '*' })).status).toBe(412);
    expect((await put('sub/new.xml', XML, { 'If-None-Match': '*' })).status).toBe(201);
    expect(await onDisk('sub/new.xml')).toBe(XML);
    await rm(join(root, 'sub'), { recursive: true });
  });

  it('writes unconditionally without preconditions', async () => {
    expect((await put('a.xml', 'any')).status).toBe(200);
    expect(await onDisk('a.xml')).toBe('any');
  });

  it('deletes a file only if it is the version read', async () => {
    const path = '/api/files/a.xml';
    expect((await call('DELETE', path, { headers: { 'If-Match': etagOf('other') } })).status).toBe(412);
    expect((await call('DELETE', path, { headers: { 'If-Match': etagOf(XML) } })).status).toBe(200);
    await expect(onDisk('a.xml')).rejects.toThrow();
  });

  it('refuses changes meant for another folder, e.g. from another tab', async () => {
    const res = await put('a.xml', 'mine', { 'X-Behaviors-Root': encodeURIComponent(other) });
    expect(res.status).toBe(409);
    expect(await onDisk('a.xml')).toBe(XML);
    expect((await put('a.xml', 'mine', { 'X-Behaviors-Root': encodeURIComponent(root) })).status).toBe(200);
  });

  it('refuses paths outside the folder and bodies too large', async () => {
    // fetch would resolve an unencoded ../ itself.
    expect((await put('..%2Fx.xml', XML)).status).toBe(400);
    expect((await put('%E0.xml', XML)).status).toBe(400);
    expect((await put('a.xml', 'x'.repeat(11 * 1024 * 1024))).status).toBe(413);
  });

  it('browses and opens folders inside the base folder only', async () => {
    const listing = await call('GET', `/api/folders?path=${encodeURIComponent(base)}`);
    expect(listing.data).toMatchObject({ path: base, folders: ['behaviors', 'other'] });
    // Its parent is outside the base folder, so the dialog cannot go up.
    expect(listing.data).not.toHaveProperty('parent');
    expect((await call('GET', '/api/folders?path=%2F')).status).toBe(403);
    expect((await call('PUT', '/api/root', { body: JSON.stringify({ path: '/' }) })).status).toBe(403);
    expect((await call('PUT', '/api/root', { body: 'not json' })).status).toBe(400);

    expect((await call('PUT', '/api/root', { body: JSON.stringify({ path: other }) })).data).toEqual({ root: other });
    expect((await call('GET', '/api/workspace')).data.files).toEqual([]);
    await call('PUT', '/api/root', { body: JSON.stringify({ path: root }) });
  });

  it('accepts the slashes of a path encoded, as Swagger UI sends them', async () => {
    expect((await put('sub%2Fencoded.xml', XML)).status).toBe(201);
    expect(await onDisk('sub/encoded.xml')).toBe(XML);
    await rm(join(root, 'sub'), { recursive: true });
  });

  it('answers 404 to unknown routes, and 405 to other methods on a file', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    const res = await fetch(url + '/api/files/a.xml', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('PUT, DELETE');
  });
});

describe('the API documentation', () => {
  let root: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'api-docs-test-'));
    const api = createApi(root);
    server = createServer((req, res) => void api(req, res));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('describes only routes that the API has', async () => {
    const spec = await (await fetch(url + '/api/openapi.json')).json() as typeof OPENAPI;
    expect(spec).toEqual({ ...OPENAPI, servers: [{ url }] });
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        const res = await fetch(url + path.replace('{path}', 'a.xml'), { method: method.toUpperCase() });
        expect(res.status).not.toBe(404);
        expect(res.status).not.toBe(405);
      }
    }
  });

  it('serves Swagger UI', async () => {
    const page = await fetch(url + '/api/docs');
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    for (const [file] of (await page.text()).matchAll(/\/api\/docs\/[\w.-]+/g)) {
      expect((await fetch(url + file)).status).toBe(200);
    }
    expect((await fetch(url + '/api/docs/constructor')).status).toBe(404);
  });
});
