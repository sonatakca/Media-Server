/*
 * Offline playback, imported into the generated service worker.
 *
 * Answers requests for titles kept on this device (see
 * src/lib/offline/offlineLibrary.ts) from Cache Storage, and leaves every
 * other request to the network exactly as before. Only playback packages and
 * title artwork are ever looked up, so ordinary API traffic never pays for a
 * cache lookup, and nothing that was not deliberately downloaded is served
 * from here.
 *
 * Ranges are answered by slicing the stored file: a package addresses one
 * file in byte ranges, and hls.js asks for them one at a time.
 */

/* global self, caches, Response, fetch */

const OFFLINE_CACHE = "seyirlik-offline-v1";
const STORED_PATHS = /\/ownAPI\/v1\/(?:playback\/renditions\/|items\/[^/]+\/images\/)/;

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match) return null;
  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

async function answerFromStore(request) {
  const cache = await caches.open(OFFLINE_CACHE);
  const stored = await cache.match(request.url, { ignoreVary: true });
  if (!stored) return null;

  const rangeHeader = request.headers.get("Range");
  if (!rangeHeader) return stored;

  const body = await stored.blob();
  const range = parseRange(rangeHeader, body.size);
  if (range === null) return stored;
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${body.size}` },
    });
  }
  return new Response(body.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      "Content-Type":
        stored.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${body.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !STORED_PATHS.test(request.url)) return;

  event.respondWith(
    (async () => {
      const stored = await answerFromStore(request).catch(() => null);
      if (stored) return stored;
      return fetch(request);
    })(),
  );
});
