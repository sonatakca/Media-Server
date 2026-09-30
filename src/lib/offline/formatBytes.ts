/** A byte count the way a person reads storage: "2.1 GB", "640 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gigabytes = bytes / 1_000_000_000;
  if (gigabytes >= 1) return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
