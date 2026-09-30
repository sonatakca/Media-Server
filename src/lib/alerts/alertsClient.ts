import { ownApiClient } from "../../api/ownApi/client";

/**
 * Reading the alert service from a device.
 *
 * The device keeps the service's address and a viewer token from the server,
 * in IndexedDB so the service worker can use them when a push arrives. Both
 * were handed out while the server was up; neither needs it afterwards, which
 * is the point of alerts that can say the server is down.
 */

const DATABASE = "seyirlik-alerts";
const STORE = "credentials";
const KEY = "viewer";

export interface AlertCredentials {
  url: string;
  token: string;
}

export interface AlertEntry {
  id: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  createdAt: number;
  resolvedAt: number | null;
  key: string | null;
}

export interface AlertsSnapshot {
  alerts: AlertEntry[];
  host: {
    lastHeartbeatAt: number | null;
    storage: string | null;
    version: string | null;
    lastVerifiedBackupAt: number | null;
    down: boolean;
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAlertCredentials(): Promise<AlertCredentials | null> {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(KEY);
      request.onsuccess = () =>
        resolve((request.result as AlertCredentials | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function saveAlertCredentials(credentials: AlertCredentials) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .put(credentials, KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

/**
 * Asks the server for this device's credentials and keeps them. Only an
 * administrator is given any; the server refuses everyone else.
 */
export async function refreshAlertCredentials(): Promise<AlertCredentials> {
  const credentials = await ownApiClient.request<AlertCredentials>(
    "/alerts/viewer-token",
    { method: "POST" },
  );
  await saveAlertCredentials(credentials);
  return credentials;
}

async function serviceRequest<T>(
  credentials: AlertCredentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${credentials.url}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${credentials.token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`The alert service answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

export function fetchAlerts(
  credentials: AlertCredentials,
): Promise<AlertsSnapshot> {
  return serviceRequest(credentials, "/v1/alerts?limit=100");
}

export function sendTestAlert(credentials: AlertCredentials): Promise<unknown> {
  return serviceRequest(credentials, "/v1/test", { method: "POST" });
}

function applicationServerKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Whether this device is already subscribed. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Subscribes this device. On iPhone and iPad this only works from the app
 * added to the home screen, which is Apple's rule, not Seyirlik's.
 */
export async function enablePush(credentials: AlertCredentials): Promise<void> {
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("Notifications were not allowed.");
  }
  const { publicKey } = await serviceRequest<{ publicKey: string }>(
    credentials,
    "/v1/vapid-public-key",
  );
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  await serviceRequest(credentials, "/v1/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
}

export async function disablePush(
  credentials: AlertCredentials,
): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await serviceRequest(credentials, "/v1/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe();
}
