import dns from "node:dns";
import os from "node:os";
import { siteHostnames } from "./caddy.js";
import type { DnsRecord, ProjectDns } from "./types.js";

dns.setDefaultResultOrder("ipv4first");

export type { DnsRecord, ProjectDns };

export interface PublicIps {
  ipv4: string | null;
  ipv6: string | null;
}

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; value: PublicIps } | null = null;
let inflight: Promise<PublicIps> | null = null;

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPublicV6(ip: string): boolean {
  const n = ip.toLowerCase().split("%")[0] ?? ip;
  if (n === "::1") return false;
  if (n.startsWith("fe80:")) return false;
  if (n.startsWith("fc") || n.startsWith("fd")) return false;
  if (n.startsWith("::ffff:")) return false;
  return n.includes(":");
}

function looksLikeV4(text: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) && !isPrivateV4(text);
}

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 2000,
): Promise<string | null> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string | null>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve(null);
      }, timeoutMs);
      fetch(url, { headers, signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) {
            resolve(null);
            return;
          }
          const text = (await res.text()).trim();
          resolve(text || null);
        })
        .catch(() => resolve(null));
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function interfaceIps(): PublicIps {
  const ipv4s: string[] = [];
  const ipv6s: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      const family = String(addr.family);
      if (family === "IPv4" || family === "4") {
        if (!isPrivateV4(addr.address)) ipv4s.push(addr.address);
      } else if (family === "IPv6" || family === "6") {
        const ip = addr.address.split("%")[0] ?? addr.address;
        if (isPublicV6(ip)) ipv6s.push(ip);
      }
    }
  }
  return { ipv4: ipv4s[0] ?? null, ipv6: ipv6s[0] ?? null };
}

async function fromMetadata(): Promise<Partial<PublicIps>> {
  const gcp4 = await fetchText(
    "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
    { "Metadata-Flavor": "Google" },
    800,
  );
  if (gcp4 && looksLikeV4(gcp4)) return { ipv4: gcp4 };

  const aws4 = await fetchText("http://169.254.169.254/latest/meta-data/public-ipv4", {}, 800);
  if (aws4 && looksLikeV4(aws4)) return { ipv4: aws4 };

  const azure4 = await fetchText(
    "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text",
    { Metadata: "true" },
    800,
  );
  if (azure4 && looksLikeV4(azure4)) return { ipv4: azure4 };

  return {};
}

async function fromStun(): Promise<Partial<PublicIps>> {
  for (const url of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
    const text = await fetchText(url, {}, 2500);
    if (text && looksLikeV4(text)) return { ipv4: text };
  }
  return {};
}

async function detectPublicIps(): Promise<PublicIps> {
  const env4 = process.env.HOSTING_PUBLIC_IPV4?.trim() || null;
  const env6 = process.env.HOSTING_PUBLIC_IPV6?.trim() || null;
  const iface = interfaceIps();
  let ipv4 = env4 || iface.ipv4;
  let ipv6 = env6 || iface.ipv6;
  if (!ipv4) {
    const meta = await fromMetadata();
    ipv4 = meta.ipv4 ?? null;
  }
  if (!ipv4) {
    const stun = await fromStun();
    ipv4 = stun.ipv4 ?? null;
  }
  return { ipv4, ipv6 };
}

/** Detect this server’s public addresses. Cached for a few minutes. */
export async function getPublicIps(): Promise<PublicIps> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = detectPublicIps()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function dnsRecordsFor(domain: string, ips: PublicIps): DnsRecord[] {
  if (!domain) return [];
  const records: DnsRecord[] = [];
  for (const name of siteHostnames(domain)) {
    if (ips.ipv4) records.push({ type: "A", name, value: ips.ipv4 });
    if (ips.ipv6) records.push({ type: "AAAA", name, value: ips.ipv6 });
  }
  return records;
}

export async function projectDns(domain: string): Promise<ProjectDns> {
  const ips = await getPublicIps();
  return {
    ipv4: ips.ipv4,
    ipv6: ips.ipv6,
    records: dnsRecordsFor(domain, ips),
  };
}

export function formatDnsRecords(records: DnsRecord[]): string {
  if (records.length === 0) return "";
  const rows = [
    ["TYPE", "NAME", "VALUE"],
    ...records.map((r) => [r.type, r.name, r.value]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] + 2)).join("")).join("\n");
}

export function dnsZoneSnippet(records: DnsRecord[]): string {
  return records.map((r) => `${r.name}.  IN ${r.type}  ${r.value}`).join("\n");
}
