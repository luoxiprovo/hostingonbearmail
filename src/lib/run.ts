import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: Writable;
}

/** Keep /usr/local/bin first so globally installed pnpm/yarn win over broken corepack shims. */
export function withBinPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = ["/usr/local/bin", "/usr/bin"];
  const current = (env.PATH || process.env.PATH || "").split(":").filter(Boolean);
  const path = [...extra.filter((p) => !current.includes(p)), ...current].join(":");
  return { ...env, PATH: path };
}

/** Merge NODE_OPTIONS flags; later values of the same flag win. */
export function mergeNodeOptions(...flags: string[]): string {
  const parts = [process.env.NODE_OPTIONS, ...flags]
    .filter((s): s is string => Boolean(s))
    .flatMap((s) => s.split(/\s+/))
    .filter(Boolean);
  const byKey = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    byKey.set(key, part);
  }
  return [...byKey.values()].join(" ");
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}

export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withBinPath(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const writeLog = (chunk: string) => {
      if (options.log) options.log.write(chunk);
    };

    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      writeLog(text);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      writeLog(text);
    });

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut && code !== 0) {
        reject(
          new RunError(
            `Timed out: ${command} ${args.join(" ")}`,
            null,
            stdout,
            stderr,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new RunError(
            `${command} ${args.join(" ")} exited ${code}`,
            code,
            stdout,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export function runShell(
  command: string,
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: withBinPath(options.env ?? process.env),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const writeLog = (chunk: string) => {
      if (options.log) options.log.write(chunk);
    };

    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      writeLog(text);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      writeLog(text);
    });

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut && code !== 0) {
        reject(new RunError(`Timed out: ${command}`, null, stdout, stderr));
        return;
      }
      if (code !== 0) {
        reject(new RunError(`${command} exited ${code}`, code, stdout, stderr));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
