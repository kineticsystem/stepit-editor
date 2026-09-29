// The client of the server's HTTP API (src/server/api.ts).

import type { ConflictResponse, FoldersResponse, WorkspaceResponse } from '../server/api';
import type { NativeResult } from '../server/native';

/** An error answered by the server, with its status and body. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The message of anything thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The folder whose files the editor holds, sent with every change so that the
 * server refuses it if another folder was opened since, e.g. in another tab.
 */
let loadedRoot: string | undefined;

export function setLoadedRoot(root: string | undefined) {
  loadedRoot = root;
}

function rootHeader(): Record<string, string> {
  return loadedRoot ? { 'X-Behaviors-Root': encodeURIComponent(loadedRoot) } : {};
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, (data.error as string | undefined) ?? `${res.status} ${res.statusText}`, data);
  return data as T;
}

/**
 * The precondition of a write: the ETag of the version on disk that the edit
 * is based on, or null for a file that must not exist yet.
 */
export type Expected = string | null;

function preconditions(expected: Expected): Record<string, string> {
  return expected === null ? { 'If-None-Match': '*' } : { 'If-Match': expected };
}

/** Whether an error is a 412: the file on disk is not the version expected. */
export function isConflict(e: unknown): e is ApiError & { data: ConflictResponse } {
  return e instanceof ApiError && e.status === 412;
}

/** The URL of a file: its path, a/b.xml, with each part encoded. */
const fileUrl = (path: string) => `/api/files/${path.split('/').map(encodeURIComponent).join('/')}`;

export const api = {
  workspace: () => request<WorkspaceResponse>('/api/workspace'),
  /** Writes a file if it is still the version expected; returns its new ETag. */
  save: (path: string, content: string, expected: Expected) =>
    request<{ etag: string }>(fileUrl(path), { method: 'PUT', body: content, headers: { ...rootHeader(), ...preconditions(expected) } }),
  remove: (path: string, expected: string) =>
    request<{ ok: true }>(fileUrl(path), { method: 'DELETE', headers: { ...rootHeader(), ...preconditions(expected) } }),
  folders: (path?: string) =>
    request<FoldersResponse>(path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders'),
  openFolder: (path: string) =>
    request<{ root: string }>('/api/root', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    }),
  validate: (files: { path: string; content: string }[]) =>
    request<NativeResult>('/api/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...rootHeader() }, body: JSON.stringify({ files }),
    }),
};
