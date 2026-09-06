import { deployProject } from "./deploy.js";
import { localHeadSha, remoteHeadSha, repoExists } from "./git.js";
import { getRecord, listRecords, upsertRecord } from "./store.js";

const TICK_MS = 20_000;
const checking = new Set<string>();

export function startAutoDeployPoller(): void {
  void tick();
  setInterval(() => void tick(), TICK_MS);
}

async function tick(): Promise<void> {
  for (const record of listRecords()) {
    if (record.autoDeploy) void checkProject(record.name);
  }
}

async function checkProject(name: string): Promise<void> {
  if (checking.has(name)) return;
  const record = getRecord(name);
  if (!record?.autoDeploy) return;
  if (record.status === "cloning" || record.status === "building") return;

  const intervalMs = Math.max(1, record.autoDeployIntervalMin || 5) * 60 * 1000;
  if (record.lastAutoCheckAt) {
    const elapsed = Date.now() - Date.parse(record.lastAutoCheckAt);
    if (Number.isFinite(elapsed) && elapsed < intervalMs) return;
  }

  checking.add(name);
  try {
    const sha = await remoteHeadSha({
      name: record.name,
      gitUrl: record.gitUrl,
      token: record.gitToken,
      branch: record.branch,
    });
    const current = getRecord(name);
    if (!current?.autoDeploy) return;

    current.lastAutoCheckAt = new Date().toISOString();

    if (!sha) {
      await upsertRecord(current);
      return;
    }

    if (!current.lastDeploySha && (await repoExists(name))) {
      current.lastDeploySha = await localHeadSha(name);
    }

    if (current.lastDeploySha && sha === current.lastDeploySha) {
      await upsertRecord(current);
      return;
    }

    if (current.lastAutoAttemptSha === sha && current.status === "error") {
      await upsertRecord(current);
      return;
    }

    current.lastAutoAttemptSha = sha;
    await upsertRecord(current);
    console.log(
      `auto-deploy ${name}: ${current.lastDeploySha ?? "none"} -> ${sha}`,
    );
    await deployProject(name);
  } catch (err) {
    console.warn(
      `auto-deploy check ${name}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    checking.delete(name);
  }
}
