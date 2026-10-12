const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const ACME_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function assertName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!NAME_RE.test(value)) {
    throw new HttpError(
      400,
      "Name must be lowercase letters, numbers, and hyphens (start with a letter or number).",
    );
  }
  return value;
}

export function assertAcmeEmail(email: string): string {
  const value = email.trim();
  if (!value) return "";
  if (!ACME_EMAIL_RE.test(value)) throw new HttpError(400, "Invalid ACME email");
  return value;
}

export function assertDomain(domain: string): string {
  const value = domain.trim().toLowerCase();
  if (!value) return "";
  if (!DOMAIN_RE.test(value)) {
    throw new HttpError(400, `Invalid domain: ${domain}`);
  }
  return value;
}

export function assertGitUrl(url: string): string {
  const value = url.trim();
  if (!value) throw new HttpError(400, "Git URL is required");
  if (/[\r\n]/.test(value)) throw new HttpError(400, "Invalid git URL");
  const ok =
    value.startsWith("git@") ||
    value.startsWith("https://") ||
    value.startsWith("http://") ||
    value.startsWith("ssh://") ||
    value.startsWith("file://") ||
    value.startsWith("/");
  if (!ok) throw new HttpError(400, "Git URL must be https, ssh, file, or a local path");
  return value;
}

export function assertType(type: string): "static" | "node" {
  if (type !== "static" && type !== "node") {
    throw new HttpError(400, "Type must be static or node");
  }
  return type;
}

export function assertAutoDeployIntervalMin(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    throw new HttpError(400, "Poll interval must be an integer from 1 to 1440 minutes");
  }
  return n;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
