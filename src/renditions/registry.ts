import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { RENDITION_PROFILE_VERSION } from "./policy";

export const RENDITION_REGISTRY_SCHEMA_VERSION = 1;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

export interface RenditionRegistryItem {
  id: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sourceFingerprint: string;
  profileVersion: string;
  lastSeenAt: string;
  status?:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "deferred-for-storage"
    | "stale"
    | "already-valid"
    | "interrupted"
    | "validation-failed";
  lastError?: string;
}

export interface RenditionRegistry {
  schemaVersion: number;
  profileVersion: string;
  updatedAt: string;
  items: RenditionRegistryItem[];
}

export interface RegistrySourceInput {
  relativePath: string;
  size: number;
  mtimeMs: number;
  sourceFingerprint: string;
}

export function createEmptyRenditionRegistry(): RenditionRegistry {
  return {
    schemaVersion: RENDITION_REGISTRY_SCHEMA_VERSION,
    profileVersion: RENDITION_PROFILE_VERSION,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isRegistryItem(value: unknown): value is RenditionRegistryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RenditionRegistryItem>;
  return (
    typeof item.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(item.id) &&
    typeof item.relativePath === "string" &&
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0 &&
    typeof item.mtimeMs === "number" &&
    Number.isFinite(item.mtimeMs) &&
    typeof item.sourceFingerprint === "string" &&
    /^[0-9a-f]{64}$/i.test(item.sourceFingerprint) &&
    typeof item.profileVersion === "string" &&
    typeof item.lastSeenAt === "string"
  );
}

function parseRegistry(value: unknown): RenditionRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rendition registry is invalid.");
  }
  const registry = value as Partial<RenditionRegistry>;
  if (
    registry.schemaVersion !== RENDITION_REGISTRY_SCHEMA_VERSION ||
    typeof registry.profileVersion !== "string" ||
    typeof registry.updatedAt !== "string" ||
    !Array.isArray(registry.items) ||
    !registry.items.every(isRegistryItem)
  ) {
    throw new Error("Rendition registry schema is invalid or unsupported.");
  }
  return registry as RenditionRegistry;
}

export async function loadRenditionRegistry(
  registryPath: string,
): Promise<RenditionRegistry> {
  try {
    return parseRegistry(JSON.parse(await readFile(registryPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyRenditionRegistry();
    }
    throw error;
  }
}

export async function saveRenditionRegistry(
  registryPath: string,
  registry: RenditionRegistry,
): Promise<void> {
  registry.updatedAt = new Date().toISOString();
  const validated = parseRegistry(registry);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporaryPath, registryPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" &&
      process.platform !== "win32"
    ) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(registryPath, { force: true });
    await rename(temporaryPath, registryPath);
  }
}

export async function computeSourceFingerprint(
  filePath: string,
  stats: Pick<Stats, "size" | "mtimeMs">,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    `seyirlik-source-v1\0${stats.size}\0${Math.trunc(stats.mtimeMs)}\0`,
  );
  const handle = await open(filePath, "r");
  try {
    const headLength = Math.min(FINGERPRINT_SAMPLE_BYTES, stats.size);
    const head = Buffer.alloc(headLength);
    if (headLength > 0) {
      const { bytesRead } = await handle.read(head, 0, headLength, 0);
      hash.update(head.subarray(0, bytesRead));
    }

    if (stats.size > headLength) {
      const tailLength = Math.min(
        FINGERPRINT_SAMPLE_BYTES,
        stats.size - headLength,
      );
      const tail = Buffer.alloc(tailLength);
      const tailPosition = Math.max(headLength, stats.size - tailLength);
      const { bytesRead } = await handle.read(
        tail,
        0,
        tailLength,
        tailPosition,
      );
      hash.update(tail.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function upsertRegistrySource(
  registry: RenditionRegistry,
  source: RegistrySourceInput,
): RenditionRegistryItem {
  const relativePath = normalizeRelativePath(source.relativePath);
  const pathMatchIndex = registry.items.findIndex(
    (item) =>
      item.relativePath.toLocaleLowerCase("en-US") ===
      relativePath.toLocaleLowerCase("en-US"),
  );
  const fingerprintMatchIndex = registry.items.findIndex(
    (item) =>
      source.sourceFingerprint !== "0".repeat(64) &&
      item.sourceFingerprint === source.sourceFingerprint,
  );
  const matchIndex =
    pathMatchIndex >= 0 ? pathMatchIndex : fingerprintMatchIndex;
  const previous = matchIndex >= 0 ? registry.items[matchIndex] : undefined;
  const sourceChanged = Boolean(
    previous &&
    (previous.sourceFingerprint !== source.sourceFingerprint ||
      previous.profileVersion !== registry.profileVersion),
  );
  const next: RenditionRegistryItem = {
    id: previous?.id ?? randomUUID(),
    relativePath,
    size: source.size,
    mtimeMs: source.mtimeMs,
    sourceFingerprint: source.sourceFingerprint,
    profileVersion: registry.profileVersion,
    lastSeenAt: new Date().toISOString(),
    status: sourceChanged ? "stale" : (previous?.status ?? "pending"),
    ...(sourceChanged
      ? {}
      : previous?.lastError
        ? { lastError: previous.lastError }
        : {}),
  };

  if (matchIndex >= 0) registry.items.splice(matchIndex, 1, next);
  else registry.items.push(next);
  registry.updatedAt = new Date().toISOString();
  return next;
}

export function findRegistryItemById(
  registry: RenditionRegistry,
  mediaId: string,
): RenditionRegistryItem | undefined {
  return registry.items.find((item) => item.id === mediaId);
}
