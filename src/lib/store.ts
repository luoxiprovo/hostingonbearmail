import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  normalizeRecord,
  type ProjectRecord,
  type Settings,
  type StoreData,
} from "./types.js";
import { dataDir, ensureDir, storePath } from "./paths.js";

let cache: StoreData | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyStore(): StoreData {
  return {
    settings: { ...DEFAULT_SETTINGS },
    projects: [],
  };
}

export async function initStore(): Promise<StoreData> {
  await ensureDir(dataDir());
  await ensureDir(path.join(dataDir(), "projects"));
  await ensureDir(path.join(dataDir(), "caddy"));
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreData;
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      projects: (parsed.projects ?? []).map((p) => normalizeRecord(p)),
    };
  } catch {
    cache = emptyStore();
    await persist(cache);
  }
  return cache;
}

export function getStore(): StoreData {
  if (!cache) throw new Error("Store not initialized");
  return cache;
}

export function getSettings(): Settings {
  return getStore().settings;
}

export function listRecords(): ProjectRecord[] {
  return getStore().projects;
}

export function getRecord(name: string): ProjectRecord | undefined {
  return getStore().projects.find((p) => p.name === name);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const store = getStore();
  store.settings = { ...store.settings, ...patch };
  await persist(store);
  return store.settings;
}

export async function upsertRecord(record: ProjectRecord): Promise<ProjectRecord> {
  const store = getStore();
  const normalized = normalizeRecord(record);
  const idx = store.projects.findIndex((p) => p.name === normalized.name);
  if (idx === -1) store.projects.push(normalized);
  else store.projects[idx] = normalized;
  await persist(store);
  return normalized;
}

export async function removeRecord(name: string): Promise<void> {
  const store = getStore();
  store.projects = store.projects.filter((p) => p.name !== name);
  await persist(store);
}

export function allocatePort(preferred?: number): number {
  const used = new Set(getStore().projects.map((p) => p.port));
  if (preferred && !used.has(preferred) && preferred >= 1024 && preferred <= 65535) {
    return preferred;
  }
  let port = getStore().settings.portRangeStart;
  while (used.has(port) || port === getStore().settings.bindPort) {
    port += 1;
    if (port > 65535) throw new Error("No free ports left");
  }
  return port;
}

async function persist(store: StoreData): Promise<void> {
  cache = store;
  writeChain = writeChain.then(() => atomicWrite(storePath(), JSON.stringify(store, null, 2)));
  await writeChain;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, file);
}
