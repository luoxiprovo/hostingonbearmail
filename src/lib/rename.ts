import fs from "node:fs/promises";
import { rekeyProjectLock, withProjectLock } from "./deploy.js";
import { projectDir } from "./paths.js";
import { rekeyProcess, startProject } from "./process-manager.js";
import { getRecord, removeRecord, upsertRecord } from "./store.js";
import type { ProjectRecord } from "./types.js";
import { HttpError, assertName } from "./validate.js";

function rewritePrefix(value: string | null, from: string, to: string): string | null {
  if (!value) return value;
  return value.split(from).join(to);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function renameProject(oldName: string, newNameRaw: string): Promise<ProjectRecord> {
  const newName = assertName(newNameRaw);
  if (newName === oldName) {
    const record = getRecord(oldName);
    if (!record) throw new HttpError(404, "Project not found");
    return record;
  }

  return withProjectLock(oldName, async () => {
    const record = getRecord(oldName);
    if (!record) throw new HttpError(404, "Project not found");
    if (record.status === "cloning" || record.status === "building") {
      throw new HttpError(409, "Project is busy; wait for clone/deploy to finish");
    }
    if (getRecord(newName)) {
      throw new HttpError(409, `Project ${newName} already exists`);
    }

    const fromDir = projectDir(oldName);
    const toDir = projectDir(newName);
    if (await exists(toDir)) {
      throw new HttpError(409, `Folder already exists for ${newName}`);
    }

    const hadFolder = await exists(fromDir);
    if (hadFolder) {
      await fs.rename(fromDir, toDir);
    }

    const wasRunning = record.status === "running";
    try {
      record.runtimeRoot = rewritePrefix(record.runtimeRoot, fromDir, toDir);
      record.runtimeCommand = rewritePrefix(record.runtimeCommand, fromDir, toDir);
      rekeyProcess(oldName, newName);
      rekeyProjectLock(oldName, newName);
      await removeRecord(oldName);
      record.name = newName;
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);
      if (wasRunning && record.runtimeCommand && record.runtimeRoot) {
        await startProject(record, record.runtimeCommand, record.runtimeRoot);
      }
      return record;
    } catch (err) {
      if (hadFolder) {
        await fs.rename(toDir, fromDir).catch(() => undefined);
      }
      throw err;
    }
  });
}
