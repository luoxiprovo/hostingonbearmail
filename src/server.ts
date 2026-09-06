import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, errorHandler } from "./api.js";
import { syncCaddy } from "./lib/caddy.js";
import { startAutoDeployPoller } from "./lib/auto-deploy.js";
import { resumeRunningProjects } from "./lib/deploy.js";
import { stopProject } from "./lib/process-manager.js";
import { getSettings, initStore, listRecords } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startServer(): Promise<void> {
  await initStore();
  const settings = getSettings();
  try {
    await syncCaddy(listRecords(), settings);
  } catch (err) {
    console.warn("Caddy sync failed (is Caddy installed?):", err instanceof Error ? err.message : err);
  }
  await resumeRunningProjects();
  startAutoDeployPoller();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", createApi());
  app.use(errorHandler);

  const webDir = path.resolve(__dirname, "../web/dist");
  app.use(express.static(webDir));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(webDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  const host = process.env.HOSTING_HOST || settings.bindHost || "127.0.0.1";
  const port = Number(process.env.HOSTING_PORT || settings.bindPort || 8787);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Hosting dashboard http://${host}:${port}`);
      resolve();
    });
    server.on("error", reject);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, stopping projects...`);
    for (const record of listRecords()) {
      if (record.pid) {
        try {
          await stopProject(record.name, { keepStatus: true });
        } catch {
          /* ignore */
        }
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
