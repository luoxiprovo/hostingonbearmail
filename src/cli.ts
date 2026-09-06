#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer } from "./server.js";
import { getSettings, initStore } from "./lib/store.js";

const DEFAULT_URL = `http://${process.env.HOSTING_HOST || "127.0.0.1"}:${process.env.HOSTING_PORT || 8787}`;

function usage(): string {
  return `Hosting — deploy GitHub repos on this server

Usage:
  hosting serve                         Start the dashboard (127.0.0.1:8787)
  hosting list                          List projects
  hosting add <name> --repo <url>       Create + clone a project
      --type static|node
      --domain example.com
      --branch main
      --token <github_pat>
      --port 4101
      --build "npm run build"
      --start "npm start"
      --out dist
  hosting deploy <name>                 Pull, build, and start
  hosting start <name>
  hosting stop <name>
  hosting delete <name>
  hosting rename <old> <new>
  hosting logs <name> [--kind deploy|runtime]
  hosting env <name>                    Print .env
  hosting env <name> --set              Read .env from stdin
  hosting status
  hosting doctor
`;
}

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const base = process.env.HOSTING_URL || DEFAULT_URL;
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const err = (body as { error?: string }).error || res.statusText;
    throw new Error(err);
  }
  return body as T;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "serve") {
    await startServer();
    await new Promise(() => undefined);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      repo: { type: "string" },
      type: { type: "string" },
      domain: { type: "string" },
      branch: { type: "string" },
      token: { type: "string" },
      port: { type: "string" },
      build: { type: "string" },
      start: { type: "string" },
      out: { type: "string" },
      kind: { type: "string" },
      set: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const name = positionals[0];

  switch (command) {
    case "list": {
      const projects = await api<Array<{
        name: string;
        type: string;
        port: number;
        domain: string;
        status: string;
      }>>("/api/projects");
      if (projects.length === 0) {
        console.log("No projects yet. Try: hosting add myapp --repo https://github.com/org/repo --type static");
        return;
      }
      const rows = [
        ["NAME", "TYPE", "PORT", "DOMAIN", "STATUS"],
        ...projects.map((p) => [
          p.name,
          p.type,
          String(p.port),
          p.domain || "-",
          p.status,
        ]),
      ];
      const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
      for (const row of rows) {
        console.log(row.map((cell, i) => cell.padEnd(widths[i] + 2)).join(""));
      }
      return;
    }
    case "add": {
      if (!name || !values.repo) throw new Error("usage: hosting add <name> --repo <url>");
      const project = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          gitUrl: values.repo,
          type: values.type || "static",
          domain: values.domain || "",
          branch: values.branch || "",
          gitToken: values.token || "",
          port: values.port ? Number(values.port) : undefined,
          buildCommand: values.build || "",
          startCommand: values.start || "",
          outputDir: values.out || "",
        }),
      });
      console.log("Created. Cloning in the background.");
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    case "deploy":
      if (!name) throw new Error("usage: hosting deploy <name>");
      await api(`/api/projects/${encodeURIComponent(name)}/deploy`, { method: "POST" });
      console.log(`Deploy started for ${name}. Watch: hosting logs ${name}`);
      return;
    case "start":
      if (!name) throw new Error("usage: hosting start <name>");
      console.log(JSON.stringify(await api(`/api/projects/${encodeURIComponent(name)}/start`, { method: "POST" }), null, 2));
      return;
    case "stop":
      if (!name) throw new Error("usage: hosting stop <name>");
      console.log(JSON.stringify(await api(`/api/projects/${encodeURIComponent(name)}/stop`, { method: "POST" }), null, 2));
      return;
    case "delete":
      if (!name) throw new Error("usage: hosting delete <name>");
      await api(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
      console.log(`Deleted ${name}`);
      return;
    case "rename": {
      const nextName = positionals[1];
      if (!name || !nextName) throw new Error("usage: hosting rename <old> <new>");
      const project = await api(`/api/projects/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName }),
      });
      console.log(`Renamed ${name} → ${nextName}`);
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    case "logs": {
      if (!name) throw new Error("usage: hosting logs <name> [--kind deploy|runtime]");
      const kind = values.kind === "runtime" ? "runtime" : "deploy";
      const { content } = await api<{ content: string }>(
        `/api/projects/${encodeURIComponent(name)}/logs?kind=${kind}`,
      );
      process.stdout.write(content || "(empty)\n");
      return;
    }
    case "env": {
      if (!name) throw new Error("usage: hosting env <name> [--set]");
      if (values.set) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const content = Buffer.concat(chunks).toString("utf8");
        await api(`/api/projects/${encodeURIComponent(name)}/env`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        });
        console.log("Saved .env");
        return;
      }
      const { content } = await api<{ content: string }>(
        `/api/projects/${encodeURIComponent(name)}/env`,
      );
      process.stdout.write(content);
      if (content && !content.endsWith("\n")) process.stdout.write("\n");
      return;
    }
    case "status": {
      const health = await api<Record<string, unknown>>("/api/health");
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    case "doctor": {
      await initStore();
      const settings = getSettings();
      const checks: Array<[string, boolean, string]> = [];
      const has = async (cmd: string) => {
        try {
          const { run } = await import("./lib/run.js");
          await run(cmd, ["--version"]);
          return true;
        } catch {
          try {
            const { run } = await import("./lib/run.js");
            await run(cmd, ["version"]);
            return true;
          } catch {
            return false;
          }
        }
      };
      checks.push(["git", await has("git"), "required to clone repos"]);
      checks.push(["node", await has("node"), "required"]);
      checks.push(["pnpm", await has("pnpm"), "needed for pnpm-lock.yaml repos"]);
      checks.push(["caddy", await has("caddy"), "required for domains / HTTPS"]);
      let apiUp = false;
      try {
        await api("/api/health");
        apiUp = true;
      } catch {
        apiUp = false;
      }
      checks.push(["dashboard", apiUp, `http://${settings.bindHost}:${settings.bindPort}`]);
      for (const [label, ok, note] of checks) {
        console.log(`${ok ? "ok " : "NO "}  ${label.padEnd(12)} ${note}`);
      }
      if (!apiUp) console.log("\nStart the control plane with: hosting serve");
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
