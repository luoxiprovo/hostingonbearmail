import { Router } from "express";
import fs from "node:fs/promises";
import { syncCaddy, caddyStatus } from "./lib/caddy.js";
import { cloneProject, deployProject } from "./lib/deploy.js";
import { renameProject } from "./lib/rename.js";
import { readLogTail, type LogKind } from "./lib/logs.js";
import { envFilePath, projectDir, repoDir } from "./lib/paths.js";
import { startProject, stopProject } from "./lib/process-manager.js";
import {
  allocatePort,
  getRecord,
  getSettings,
  listRecords,
  removeRecord,
  saveSettings,
  upsertRecord,
} from "./lib/store.js";
import {
  DEFAULT_AUTO_DEPLOY_INTERVAL_MIN,
  publicProject,
  type ProjectRecord,
} from "./lib/types.js";
import {
  HttpError,
  assertAutoDeployIntervalMin,
  assertDomain,
  assertGitUrl,
  assertName,
  assertType,
} from "./lib/validate.js";

function nowIso(): string {
  return new Date().toISOString();
}

function projectName(req: { params: { name?: string } }): string {
  return String(req.params.name || "");
}

function busy(record: ProjectRecord): boolean {
  return record.status === "cloning" || record.status === "building";
}

export function createApi(): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const caddy = await caddyStatus();
    res.json({
      ok: true,
      bind: `${getSettings().bindHost}:${getSettings().bindPort}`,
      caddy,
      projects: listRecords().length,
    });
  });

  router.get("/settings", (_req, res) => {
    res.json(getSettings());
  });

  router.patch("/settings", async (req, res, next) => {
    try {
      const patch: { acmeEmail?: string } = {};
      if (typeof req.body?.acmeEmail === "string") patch.acmeEmail = req.body.acmeEmail.trim();
      const settings = await saveSettings(patch);
      await syncCaddy(listRecords(), settings);
      res.json(settings);
    } catch (err) {
      next(err);
    }
  });

  router.get("/projects", (_req, res) => {
    res.json(listRecords().map(publicProject));
  });

  router.post("/projects", async (req, res, next) => {
    try {
      const name = assertName(String(req.body?.name ?? ""));
      if (getRecord(name)) throw new HttpError(409, `Project ${name} already exists`);
      const gitUrl = assertGitUrl(String(req.body?.gitUrl ?? ""));
      const type = assertType(String(req.body?.type ?? "static"));
      const domain = assertDomain(String(req.body?.domain ?? ""));
      if (domain && listRecords().some((p) => p.domain === domain)) {
        throw new HttpError(409, `Domain ${domain} is already mapped to another project`);
      }
      const port = allocatePort(
        req.body?.port !== undefined && req.body?.port !== ""
          ? Number(req.body.port)
          : undefined,
      );
      if (listRecords().some((p) => p.port === port)) {
        throw new HttpError(409, `Port ${port} is already in use`);
      }

      const record: ProjectRecord = {
        name,
        gitUrl,
        gitToken: typeof req.body?.gitToken === "string" ? req.body.gitToken.trim() : "",
        gitTokenSet: false,
        branch: typeof req.body?.branch === "string" ? req.body.branch.trim() : "",
        domain,
        port,
        type,
        buildCommand: typeof req.body?.buildCommand === "string" ? req.body.buildCommand.trim() : "",
        startCommand: typeof req.body?.startCommand === "string" ? req.body.startCommand.trim() : "",
        outputDir: typeof req.body?.outputDir === "string" ? req.body.outputDir.trim() : "",
        autoDeploy: Boolean(req.body?.autoDeploy),
        autoDeployIntervalMin:
          req.body?.autoDeployIntervalMin !== undefined && req.body?.autoDeployIntervalMin !== ""
            ? assertAutoDeployIntervalMin(req.body.autoDeployIntervalMin)
            : DEFAULT_AUTO_DEPLOY_INTERVAL_MIN,
        lastDeploySha: null,
        lastAutoCheckAt: null,
        lastAutoAttemptSha: null,
        status: "cloning",
        lastDeployAt: null,
        lastError: null,
        pid: null,
        runtimeCommand: null,
        runtimeRoot: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      record.gitTokenSet = Boolean(record.gitToken);
      await upsertRecord(record);
      const { ensureProjectLayout } = await import("./lib/paths.js");
      await ensureProjectLayout(name);
      await syncCaddy(listRecords(), getSettings());
      res.status(201).json(publicProject(record));
      void cloneProject(name).catch((err) => {
        console.error(`clone ${name}:`, err);
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/projects/:name", (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      res.json(publicProject(record));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/projects/:name", async (req, res, next) => {
    try {
      let record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      const body = req.body ?? {};
      if (typeof body.name === "string" && body.name.trim()) {
        record = await renameProject(record.name, body.name);
      }
      if (typeof body.gitUrl === "string") record.gitUrl = assertGitUrl(body.gitUrl);
      if (typeof body.gitToken === "string") {
        record.gitToken = body.gitToken.trim();
        record.gitTokenSet = Boolean(record.gitToken);
      }
      if (typeof body.branch === "string") record.branch = body.branch.trim();
      if (typeof body.domain === "string") {
        const domain = assertDomain(body.domain);
        if (domain && listRecords().some((p) => p.domain === domain && p.name !== record.name)) {
          throw new HttpError(409, `Domain ${domain} is already mapped to another project`);
        }
        record.domain = domain;
      }
      if (typeof body.type === "string") record.type = assertType(body.type);
      if (typeof body.buildCommand === "string") record.buildCommand = body.buildCommand.trim();
      if (typeof body.startCommand === "string") record.startCommand = body.startCommand.trim();
      if (typeof body.outputDir === "string") record.outputDir = body.outputDir.trim();
      if (typeof body.autoDeploy === "boolean") {
        if (body.autoDeploy && !record.autoDeploy) {
          record.lastAutoCheckAt = null;
          record.lastAutoAttemptSha = null;
        }
        record.autoDeploy = body.autoDeploy;
      }
      if (body.autoDeployIntervalMin !== undefined && body.autoDeployIntervalMin !== "") {
        record.autoDeployIntervalMin = assertAutoDeployIntervalMin(body.autoDeployIntervalMin);
      }
      if (body.port !== undefined && body.port !== "") {
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new HttpError(400, "Port must be an integer between 1024 and 65535");
        }
        if (listRecords().some((p) => p.port === port && p.name !== record.name)) {
          throw new HttpError(409, `Port ${port} is already in use`);
        }
        record.port = port;
      }
      record.updatedAt = nowIso();
      await upsertRecord(record);
      await syncCaddy(listRecords(), getSettings());
      res.json(publicProject(record));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/projects/:name", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      if (busy(record)) throw new HttpError(409, "Project is busy; wait for clone/deploy to finish");
      await stopProject(record.name);
      await fs.rm(projectDir(record.name), { recursive: true, force: true });
      await removeRecord(record.name);
      await syncCaddy(listRecords(), getSettings());
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/projects/:name/deploy", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      if (busy(record)) throw new HttpError(409, "Project is already cloning or deploying");
      res.status(202).json({ ok: true });
      void deployProject(record.name).catch((err) => {
        console.error(`deploy ${record.name}:`, err);
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/projects/:name/stop", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      await stopProject(record.name);
      res.json(publicProject(getRecord(record.name)!));
    } catch (err) {
      next(err);
    }
  });

  router.post("/projects/:name/start", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      if (busy(record)) throw new HttpError(409, "Project is busy");
      const command = record.runtimeCommand || record.startCommand || (record.type === "node" ? "npm start" : "");
      const cwd = record.runtimeRoot || repoDir(record.name);
      if (!command) {
        throw new HttpError(409, "Deploy this project once before starting it");
      }
      await startProject(record, command, cwd);
      res.json(publicProject(getRecord(record.name)!));
    } catch (err) {
      next(err);
    }
  });

  router.get("/projects/:name/logs", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      const kind = (String(req.query.kind || "deploy") as LogKind) === "runtime" ? "runtime" : "deploy";
      const content = await readLogTail(record.name, kind);
      res.json({ kind, content });
    } catch (err) {
      next(err);
    }
  });

  router.get("/projects/:name/env", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      const content = await fs.readFile(envFilePath(record.name), "utf8").catch(() => "");
      res.json({ content });
    } catch (err) {
      next(err);
    }
  });

  router.put("/projects/:name/env", async (req, res, next) => {
    try {
      const record = getRecord(projectName(req));
      if (!record) throw new HttpError(404, "Project not found");
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      await fs.writeFile(envFilePath(record.name), content, "utf8");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return router;
}

export function errorHandler(
  err: unknown,
  _req: import("express").Request,
  res: import("express").Response,
  _next: import("express").NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  res.status(500).json({ error: message });
}
