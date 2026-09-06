import { useEffect, useState } from "react";
import { api, type Health, type Project, type Settings } from "./api";

type View =
  | { page: "home" }
  | { page: "new" }
  | { page: "project"; name: string };

function parseHash(): View {
  const hash = location.hash.replace(/^#/, "") || "/";
  if (hash === "/new") return { page: "new" };
  const m = hash.match(/^\/p\/([^/]+)$/);
  if (m) return { page: "project", name: decodeURIComponent(m[1]) };
  return { page: "home" };
}

export function App() {
  const [view, setView] = useState<View>(parseHash);
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string>("");

  const go = (next: View) => {
    if (next.page === "home") location.hash = "/";
    if (next.page === "new") location.hash = "/new";
    if (next.page === "project") location.hash = `/p/${encodeURIComponent(next.name)}`;
    setView(next);
  };

  const refresh = async () => {
    try {
      const [list, h] = await Promise.all([api.projects(), api.health()]);
      setProjects(list);
      setHealth(h);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="mark" />
          <h1>
            Hosting
            <span>this machine</span>
          </h1>
        </div>
        <div className="rail-actions">
          <button className="btn primary" style={{ width: "100%" }} onClick={() => go({ page: "new" })}>
            New project
          </button>
        </div>
        <div className="list">
          <div className="list-label">Projects</div>
          {projects.length === 0 && <div className="empty-rail">None yet.</div>}
          {projects.map((p) => (
            <button
              key={p.name}
              className={`item ${view.page === "project" && view.name === p.name ? "active" : ""}`}
              onClick={() => go({ page: "project", name: p.name })}
            >
              <span className={`dot ${p.status}`} />
              <span>{p.name}</span>
              <span className="meta">{p.port}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">
          <div>Dashboard {health?.bind ?? "127.0.0.1:8787"}</div>
          <div className="health-row">
            <span>Caddy {health?.caddy.active ? "active" : health?.caddy.installed ? "down" : "missing"}</span>
            <SettingsLink />
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="frame">
          {error && <div className="error-banner">{error}</div>}
          {view.page === "home" && <Home go={go} />}
          {view.page === "new" && <NewProject go={go} />}
          {view.page === "project" && (
            <ProjectDetail name={view.name} project={projects.find((p) => p.name === view.name)} go={go} />
          )}
        </div>
      </main>
    </div>
  );
}

function SettingsLink() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    const s = await api.settings();
    setSettings(s);
    setEmail(s.acmeEmail);
  };

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Settings
      </button>
      {open && (
        <div className="modal-back" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 8px" }}>Let’s Encrypt</h3>
            <p className="help">Optional email for HTTPS certificates. Point DNS at this server first.</p>
            <label className="field">
              ACME email
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {settings && (
              <p className="help" style={{ marginTop: 12 }}>
                Ports start at {settings.portRangeStart}. Dashboard binds {settings.bindHost}:{settings.bindPort}.
              </p>
            )}
            {msg && <div className="flash">{msg}</div>}
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await api.saveSettings({ acmeEmail: email });
                  setMsg("Saved.");
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Home({ go }: { go: (v: View) => void }) {
  return (
    <div className="welcome">
      <h2>Put a GitHub repo on this server.</h2>
      <p>
        Clone into a local folder, add a <code>.env</code>, deploy on a port, and map a domain through Caddy.
        The dashboard only listens on localhost.
      </p>
      <ol className="steps">
        <li>
          <span className="num">1</span>
          <span>Add a project with a clone URL. Hosting copies the repo into <code>hosting-data/projects/&lt;name&gt;/repo</code>.</span>
        </li>
        <li>
          <span className="num">2</span>
          <span>Edit <code>.env</code> on the project page if the app needs secrets or public URLs.</span>
        </li>
        <li>
          <span className="num">3</span>
          <span>Hit Deploy. Static apps are built and served; Node apps are started with <code>PORT</code> set.</span>
        </li>
      </ol>
      <div style={{ marginTop: 22 }}>
        <button className="btn primary" onClick={() => go({ page: "new" })}>
          New project
        </button>
      </div>
    </div>
  );
}

function NewProject({ go }: { go: (v: View) => void }) {
  const [form, setForm] = useState({
    name: "",
    gitUrl: "",
    gitToken: "",
    branch: "",
    domain: "",
    type: "static",
    port: "",
    buildCommand: "",
    startCommand: "",
    outputDir: "",
    autoDeploy: false,
    autoDeployIntervalMin: "5",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div>
      <div className="hero">
        <div>
          <h2>New project</h2>
          <p>Submit clones the repo. Deploy is a separate step after that.</p>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const created = await api.create({
              ...form,
              port: form.port ? Number(form.port) : undefined,
              autoDeploy: form.autoDeploy,
              autoDeployIntervalMin: Number(form.autoDeployIntervalMin) || 5,
            });
            go({ page: "project", name: created.name });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label className="field">
            Name
            <input required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="landing" />
          </label>
          <label className="field">
            Type
            <select value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="static">Static (build + serve dist/out)</option>
              <option value="node">Node (long-lived process)</option>
            </select>
          </label>
          <label className="field span2">
            Git clone URL
            <input
              required
              value={form.gitUrl}
              onChange={(e) => set("gitUrl", e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </label>
          <label className="field">
            GitHub token (private repos)
            <input
              type="password"
              value={form.gitToken}
              onChange={(e) => set("gitToken", e.target.value)}
              placeholder="optional PAT"
            />
          </label>
          <label className="field">
            Branch
            <input value={form.branch} onChange={(e) => set("branch", e.target.value)} placeholder="default branch" />
          </label>
          <label className="field">
            Domain
            <input
              value={form.domain}
              onChange={(e) => set("domain", e.target.value)}
              placeholder="app.example.com"
            />
          </label>
          <label className="field">
            Port
            <input value={form.port} onChange={(e) => set("port", e.target.value)} placeholder="auto" />
          </label>
          <label className="field">
            Build command
            <input
              value={form.buildCommand}
              onChange={(e) => set("buildCommand", e.target.value)}
              placeholder="auto (npm run build)"
            />
          </label>
          <label className="field">
            Start command
            <input
              value={form.startCommand}
              onChange={(e) => set("startCommand", e.target.value)}
              placeholder={form.type === "node" ? "auto (npm start)" : "unused for static"}
            />
          </label>
          <label className="field span2">
            Static output directory
            <input
              value={form.outputDir}
              onChange={(e) => set("outputDir", e.target.value)}
              placeholder="auto (dist, out, build)"
            />
          </label>
          <label className="field check span2">
            <input
              type="checkbox"
              checked={form.autoDeploy}
              onChange={(e) => setForm((f) => ({ ...f, autoDeploy: e.target.checked }))}
            />
            Auto-deploy when GitHub has a new commit
          </label>
          {form.autoDeploy && (
            <label className="field">
              Poll every (minutes)
              <input
                type="number"
                min={1}
                max={1440}
                value={form.autoDeployIntervalMin}
                onChange={(e) => set("autoDeployIntervalMin", e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={() => go({ page: "home" })}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Cloning…" : "Submit & clone"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProjectDetail({
  name,
  project,
  go,
}: {
  name: string;
  project?: Project;
  go: (v: View) => void;
}) {
  const [env, setEnv] = useState("");
  const [envSaved, setEnvSaved] = useState("");
  const [kind, setKind] = useState<"deploy" | "runtime">("deploy");
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    domain: "",
    port: "",
    branch: "",
    gitUrl: "",
    gitToken: "",
    type: "static",
    buildCommand: "",
    startCommand: "",
    outputDir: "",
    autoDeploy: false,
    autoDeployIntervalMin: "5",
  });

  useEffect(() => {
    if (!project) return;
    setDraft({
      name: project.name,
      domain: project.domain,
      port: String(project.port),
      branch: project.branch,
      gitUrl: project.gitUrl,
      gitToken: "",
      type: project.type,
      buildCommand: project.buildCommand,
      startCommand: project.startCommand,
      outputDir: project.outputDir,
      autoDeploy: Boolean(project.autoDeploy),
      autoDeployIntervalMin: String(project.autoDeployIntervalMin || 5),
    });
  }, [project?.name, project?.updatedAt]);

  useEffect(() => {
    void api.env(name).then((r) => setEnv(r.content)).catch(() => undefined);
  }, [name]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.logs(name, kind);
        if (live) setLog(r.content);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [name, kind]);

  const busyStatus = project && (project.status === "cloning" || project.status === "building");

  const action = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  if (!project) {
    return (
      <div>
        <h2>{name}</h2>
        <p className="help">Loading or missing.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="hero">
        <div>
          <h2>{project.name}</h2>
          <p>
            {project.type} · 127.0.0.1:{project.port}
            {project.domain ? ` · ${project.domain}` : ""}
          </p>
        </div>
        <div className="row">
          <span className={`badge ${project.status}`}>
            <span className={`dot ${project.status}`} />
            {project.status}
          </span>
          <button
            className="btn primary"
            disabled={Boolean(busy) || Boolean(busyStatus)}
            onClick={() => action("deploy", () => api.deploy(project.name))}
          >
            {busy === "deploy" || project.status === "building" ? "Deploying…" : "Deploy"}
          </button>
          {project.status === "running" ? (
            <button className="btn" disabled={Boolean(busy)} onClick={() => action("stop", () => api.stop(project.name))}>
              Stop
            </button>
          ) : (
            <button className="btn" disabled={Boolean(busy) || Boolean(busyStatus)} onClick={() => action("start", () => api.start(project.name))}>
              Start
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {project.lastError && project.status === "error" && (
        <div className="error-banner">{project.lastError}</div>
      )}

      <div className="grid">
        <div className="card">
          <h3>Repo</h3>
          <dl className="kv">
            <dt>Git</dt>
            <dd>{project.gitUrl}</dd>
            <dt>Branch</dt>
            <dd>{project.branch || "default"}</dd>
            <dt>Token</dt>
            <dd>{project.gitTokenSet ? "set" : "none"}</dd>
            <dt>Last deploy</dt>
            <dd>{project.lastDeployAt ? new Date(project.lastDeployAt).toLocaleString() : "—"}</dd>
            <dt>Auto-deploy</dt>
            <dd>
              {project.autoDeploy
                ? `on, every ${project.autoDeployIntervalMin || 5} min`
                : "off"}
            </dd>
            <dt>Last check</dt>
            <dd>
              {project.lastAutoCheckAt ? new Date(project.lastAutoCheckAt).toLocaleString() : "—"}
            </dd>
            <dt>Folder</dt>
            <dd>hosting-data/projects/{project.name}/</dd>
          </dl>
        </div>
        <div className="card">
          <h3>Settings</h3>
          <div className="form-grid">
            <label className="field span2">
              Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <p className="help" style={{ gridColumn: "1 / -1", margin: "-4px 0 4px" }}>
              Lowercase letters, numbers, hyphens. Renames the local folder. Not allowed while cloning or deploying.
            </p>
            <label className="field">
              Domain
              <input value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
            </label>
            <label className="field">
              Port
              <input value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
            </label>
            <label className="field span2">
              Git URL
              <input value={draft.gitUrl} onChange={(e) => setDraft({ ...draft, gitUrl: e.target.value })} />
            </label>
            <label className="field">
              Branch
              <input value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} />
            </label>
            <label className="field">
              Type
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                <option value="static">static</option>
                <option value="node">node</option>
              </select>
            </label>
            <label className="field">
              Build
              <input value={draft.buildCommand} onChange={(e) => setDraft({ ...draft, buildCommand: e.target.value })} />
            </label>
            <label className="field">
              Start
              <input value={draft.startCommand} onChange={(e) => setDraft({ ...draft, startCommand: e.target.value })} />
            </label>
            <label className="field span2">
              Output dir
              <input value={draft.outputDir} onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })} placeholder="dist" />
            </label>
            <label className="field span2">
              GitHub token
              <input
                type="password"
                value={draft.gitToken}
                onChange={(e) => setDraft({ ...draft, gitToken: e.target.value })}
                placeholder={project.gitTokenSet ? "leave blank to keep" : "optional"}
              />
            </label>
            <label className="field check span2">
              <input
                type="checkbox"
                checked={draft.autoDeploy}
                onChange={(e) => setDraft({ ...draft, autoDeploy: e.target.checked })}
              />
              Auto-deploy when GitHub has a new commit
            </label>
            {draft.autoDeploy && (
              <label className="field">
                Poll every (minutes)
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.autoDeployIntervalMin}
                  onChange={(e) => setDraft({ ...draft, autoDeployIntervalMin: e.target.value })}
                />
              </label>
            )}
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <button
              className="btn danger"
              onClick={() => {
                if (!confirm(`Delete ${project.name}? This removes the local folder.`)) return;
                void action("delete", async () => {
                  await api.remove(project.name);
                  go({ page: "home" });
                });
              }}
            >
              Delete
            </button>
            <button
              className="btn"
              onClick={() =>
                action("save", async () => {
                  const updated = await api.update(project.name, {
                    name: draft.name,
                    domain: draft.domain,
                    port: Number(draft.port),
                    branch: draft.branch,
                    gitUrl: draft.gitUrl,
                    type: draft.type,
                    buildCommand: draft.buildCommand,
                    startCommand: draft.startCommand,
                    outputDir: draft.outputDir,
                    autoDeploy: draft.autoDeploy,
                    autoDeployIntervalMin: Number(draft.autoDeployIntervalMin) || 5,
                    ...(draft.gitToken ? { gitToken: draft.gitToken } : {}),
                  });
                  if (updated.name !== project.name) {
                    go({ page: "project", name: updated.name });
                  }
                })
              }
            >
              Save settings
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>.env</h3>
        <p className="help">
          Stored at <code>hosting-data/projects/{project.name}/.env</code> and copied into the repo on deploy.
        </p>
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          {envSaved && <span className="flash">{envSaved}</span>}
          <button
            className="btn"
            onClick={() =>
              action("env", async () => {
                await api.saveEnv(project.name, env);
                setEnvSaved("Saved");
                setTimeout(() => setEnvSaved(""), 1500);
              })
            }
          >
            Save .env
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Logs</h3>
        <div className="tabs">
          <button className={`tab ${kind === "deploy" ? "on" : ""}`} onClick={() => setKind("deploy")}>
            Deploy
          </button>
          <button className={`tab ${kind === "runtime" ? "on" : ""}`} onClick={() => setKind("runtime")}>
            Runtime
          </button>
        </div>
        <pre className="log">{log || "No log output yet."}</pre>
      </div>
    </div>
  );
}
