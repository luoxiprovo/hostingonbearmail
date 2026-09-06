import fs from "node:fs/promises";
import path from "node:path";
import { repoDir } from "./paths.js";
import { run } from "./run.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export async function detectPackageManager(name: string): Promise<PackageManager | null> {
  const root = repoDir(name);
  const has = async (file: string) => {
    try {
      await fs.access(path.join(root, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await has("pnpm-lock.yaml")) return "pnpm";
  if (await has("yarn.lock")) return "yarn";
  if (await has("bun.lockb") || (await has("bun.lock"))) return "bun";
  if (await has("package.json")) return "npm";
  return null;
}

export async function readPackageJson(name: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(repoDir(name), "package.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasDependencies(pkg: Record<string, unknown> | null): boolean {
  if (!pkg) return false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const value = pkg[key];
    if (value && typeof value === "object" && Object.keys(value as object).length > 0) {
      return true;
    }
  }
  return false;
}

export async function ensurePackageManager(pm: PackageManager): Promise<void> {
  if (pm === "npm") return;
  try {
    await run(pm, ["--version"]);
  } catch {
    const hint =
      pm === "pnpm"
        ? "sudo npm install -g pnpm@9"
        : pm === "yarn"
          ? "sudo npm install -g yarn"
          : "install bun from https://bun.sh";
    throw new Error(
      `${pm} is required (this repo has a ${pm} lockfile) but it is not installed. On this server run: ${hint}`,
    );
  }
}

export function installCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install --frozen-lockfile --prod=false || pnpm install --prod=false";
    case "yarn":
      return "yarn install --frozen-lockfile --prefer-offline --network-timeout 600000 || yarn install --prefer-offline --network-timeout 600000";
    case "bun":
      return "bun install";
    default:
      return "npm ci || npm install";
  }
}

export function scriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

export async function detectOutputDir(name: string, configured: string): Promise<string | null> {
  if (configured) {
    const p = path.join(repoDir(name), configured);
    try {
      await fs.access(p);
      return configured;
    } catch {
      return null;
    }
  }
  const candidates = ["dist", "out", "build"];
  for (const dir of candidates) {
    try {
      await fs.access(path.join(repoDir(name), dir));
      return dir;
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function hasNextBuild(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoDir(name), ".next", "BUILD_ID"));
    return true;
  } catch {
    return false;
  }
}

export async function hasIndexHtml(name: string, subdir = ""): Promise<boolean> {
  try {
    await fs.access(path.join(repoDir(name), subdir, "index.html"));
    return true;
  } catch {
    return false;
  }
}
