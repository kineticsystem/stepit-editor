// The HTTP API over the folder of behaviors. It is a connect-style middleware
// so that the Vite development server and the production server share it.
//
//   GET    /api/workspace         The folder, its XML files, their contents and ETags
//   PUT    /api/files/a/b.xml     Create or overwrite a file (body: the XML)
//   DELETE /api/files/a/b.xml     Delete a file
//   POST   /api/validate          Validate with BehaviorTree.CPP
//                                 (body: {files: [{path, content}]})
//   GET    /api/folders?path=/a   The sub-folders of a folder, to choose one
//   PUT    /api/root              Open another folder (body: {path})
//   GET    /api/openapi.json      The OpenAPI description of the above
//   GET    /api/docs              Swagger UI, to browse and try the API
//
// Writes are conditional, so that nobody overwrites a change they have not
// seen: PUT and DELETE take the ETag of the version the editor read in
// If-Match, or If-None-Match: * to create a file only if it does not exist,
// and fail with 412 Precondition Failed otherwise. PUT answers 201 Created
// when the file did not exist, and 200 OK when it overwrote it. They also take the folder
// the editor loaded in X-Behaviors-Root, and fail with 409 Conflict if another
// folder was opened since, e.g. from another tab.

import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { NodeModel } from '../shared/types';
import { etagOf, isIgnoredFolder, isXmlFile, listXmlFiles, readBehaviorFiles, type StoredFile, type WorkspaceFile } from './files';
import { nativeBuiltins, nativeValidatorPath, validateNative } from './native';
import { DOCS_HTML, OPENAPI } from './openapi';

export type { WorkspaceFile } from './files';

export interface WorkspaceResponse {
  root: string;
  files: StoredFile[];
  /** Built-in models from the installed BehaviorTree.CPP, when available. */
  builtins?: NodeModel[];
  nativeValidator: boolean;
}

export interface FoldersResponse {
  path: string;
  /** Undefined at the top of the folders that can be opened. */
  parent?: string;
  folders: string[];
  /** The number of XML files directly in the folder. */
  xmlFiles: number;
}

/** The body of a 412 response: the ETag of the file on disk, if it exists. */
export interface ConflictResponse {
  error: string;
  etag?: string;
}

/** The header that carries the folder the editor loaded. */
export const ROOT_HEADER = 'x-behaviors-root';

/** The prefix of the URL of a file: the rest is its path in the folder. */
const FILES = '/api/files/';

/** The path of the file that a URL under FILES names, e.g. a/b.xml. */
function filePathOf(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.slice(FILES.length));
  } catch {
    throw new HttpError(400, 'The path is not valid URL encoding');
  }
}

/**
 * The address the client reached the server at, e.g. http://localhost:8080,
 * for the OpenAPI description: tools that import it, like Postman, need an
 * absolute address. It comes from the Host header, so it is right behind
 * Docker's port mapping and from other machines too.
 */
function serverUrl(req: IncomingMessage): string {
  const host = req.headers.host;
  if (!host) return '/';
  const forwarded = req.headers['x-forwarded-proto'];
  const scheme = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : 'http';
  return `${scheme}://${host}`;
}

/** The largest request body accepted, far above any behavior file. */
const MAX_BODY = 10 * 1024 * 1024;

/** The files of Swagger UI that /api/docs loads, and their types. */
const SWAGGER_UI = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
const DOCS_FILES: Record<string, string> = {
  'swagger-ui.css': 'text/css',
  'swagger-ui-bundle.js': 'text/javascript',
  'favicon-32x32.png': 'image/png',
};

class HttpError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Whether `path` is `folder` or inside it. */
export function isWithin(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** Resolves a path relative to the root, refusing anything outside it. */
export function safePath(root: string, path: string | null): string {
  if (!path) throw new HttpError(400, 'Missing path');
  if (isAbsolute(path) || path.includes('\0')) throw new HttpError(400, 'The path must be relative');
  if (!isXmlFile(path)) throw new HttpError(400, 'Only .xml files can be written');
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root) + sep)) throw new HttpError(400, 'The path is outside the behaviors folder');
  return full;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, `The request is larger than ${MAX_BODY / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  try {
    return JSON.parse(await body(req)) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'The request body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

/** The ETag of the file on disk, or undefined if there is none. */
async function currentEtag(full: string): Promise<string | undefined> {
  try {
    return etagOf(await readFile(full));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Checks If-Match and If-None-Match against the file on disk (RFC 9110 §13).
 * If-Match: * matches any existing file; If-None-Match: * only a missing one.
 */
async function checkPreconditions(req: IncomingMessage, full: string, path: string) {
  const ifMatch = req.headers['if-match'];
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifMatch === undefined && ifNoneMatch === undefined) return;
  const etag = await currentEtag(full);
  if (ifNoneMatch !== undefined && etag !== undefined && (ifNoneMatch === '*' || ifNoneMatch.includes(etag))) {
    throw new HttpError(412, `${path} already exists`, { etag });
  }
  if (ifMatch !== undefined) {
    const tags = ifMatch.split(',').map((t) => t.trim());
    if (etag === undefined) throw new HttpError(412, `${path} was deleted`);
    if (!tags.includes('*') && !tags.includes(etag)) throw new HttpError(412, `${path} was changed on disk`, { etag });
  }
}

/** Writes through a temporary file, so that a reader never sees half a file. */
async function writeAtomically(full: string, content: string) {
  await mkdir(dirname(full), { recursive: true });
  // A hidden name, so that listXmlFiles skips it.
  const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, content);
    await rename(temp, full);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

export interface ApiOptions {
  /**
   * The folder that the Open folder dialog may browse and open, besides the
   * initial folder: BEHAVIORS_BASE, or the home folder of the server's user.
   */
  base?: string;
}

export function createApi(initialRoot: string, options: ApiOptions = {}) {
  let root = resolve(initialRoot);
  const allowed = [resolve(options.base ?? process.env.BEHAVIORS_BASE ?? homedir()), root];
  let builtins: Promise<NodeModel[] | undefined> | undefined;

  const isAllowed = (path: string) => allowed.some((folder) => isWithin(folder, path));

  /** Resolves a folder that can be browsed or opened, refusing anything else. */
  async function folderPath(path: unknown): Promise<string> {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new HttpError(400, 'Missing path');
    if (!isAbsolute(path)) throw new HttpError(400, 'The path must be absolute');
    const full = resolve(path);
    if (!isAllowed(full)) throw new HttpError(403, `${full} is outside the folders that can be opened (${allowed[0]})`);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isDirectory()) throw new HttpError(400, `Not a folder: ${full}`);
    return full;
  }

  async function listFolders(path: string): Promise<FoldersResponse> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => {
      throw new HttpError(403, `Cannot read ${path}`);
    });
    const folders = entries
      .filter((e) => e.isDirectory() && !isIgnoredFolder(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const xmlFiles = entries.filter((e) => e.isFile() && isXmlFile(e.name)).length;
    const parent = dirname(path);
    return { path, parent: parent === path || !isAllowed(parent) ? undefined : parent, folders, xmlFiles };
  }

  /** Refuses a change meant for a folder other than the open one. */
  function checkRoot(req: IncomingMessage) {
    const expected = req.headers[ROOT_HEADER];
    if (typeof expected === 'string' && resolve(decodeURIComponent(expected)) !== root) {
      throw new HttpError(409, `The folder ${root} was opened since this one was loaded, e.g. in another tab: reload the editor`);
    }
  }

  return async function api(req: IncomingMessage, res: ServerResponse, next?: () => void) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (next) next();
      else send(res, 404, { error: 'Not found' });
      return;
    }
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/workspace') {
        builtins ??= nativeBuiltins().catch(() => undefined);
        const files = await readBehaviorFiles(root, await listXmlFiles(root));
        const response: WorkspaceResponse = {
          root, files, builtins: await builtins, nativeValidator: !!nativeValidatorPath(),
        };
        send(res, 200, response);
      } else if (route.startsWith(`PUT ${FILES}`)) {
        checkRoot(req);
        const path = filePathOf(url);
        const full = safePath(root, path);
        const content = await body(req);
        await checkPreconditions(req, full, path);
        const existed = await stat(full).then(() => true, () => false);
        await writeAtomically(full, content);
        const etag = etagOf(content);
        send(res, existed ? 200 : 201, { etag }, { ETag: etag });
      } else if (route.startsWith(`DELETE ${FILES}`)) {
        checkRoot(req);
        const path = filePathOf(url);
        const full = safePath(root, path);
        await checkPreconditions(req, full, path);
        await rm(full, { force: true });
        send(res, 200, { ok: true });
      } else if (url.pathname.startsWith(FILES)) {
        send(res, 405, { error: `${req.method} is not allowed on a file` }, { Allow: 'PUT, DELETE' });
      } else if (route === 'POST /api/validate') {
        checkRoot(req);
        const { files } = await jsonBody<{ files: WorkspaceFile[] }>(req);
        if (!Array.isArray(files)) throw new HttpError(400, 'Missing files');
        for (const f of files) safePath(root, f.path);
        send(res, 200, await validateNative(files));
      } else if (route === 'GET /api/folders') {
        send(res, 200, await listFolders(await folderPath(url.searchParams.get('path') ?? root)));
      } else if (route === 'PUT /api/root') {
        const { path } = await jsonBody<{ path?: unknown }>(req);
        root = await folderPath(path);
        console.log(`Behaviors folder: ${root}`);
        send(res, 200, { root });
      } else if (route === 'GET /api/openapi.json') {
        send(res, 200, { ...OPENAPI, servers: [{ url: serverUrl(req) }] });
      } else if (route === 'GET /api/docs') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(DOCS_HTML);
      } else if (req.method === 'GET' && Object.hasOwn(DOCS_FILES, url.pathname.replace('/api/docs/', ''))) {
        const name = url.pathname.replace('/api/docs/', '');
        res.setHeader('Content-Type', DOCS_FILES[name]);
        createReadStream(join(SWAGGER_UI, name)).pipe(res);
      } else {
        send(res, 404, { error: `No route ${route}` });
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const data = e instanceof HttpError ? e.data : {};
      // The rest of a request too large is never read: close the connection rather than reuse it.
      send(res, status, { error: e instanceof Error ? e.message : String(e), ...data }, status === 413 ? { Connection: 'close' } : {});
      if (status === 413) res.on('finish', () => req.destroy());
    }
  };
}
