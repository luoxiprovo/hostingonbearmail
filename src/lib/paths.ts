import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(__dirname, "../..");

export function dataDir(): string {
  return process.env.HOSTING_DATA_DIR || path.join(APP_ROOT, "data");
}

export function storePath(): string {
  return path.join(dataDir(), "hosting.json");
}

export function caddySnippetPath(): string {
  return path.join(dataDir(), "caddy", "hosting.caddy");
}

export function projectDir(name: string): string {
  return path.join(dataDir(), "projects", name);
}

export function repoDir(name: string): string {
  return path.join(projectDir(name), "repo");
}

export function envFilePath(name: string): string {
  return path.join(projectDir(name), ".env");
}

export function logsDir(name: string): string {
  return path.join(projectDir(name), "logs");
}

export function deployLogPath(name: string): string {
  return path.join(logsDir(name), "deploy.log");
}

export function runtimeLogPath(name: string): string {
  return path.join(logsDir(name), "runtime.log");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureProjectLayout(name: string): Promise<void> {
  await ensureDir(projectDir(name));
  await ensureDir(logsDir(name));
  const envPath = envFilePath(name);
  try {
    await fs.access(envPath);
  } catch {
    await fs.writeFile(envPath, "", "utf8");
  }
}

export function homeBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}
