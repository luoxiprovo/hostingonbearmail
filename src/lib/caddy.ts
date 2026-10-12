import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { caddySnippetPath, ensureDir } from "./paths.js";
import { RunError, run } from "./run.js";
import type { ProjectRecord, Settings } from "./types.js";
import { assertAcmeEmail } from "./validate.js";

const SYSTEM_CADDYFILE = "/etc/caddy/Caddyfile";
const SYSTEM_SNIPPET = "/etc/caddy/hosting.caddy";
const HOSTING_BEGIN = "# BEGIN hosting";
const HOSTING_END = "# END hosting";

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

/** Site blocks only. The system Caddyfile imports this file, so it must not contain a global options block. */
export function renderHostingSnippet(projects: ProjectRecord[]): string {
  const lines: string[] = [
    "# Hosting sites. Imported by /etc/caddy/Caddyfile.",
    "# Change domains in Hosting; this file is rewritten on sync.",
    "",
  ];

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
    lines.push("# No domains yet.");
    lines.push("");
  }

  return lines.join("\n");
}

export function hostingImportBlock(importPath: string): string {
  return [
    HOSTING_BEGIN,
    "# Managed by Hosting. Sites live in /etc/caddy/hosting.caddy.",
    `import ${importPath}`,
    HOSTING_END,
  ].join("\n");
}

/** Keep every other site (Bearmail included). Add or replace only the Hosting import. */
export function upsertHostingImport(existing: string, importPath: string): string {
  const block = hostingImportBlock(importPath);
  const region = /# BEGIN hosting\r?\n[\s\S]*?# END hosting/;
  if (region.test(existing)) return existing.replace(region, block);

  const importLine = `import ${importPath}`;
  if (existing.split("\n").some((line) => line.trim() === importLine)) return existing;

  const base = existing.replace(/\s*$/, "");
  return `${base.length ? `${base}\n\n` : ""}${block}\n`;
}

/** Put the ACME email in the global options block. Leave the block alone when email is empty. */
export function ensureAcmeEmail(source: string, email: string): string {
  const trimmed = assertAcmeEmail(email);
  if (!trimmed) return source;

  const lines = source.split("\n");
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trim().startsWith("#"))) {
    start++;
  }
  if (start < lines.length && lines[start].trim() === "{") {
    let depth = 0;
    let end = start;
    for (; end < lines.length; end++) {
      const token = lines[end].trim();
      if (token === "{") depth++;
      else if (token === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (end >= lines.length || depth !== 0) return source;
    const block = lines.slice(start, end + 1);
    const emailLine = block.findIndex((line) => /^\s*email\s+/.test(line));
    if (emailLine === -1) block.splice(block.length - 1, 0, `\temail ${trimmed}`);
    else block[emailLine] = `\temail ${trimmed}`;
    return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join("\n");
  }

  return `{\n\temail ${trimmed}\n}\n\n${source}`;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function validateMerged(existing: string, snippet: string, email: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hosting-caddy-"));
  try {
    const tempSnippet = path.join(dir, "hosting.caddy");
    const tempMain = path.join(dir, "Caddyfile");
    await fs.writeFile(tempSnippet, snippet, "utf8");
    const merged = upsertHostingImport(ensureAcmeEmail(existing, email), tempSnippet);
    await fs.writeFile(tempMain, merged, "utf8");
    await run("caddy", ["validate", "--config", tempMain, "--adapter", "caddyfile"]);
  } catch (err) {
    if (err instanceof RunError) {
      const detail = err.stderr.trim() || err.stdout.trim() || err.message;
      throw new Error(`Caddy rejected the config: ${detail}`);
    }
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Reuse the Caddy Bearmail already installed. Hosting writes /etc/caddy/hosting.caddy
 * and an import block in /etc/caddy/Caddyfile. It does not replace other site blocks.
 */
export async function syncCaddy(projects: ProjectRecord[], settings: Settings): Promise<void> {
  const snippet = renderHostingSnippet(projects);
  const existing = await readIfExists(SYSTEM_CADDYFILE);
  const merged = upsertHostingImport(ensureAcmeEmail(existing, settings.acmeEmail), SYSTEM_SNIPPET);

  const localSnippet = caddySnippetPath();
  await ensureDir(path.dirname(localSnippet));
  await fs.writeFile(localSnippet, snippet, "utf8");

  const currentSnippet = await readIfExists(SYSTEM_SNIPPET);
  if (currentSnippet === snippet && existing === merged) return;

  await validateMerged(existing, snippet, settings.acmeEmail);

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "hosting-caddy-install-"));
  try {
    const snippetFile = path.join(stage, "hosting.caddy");
    const mainFile = path.join(stage, "Caddyfile");
    await fs.writeFile(snippetFile, snippet, "utf8");
    await fs.writeFile(mainFile, merged, "utf8");
    await run("sudo", ["mkdir", "-p", "/etc/caddy"]);
    await run("sudo", ["cp", snippetFile, SYSTEM_SNIPPET]);
    await run("sudo", ["chmod", "644", SYSTEM_SNIPPET]);
    await run("sudo", ["cp", mainFile, SYSTEM_CADDYFILE]);
    await run("sudo", ["chmod", "644", SYSTEM_CADDYFILE]);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }

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
