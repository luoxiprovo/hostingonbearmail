import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./envfile.js";
import { mergeNodeOptions, withBinPath } from "./run.js";
import { envFilePath, repoDir, runtimeLogPath } from "./paths.js";
import { getRecord, upsertRecord } from "./store.js";
import type { ProjectRecord } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const children = new Map<string, ChildProcess>();
const ignoringExitPids = new Set<number>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const start = Date.now();
  while (Date.now() - start < 4000 && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (pidAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

export async function killIfAlive(pid: number): Promise<void> {
  if (pidAlive(pid)) await killTree(pid);
}

export function rekeyProcess(oldName: string, newName: string): void {
  const child = children.get(oldName);
  if (!child) return;
  children.delete(oldName);
  children.set(newName, child);
}

function waitForPort(host: string, port: number, timeoutMs: number, pid: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!pidAlive(pid)) {
        reject(new Error("Process exited before opening its port; see the runtime log"));
        return;
      }
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Process started but port ${port} never opened; see the runtime log`));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

export async function stopProject(name: string, opts: { keepStatus?: boolean } = {}): Promise<void> {
  const child = children.get(name);
  const record = getRecord(name);
  const pid = child?.pid ?? record?.pid ?? null;
  if (pid) ignoringExitPids.add(pid);
  if (child) {
    children.delete(name);
    if (child.pid) await killTree(child.pid);
    else child.kill("SIGTERM");
  } else if (pid && pidAlive(pid)) {
    await killTree(pid);
  }
  if (record) {
    record.pid = null;
    if (!opts.keepStatus && record.status === "running") record.status = "stopped";
    record.updatedAt = new Date().toISOString();
    await upsertRecord(record);
  }
}

export async function startProject(
  record: ProjectRecord,
  command: string,
  cwd: string,
): Promise<void> {
  await stopProject(record.name);

  const envContent = fs.existsSync(envFilePath(record.name))
    ? fs.readFileSync(envFilePath(record.name), "utf8")
    : "";
  const fileEnv = parseEnv(envContent);
  const childEnv: NodeJS.ProcessEnv = withBinPath({
    ...process.env,
    ...fileEnv,
    PORT: String(record.port),
    HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    NODE_OPTIONS: mergeNodeOptions("--dns-result-order=ipv4first"),
  });

  fs.mkdirSync(path.dirname(runtimeLogPath(record.name)), { recursive: true });
  const logStream = createWriteStream(runtimeLogPath(record.name), { flags: "a" });
  logStream.write(`\n--- start ${new Date().toISOString()} ---\n$ ${command}\n`);

  const child = spawn(command, {
    cwd,
    env: childEnv,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.pid) {
    logStream.write("failed to spawn process\n");
    logStream.end();
    throw new Error("Failed to start process");
  }

  child.stdout?.on("data", (buf: Buffer) => logStream.write(buf));
  child.stderr?.on("data", (buf: Buffer) => logStream.write(buf));
  child.on("exit", (code, signal) => {
    logStream.write(`\n--- exit code=${code} signal=${signal} ${new Date().toISOString()} ---\n`);
    logStream.end();
    children.delete(record.name);
    if (child.pid && ignoringExitPids.has(child.pid)) {
      ignoringExitPids.delete(child.pid);
      return;
    }
    const current = getRecord(record.name);
    if (current && current.pid === child.pid) {
      current.pid = null;
      if (current.status === "running") {
        current.status = code === 0 ? "stopped" : "error";
        current.lastError =
          code === 0 ? null : `Process exited with code ${code ?? signal}`;
        current.updatedAt = new Date().toISOString();
        void upsertRecord(current);
      }
    }
  });

  children.set(record.name, child);
  record.pid = child.pid;
  record.runtimeCommand = command;
  record.runtimeRoot = cwd;
  record.lastError = null;
  record.updatedAt = new Date().toISOString();
  await upsertRecord(record);

  try {
    await waitForPort("127.0.0.1", record.port, 60_000, child.pid);
  } catch (err) {
    await stopProject(record.name);
    throw err;
  }

  record.status = "running";
  record.updatedAt = new Date().toISOString();
  await upsertRecord(record);
}

export async function startStaticServer(record: ProjectRecord, root: string): Promise<void> {
  const serverJs = path.join(__dirname, "static-server.js");
  const command = `node ${JSON.stringify(serverJs)} --root ${JSON.stringify(root)} --port ${record.port} --host 127.0.0.1`;
  await startProject(record, command, root);
}

export async function reconcileProcesses(): Promise<void> {
  const { listRecords } = await import("./store.js");
  for (const record of listRecords()) {
    if (record.status !== "running" || !record.pid) continue;
    if (pidAlive(record.pid)) {
      continue;
    }
    record.pid = null;
    record.status = "stopped";
    record.updatedAt = new Date().toISOString();
    await upsertRecord(record);
  }
}

export function runtimeCwd(record: ProjectRecord): string {
  return repoDir(record.name);
}
