/**
 * Carries adaptive-package facts from one rendition registry into another.
 *
 * The two package generations are tracked separately on purpose — a title can
 * have a valid legacy package and no adaptive one, and a failed adaptive run
 * must never make the legacy package look unusable. The same independence
 * means a library can end up with the two halves of the truth in two files:
 * one registry that watched the legacy packages being built, and a later one,
 * written under a different state root, that watched the adaptive packages
 * being built and knows nothing about the first.
 *
 * Whichever file the server reads is then wrong about half the library. On
 * Windows in September 2026 the server read the older one, so every fully
 * processed title — the ones whose source bytes packaging had already removed
 * — offered no package at all and could not be played.
 *
 * This joins them instead of choosing between them:
 *
 * - The destination stays authoritative for identity and for the legacy
 *   package. A legacy `id` names a directory under the destination's own
 *   rendition root, so it cannot be taken from somewhere else.
 * - Adaptive fields are taken from whichever registry recorded them at the
 *   current adaptive profile version. A record written under an older profile
 *   is ignored by the runtime and so carries nothing worth keeping.
 * - A source the destination has never seen is appended, with its legacy
 *   status reset to `pending`: the destination's rendition root has not been
 *   asked about it, and claiming otherwise would be a guess.
 *
 * An entry whose size, modification time or fingerprint disagree between the
 * two files describes different bytes under the same name. It is reported and
 * skipped, never reconciled.
 *
 * Idempotent: a second run reports no changes. Default is a dry run; pass
 * `--apply` to write, which backs the destination up first.
 */
import { copyFile } from "node:fs/promises";
import path from "node:path";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
  type RenditionRegistryItem,
} from "../src/renditions/registry";
import { ADAPTIVE_PROFILE_VERSION } from "../src/renditions/adaptive/profile";

interface Arguments {
  destination: string;
  source: string;
  apply: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const positional = argv.filter((value) => !value.startsWith("--"));
  const apply = argv.includes("--apply");
  const [destination, source] = positional;
  if (!destination || !source) {
    throw new Error(
      "Usage: merge-adaptive-registry-facts <destination-registry.json> <source-registry.json> [--apply]",
    );
  }
  return {
    destination: path.resolve(destination),
    source: path.resolve(source),
    apply,
  };
}

function key(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").toLowerCase();
}

/** Adaptive fields the runtime will actually consult, or nothing. */
function currentAdaptiveFacts(
  item: RenditionRegistryItem | undefined,
): Pick<
  RenditionRegistryItem,
  "adaptiveStatus" | "adaptiveProfileVersion" | "adaptiveLastError"
> | null {
  if (!item || item.adaptiveProfileVersion !== ADAPTIVE_PROFILE_VERSION) {
    return null;
  }
  return {
    ...(item.adaptiveStatus === undefined
      ? {}
      : { adaptiveStatus: item.adaptiveStatus }),
    adaptiveProfileVersion: item.adaptiveProfileVersion,
    ...(item.adaptiveLastError === undefined
      ? {}
      : { adaptiveLastError: item.adaptiveLastError }),
  };
}

function describesTheSameBytes(
  left: RenditionRegistryItem,
  right: RenditionRegistryItem,
): boolean {
  return (
    left.sourceFingerprint === right.sourceFingerprint &&
    left.size === right.size &&
    Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs)
  );
}

async function main(): Promise<void> {
  const { destination, source, apply } = parseArguments(process.argv.slice(2));
  const target = await loadRenditionRegistry(destination);
  const incoming = await loadRenditionRegistry(source);
  const incomingByPath = new Map(
    incoming.items.map((item) => [key(item.relativePath), item]),
  );

  const updated: string[] = [];
  const conflicts: string[] = [];
  const appended: string[] = [];

  for (const item of target.items) {
    const other = incomingByPath.get(key(item.relativePath));
    if (!other) continue;
    if (!describesTheSameBytes(item, other)) {
      conflicts.push(item.relativePath);
      continue;
    }
    const facts = currentAdaptiveFacts(other);
    if (!facts) continue;
    if (
      item.adaptiveStatus === facts.adaptiveStatus &&
      item.adaptiveProfileVersion === facts.adaptiveProfileVersion &&
      item.adaptiveLastError === facts.adaptiveLastError
    ) {
      continue;
    }
    delete item.adaptiveStatus;
    delete item.adaptiveProfileVersion;
    delete item.adaptiveLastError;
    Object.assign(item, facts);
    updated.push(item.relativePath);
  }

  const targetPaths = new Set(
    target.items.map((item) => key(item.relativePath)),
  );
  for (const item of incoming.items) {
    if (targetPaths.has(key(item.relativePath))) continue;
    const facts = currentAdaptiveFacts(item);
    target.items.push({
      ...item,
      // The destination's rendition root has never been asked about this
      // source, so it has no legacy package here until an analysis says so.
      status: "pending",
      ...(facts ?? {}),
    });
    appended.push(item.relativePath);
  }

  console.log(`destination: ${destination}`);
  console.log(`source:      ${source}`);
  console.log(`adaptive facts updated: ${updated.length}`);
  for (const entry of updated) console.log(`  ~ ${entry}`);
  console.log(`sources appended:       ${appended.length}`);
  for (const entry of appended) console.log(`  + ${entry}`);
  console.log(`conflicting entries:    ${conflicts.length}`);
  for (const entry of conflicts) console.log(`  ! ${entry}`);

  if (!apply) {
    console.log("\nDry run. Pass --apply to write.");
    return;
  }
  if (updated.length === 0 && appended.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${destination}.bak-${stamp}`;
  await copyFile(destination, backup);
  await saveRenditionRegistry(destination, target);
  // Read it back through the loader: a registry the runtime cannot parse would
  // withdraw every package in the library at once.
  const verified = await loadRenditionRegistry(destination);
  const ready = verified.items.filter(
    (item) =>
      item.adaptiveStatus === "ready" &&
      item.adaptiveProfileVersion === ADAPTIVE_PROFILE_VERSION,
  ).length;
  console.log(`\nbacked up to: ${backup}`);
  console.log(`items: ${verified.items.length}`);
  console.log(`adaptive packages the runtime will now offer: ${ready}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
