import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rel = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, rel);
  const relToRoot = path.relative(root, resolved);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
  return resolved;
}

function sendFile(res: http.ServerResponse, file: string, status = 200): void {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(status, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
    },
  });

  const root = path.resolve(values.root || ".");
  const port = Number(values.port);
  const host = values.host || "127.0.0.1";
  if (!port) {
    console.error("static-server: --port is required");
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const urlPath = req.url || "/";
    const target = safeJoin(root, urlPath);
    if (!target) {
      res.writeHead(400).end("Bad request");
      return;
    }

    const finish = (file: string, status = 200) => {
      fs.stat(file, (err, st) => {
        if (!err && st.isFile()) {
          sendFile(res, file, status);
          return;
        }
        const index = path.join(root, "index.html");
        fs.stat(index, (idxErr, idxSt) => {
          if (!idxErr && idxSt.isFile()) {
            sendFile(res, index);
            return;
          }
          res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        });
      });
    };

    fs.stat(target, (err, st) => {
      if (!err && st.isDirectory()) {
        finish(path.join(target, "index.html"));
        return;
      }
      if (!err && st.isFile()) {
        sendFile(res, target);
        return;
      }
      finish(target);
    });
  });

  server.listen(port, host, () => {
    console.log(`static-server ${host}:${port} -> ${root}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
