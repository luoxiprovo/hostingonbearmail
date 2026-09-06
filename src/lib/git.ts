import fs from "node:fs/promises";
import type { Writable } from "node:stream";
import { repoDir } from "./paths.js";
import { run } from "./run.js";

export function gitEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    const header = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${header}`;
  }
  return env;
}

export async function cloneRepo(opts: {
  name: string;
  gitUrl: string;
  token: string;
  branch: string;
  log?: Writable;
}): Promise<void> {
  const dest = repoDir(opts.name);
  await fs.rm(dest, { recursive: true, force: true });
  const args = ["clone", "--single-branch"];
  if (opts.branch) args.push("--branch", opts.branch);
  args.push(opts.gitUrl, dest);
  await run("git", args, {
    env: gitEnv(opts.token),
    log: opts.log,
    timeoutMs: 10 * 60 * 1000,
  });
}

export async function pullRepo(opts: {
  name: string;
  token: string;
  branch: string;
  log?: Writable;
}): Promise<void> {
  const dest = repoDir(opts.name);
  const env = gitEnv(opts.token);

  await run("git", ["fetch", "--all", "--prune"], {
    cwd: dest,
    env,
    log: opts.log,
    timeoutMs: 10 * 60 * 1000,
  });

  const branch = opts.branch || (await currentBranch(dest));
  await run("git", ["checkout", branch], { cwd: dest, env, log: opts.log });
  await run("git", ["reset", "--hard", `origin/${branch}`], {
    cwd: dest,
    env,
    log: opts.log,
  });
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

export async function repoExists(name: string): Promise<boolean> {
  try {
    await fs.access(repoDir(name));
    return true;
  } catch {
    return false;
  }
}

export async function localHeadSha(name: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repoDir(name) });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function remoteHeadSha(opts: {
  name: string;
  gitUrl: string;
  token: string;
  branch: string;
}): Promise<string | null> {
  const env = gitEnv(opts.token);
  const exists = await repoExists(opts.name);
  const target = exists ? "origin" : opts.gitUrl;
  const cwd = exists ? repoDir(opts.name) : undefined;
  let ref = "HEAD";
  if (opts.branch) {
    ref = `refs/heads/${opts.branch}`;
  } else if (exists) {
    try {
      const branch = await currentBranch(repoDir(opts.name));
      if (branch && branch !== "HEAD") ref = `refs/heads/${branch}`;
    } catch {
      /* fall back to HEAD */
    }
  }
  const { stdout } = await run("git", ["ls-remote", target, ref], {
    cwd,
    env,
    timeoutMs: 60 * 1000,
  });
  const line = stdout.trim().split("\n").find((row) => row.trim()) || "";
  const sha = line.split(/\s+/)[0] || "";
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha : null;
}
