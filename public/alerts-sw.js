/*
 * Alert notifications, imported into the generated service worker.
 *
 * A push from the alert service carries nothing (see alerts/src/webPush.ts):
 * it only wakes this worker, which asks the service for the newest alert with
 * the viewer token the Alerts page stored, and shows it. If the service cannot
 * be asked, a notification still appears — being woken is itself the news.
 */

/* global self, indexedDB, fetch */

function readCredentials() {
  return new Promise((resolve) => {
    const request = indexedDB.open("seyirlik-alerts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("credentials");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const get = database
          .transaction("credentials", "readonly")
          .objectStore("credentials")
          .get("viewer");
        get.onsuccess = () => {
          database.close();
          resolve(get.result || null);
        };
        get.onerror = () => {
          database.close();
          resolve(null);
        };
      } catch {
        database.close();
        resolve(null);
      }
    };
  });
}

async function newestAlert() {
  const credentials = await readCredentials();
  if (!credentials) return null;
  try {
    const response = await fetch(`${credentials.url}/v1/alerts?limit=1`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.alerts && body.alerts[0] ? body.alerts[0] : null;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const alert = await newestAlert();
      await self.registration.showNotification(
        alert ? alert.title : "Seyirlik alert",
        {
          body: alert ? alert.body : "Open Seyirlik to see what happened.",
          tag: alert ? alert.id : "seyirlik-alert",
          icon: "/pwa-192x192.png",
          badge: "/favicon-32x32.png",
          data: { url: "/alerts" },
        },
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || "/alerts";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("focus" in client) {
          await client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
