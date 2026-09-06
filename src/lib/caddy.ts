import fs from "node:fs/promises";
import path from "node:path";
import { caddyfilePath, ensureDir } from "./paths.js";
import { run } from "./run.js";
import type { ProjectRecord, Settings } from "./types.js";

const SYSTEM_CADDYFILE = "/etc/caddy/Caddyfile";

/** Apex example.com also serves www.example.com on the same site. */
export function siteHostnames(domain: string): string[] {
  const names = [domain];
  if (domain.startsWith("www.")) {
    const apex = domain.slice(4);
    if (apex.includes(".")) names.unshift(apex);
  } else {
    names.push(`www.${domain}`);
  }
  return names;
}

export function renderCaddyfile(projects: ProjectRecord[], settings: Settings): string {
  const lines: string[] = ["{"];
  if (settings.acmeEmail) {
    lines.push(`\temail ${settings.acmeEmail}`);
  }
  lines.push("\tadmin 127.0.0.1:2019");
  lines.push("}");
  lines.push("");

  const used = new Set<string>();
  for (const project of projects) {
    if (!project.domain) continue;
    const names = siteHostnames(project.domain).filter((name) => !used.has(name));
    if (names.length === 0) continue;
    for (const name of names) used.add(name);
    lines.push(`${names.join(", ")} {`);
    lines.push("\tencode gzip");
    lines.push(`\treverse_proxy 127.0.0.1:${project.port}`);
    lines.push("}");
    lines.push("");
  }

  if (used.size === 0) {
    lines.push("# No domains yet. Add a project domain and reload.");
    lines.push("");
  }

  return lines.join("\n");
}

export async function syncCaddy(projects: ProjectRecord[], settings: Settings): Promise<void> {
  const contents = renderCaddyfile(projects, settings);
  const local = caddyfilePath();
  await ensureDir(path.dirname(local));
  await fs.writeFile(local, contents, "utf8");

  await run("caddy", ["validate", "--config", local, "--adapter", "caddyfile"]);
  await run("sudo", ["cp", local, SYSTEM_CADDYFILE]);
  await run("sudo", ["systemctl", "reload", "caddy"]).catch(async () => {
    await run("sudo", ["systemctl", "restart", "caddy"]);
  });
}

export async function caddyStatus(): Promise<{ installed: boolean; active: boolean; version: string }> {
  let installed = false;
  let version = "";
  let active = false;
  try {
    const { stdout } = await run("caddy", ["version"]);
    installed = true;
    version = stdout.trim().split(/\s+/)[0] ?? "";
  } catch {
    installed = false;
  }
  try {
    const { stdout } = await run("systemctl", ["is-active", "caddy"]);
    active = stdout.trim() === "active";
  } catch {
    active = false;
  }
  return { installed, active, version };
}
