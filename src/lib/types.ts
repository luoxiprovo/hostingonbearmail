export type ProjectType = "static" | "node";

export type ProjectStatus =
  | "idle"
  | "cloning"
  | "building"
  | "running"
  | "stopped"
  | "error";

export const DEFAULT_AUTO_DEPLOY_INTERVAL_MIN = 5;
export const MIN_AUTO_DEPLOY_INTERVAL_MIN = 1;
export const MAX_AUTO_DEPLOY_INTERVAL_MIN = 1440;

export interface DnsRecord {
  type: "A" | "AAAA";
  name: string;
  value: string;
}

export interface ProjectDns {
  ipv4: string | null;
  ipv6: string | null;
  records: DnsRecord[];
}

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
  runtimeCommand: string | null;
  runtimeRoot: string | null;
  createdAt: string;
  updatedAt: string;
  dns?: ProjectDns;
}

export interface ProjectRecord extends Project {
  gitToken: string;
  lastAutoAttemptSha: string | null;
}

export function normalizeRecord(record: ProjectRecord): ProjectRecord {
  const interval = Number(record.autoDeployIntervalMin);
  const validInterval =
    Number.isInteger(interval) &&
    interval >= MIN_AUTO_DEPLOY_INTERVAL_MIN &&
    interval <= MAX_AUTO_DEPLOY_INTERVAL_MIN;
  return {
    ...record,
    autoDeploy: Boolean(record.autoDeploy),
    autoDeployIntervalMin: validInterval ? interval : DEFAULT_AUTO_DEPLOY_INTERVAL_MIN,
    lastDeploySha: record.lastDeploySha || null,
    lastAutoCheckAt: record.lastAutoCheckAt || null,
    lastAutoAttemptSha: record.lastAutoAttemptSha || null,
  };
}

export interface Settings {
  acmeEmail: string;
  bindHost: string;
  bindPort: number;
  portRangeStart: number;
}

export interface StoreData {
  settings: Settings;
  projects: ProjectRecord[];
}

export const DEFAULT_SETTINGS: Settings = {
  acmeEmail: "",
  bindHost: "127.0.0.1",
  bindPort: 8787,
  portRangeStart: 4100,
};

export function publicProject(record: ProjectRecord, dns?: ProjectDns): Project {
  const { gitToken: _token, lastAutoAttemptSha: _attempt, ...rest } = normalizeRecord(record);
  return {
    ...rest,
    gitTokenSet: Boolean(record.gitToken),
    dns: dns ?? { ipv4: null, ipv6: null, records: [] },
  };
}
