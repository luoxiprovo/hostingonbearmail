import fs from "node:fs/promises";
import { deployLogPath, runtimeLogPath } from "./paths.js";

export type LogKind = "deploy" | "runtime";

export async function readLogTail(name: string, kind: LogKind, maxBytes = 200_000): Promise<string> {
  const file = kind === "runtime" ? runtimeLogPath(name) : deployLogPath(name);
  try {
    const stat = await fs.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(file, "r");
    try {
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
