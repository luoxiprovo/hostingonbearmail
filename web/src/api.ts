export type ProjectType = "static" | "node";
export type ProjectStatus = "idle" | "cloning" | "building" | "running" | "stopped" | "error";

export interface Project {
  name: string;
  gitUrl: string;
  gitTokenSet: boolean;
  branch: string;
  domain: string;
  port: number;
  type: ProjectType;
  buildCommand: string;
  startCommand: string;
  outputDir: string;
  autoDeploy: boolean;
  autoDeployIntervalMin: number;
  lastDeploySha: string | null;
  lastAutoCheckAt: string | null;
  status: ProjectStatus;
  lastDeployAt: string | null;
  lastError: string | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Health {
  ok: boolean;
  bind: string;
  caddy: { installed: boolean; active: boolean; version: string };
  projects: number;
}

export interface Settings {
  acmeEmail: string;
  bindHost: string;
  bindPort: number;
  portRangeStart: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  projects: () => request<Project[]>("/api/projects"),
  project: (name: string) => request<Project>(`/api/projects/${encodeURIComponent(name)}`),
  create: (body: Record<string, unknown>) =>
    request<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  update: (name: string, body: Record<string, unknown>) =>
    request<Project>(`/api/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (name: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" }),
  deploy: (name: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(name)}/deploy`, { method: "POST" }),
  start: (name: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(name)}/start`, { method: "POST" }),
  stop: (name: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(name)}/stop`, { method: "POST" }),
  logs: (name: string, kind: "deploy" | "runtime") =>
    request<{ kind: string; content: string }>(
      `/api/projects/${encodeURIComponent(name)}/logs?kind=${kind}`,
    ),
  env: (name: string) =>
    request<{ content: string }>(`/api/projects/${encodeURIComponent(name)}/env`),
  saveEnv: (name: string, content: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(name)}/env`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
};
