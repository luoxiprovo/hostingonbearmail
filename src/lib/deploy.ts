import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { cloneRepo, localHeadSha, pullRepo, repoExists } from "./git.js";
import {
  detectOutputDir,
  detectPackageManager,
  ensurePackageManager,
  hasDependencies,
  hasIndexHtml,
  hasNextBuild,
  installCommand,
  readPackageJson,
  scriptCommand,
} from "./pkg.js";
import { deployLogPath, envFilePath, logsDir, repoDir } from "./paths.js";
import { startProject, startStaticServer, stopProject } from "./process-manager.js";
import { parseEnv } from "./envfile.js";
import { mergeNodeOptions, runShell } from "./run.js";
import { getRecord, listRecords, upsertRecord } from "./store.js";
import type { ProjectRecord } from "./types.js";

const locks = new Map<string, Promise<unknown>>();

export function withProjectLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(name, next);
  return next;
}

export function rekeyProjectLock(oldName: string, newName: string): void {
  const pending = locks.get(oldName);
  if (!pending) return;
  locks.delete(oldName);
  locks.set(newName, pending);
}

async function openDeployLog(name: string): Promise<WriteStream> {
  await fs.mkdir(logsDir(name), { recursive: true });
  const stream = createWriteStream(deployLogPath(name), { flags: "a" });
  stream.write(`\n======== ${new Date().toISOString()} ========\n`);
  return stream;
}

async function copyEnvIntoRepo(name: string): Promise<void> {
  const src = envFilePath(name);
  const dest = path.join(repoDir(name), ".env");
  try {
    const contents = await fs.readFile(src, "utf8");
    await fs.writeFile(dest, contents, "utf8");
  } catch {
    /* no env yet */
  }
}

export async function cloneProject(name: string): Promise<void> {
  await withProjectLock(name, async () => {
    const record = getRecord(name);
    if (!record) throw new Error("Project not found");
    const log = await openDeployLog(name);
    try {
      record.status = "cloning";
      record.lastError = null;
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);
      log.write(`Cloning ${record.gitUrl}\n`);
      await cloneRepo({
        name,
        gitUrl: record.gitUrl,
        token: record.gitToken,
        branch: record.branch,
        log,
      });
      await copyEnvIntoRepo(name);
      record.status = "stopped";
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);
      log.write("Clone complete.\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.write(`Clone failed: ${message}\n`);
      record.status = "error";
      record.lastError = message;
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);
      throw err;
    } finally {
      log.end();
    }
  });
}

export async function deployProject(name: string): Promise<void> {
  await withProjectLock(name, async () => {
    const record = getRecord(name);
    if (!record) throw new Error("Project not found");
    const log = await openDeployLog(name);
    try {
      record.status = "building";
      record.lastError = null;
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);

      if (!(await repoExists(name))) {
        log.write("Repo missing locally; cloning first.\n");
        await cloneRepo({
          name,
          gitUrl: record.gitUrl,
          token: record.gitToken,
          branch: record.branch,
          log,
        });
      } else {
        log.write("Pulling latest...\n");
        await pullRepo({
          name,
          token: record.gitToken,
          branch: record.branch,
          log,
        });
      }

      await copyEnvIntoRepo(name);
      await stopProject(name);
      // stopProject may set status to stopped; keep building
      const current = getRecord(name);
      if (!current) throw new Error("Project not found");
      current.status = "building";
      await upsertRecord(current);

      await buildAndStart(current, log);
      current.status = "running";
      current.lastDeployAt = new Date().toISOString();
      current.lastDeploySha = (await localHeadSha(name)) || current.lastDeploySha;
      current.lastError = null;
      current.updatedAt = new Date().toISOString();
      await upsertRecord(current);
      log.write("Deploy complete.\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.write(`Deploy failed: ${message}\n`);
      const current = getRecord(name);
      if (current) {
        current.status = "error";
        current.lastError = message;
        current.updatedAt = new Date().toISOString();
        await upsertRecord(current);
      }
      throw err;
    } finally {
      log.end();
    }
  });
}

async function buildAndStart(record: ProjectRecord, log: WriteStream): Promise<void> {
  const root = repoDir(record.name);
  const pkg = await readPackageJson(record.name);
  const pm = await detectPackageManager(record.name);
  const envContent = await fs.readFile(envFilePath(record.name), "utf8").catch(() => "");
  const parsedEnv = parseEnv(envContent);
  const installEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...parsedEnv,
    PORT: String(record.port),
    HOST: "127.0.0.1",
    CI: "true",
    // systemd sets NODE_ENV=production; that makes pnpm/npm skip
    // devDependencies (typescript, tailwind) that builds need.
    NODE_ENV: "development",
    // This VM has no working IPv6; Yarn/npm otherwise stall on AAAA.
    // Default Node heap is ~512MB here; tsc/vite/next build OOM without swap room.
    NODE_OPTIONS: mergeNodeOptions(
      "--dns-result-order=ipv4first",
      "--max-old-space-size=1536",
    ),
  };
  const buildEnv: NodeJS.ProcessEnv = {
    ...installEnv,
    NODE_ENV: "production",
  };

  if (pm && hasDependencies(pkg)) {
    await ensurePackageManager(pm);
    log.write(`Installing dependencies with ${pm}...\n`);
    await runShell(installCommand(pm), {
      cwd: root,
      env: installEnv,
      log,
      timeoutMs: 60 * 60 * 1000,
    });
  } else if (pkg) {
    log.write("No package dependencies; skipping install.\n");
  }

  if (record.type === "static") {
    await deployStatic(record, pm, pkg, buildEnv, log);
    return;
  }

  await deployNode(record, pm, pkg, buildEnv, log);
}

async function deployStatic(
  record: ProjectRecord,
  pm: ReturnType<typeof detectPackageManager> extends Promise<infer T> ? T : never,
  pkg: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  log: WriteStream,
): Promise<void> {
  const root = repoDir(record.name);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts
      ? (pkg.scripts as Record<string, string>)
      : {};

  const shouldBuild = Boolean(record.buildCommand || scripts.build);
  if (pm && shouldBuild) {
    const cmd = record.buildCommand || scriptCommand(pm, "build");
    log.write(`Building: ${cmd}\n`);
    await runShell(cmd, {
      cwd: root,
      env,
      log,
      timeoutMs: 60 * 60 * 1000,
    });
    let output = await detectOutputDir(record.name, record.outputDir);
    if (!output && scripts.export) {
      const exportCmd = scriptCommand(pm, "export");
      log.write(`No dist/out/build; running export: ${exportCmd}\n`);
      await runShell(exportCmd, {
        cwd: root,
        env,
        log,
        timeoutMs: 60 * 60 * 1000,
      });
      output = await detectOutputDir(record.name, record.outputDir);
    }
    if (output) {
      log.write(`Serving static files from ${output}/\n`);
      await startStaticServer(record, path.join(root, output));
      return;
    }
    if (await hasNextBuild(record.name)) {
      log.write("Next.js build found (.next). Starting as a Node process (next start).\n");
      record.type = "node";
      await upsertRecord(record);
      await deployNode(record, pm, pkg, env, log);
      return;
    }
    throw new Error(
      "Build finished but no dist/out/build folder was found. For Next.js, set type to node (or add an export script). Otherwise set an output directory.",
    );
  }

  if (await hasIndexHtml(record.name)) {
    log.write("Serving repository root (index.html).\n");
    await startStaticServer(record, root);
    return;
  }

  throw new Error(
    "Static deploy finished but no dist/out/build folder or index.html was found. Set an output directory.",
  );
}

async function deployNode(
  record: ProjectRecord,
  pm: Awaited<ReturnType<typeof detectPackageManager>>,
  pkg: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  log: WriteStream,
): Promise<void> {
  const root = repoDir(record.name);
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts
      ? (pkg.scripts as Record<string, string>)
      : {};

  // next start (and similar) serves the last .next/dist; skipping build
  // leaves the old compile in place after git pull.
  if (record.buildCommand) {
    log.write(`Building: ${record.buildCommand}\n`);
    await runShell(record.buildCommand, {
      cwd: root,
      env,
      log,
      timeoutMs: 60 * 60 * 1000,
    });
  } else if (pm && scripts.build) {
    log.write("Running build script...\n");
    await runShell(scriptCommand(pm, "build"), {
      cwd: root,
      env,
      log,
      timeoutMs: 60 * 60 * 1000,
    });
  }

  let start = record.startCommand;
  if (!start) {
    if (scripts.start && /^node(\s|$)/.test(scripts.start.trim())) {
      start = scripts.start;
    } else if (pm && scripts.start) {
      start = scriptCommand(pm, "start");
    } else if (pkg && typeof pkg.main === "string") {
      start = `node ${pkg.main}`;
    } else {
      start = "npm start";
    }
  }
  log.write(`Starting: ${start}\n`);
  await startProject(record, start, root);
}

export async function resumeRunningProjects(): Promise<void> {
  const { killIfAlive } = await import("./process-manager.js");
  for (const record of listRecords()) {
    if (record.pid) await killIfAlive(record.pid);
    if (record.status === "cloning" || record.status === "building") {
      record.status = "stopped";
      record.pid = null;
      record.lastError = "Interrupted by control plane restart";
      record.updatedAt = new Date().toISOString();
      await upsertRecord(record);
      continue;
    }
    if (record.status !== "running") continue;
    if (record.runtimeCommand && record.runtimeRoot) {
      try {
        await startProject(record, record.runtimeCommand, record.runtimeRoot);
      } catch (err) {
        record.status = "error";
        record.lastError = err instanceof Error ? err.message : String(err);
        record.pid = null;
        record.updatedAt = new Date().toISOString();
        await upsertRecord(record);
      }
    }
  }
}
