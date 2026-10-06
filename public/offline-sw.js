/*
 * Offline playback, imported into the generated service worker.
 *
 * Answers requests for titles kept on this device (see
 * src/lib/offline/offlineLibrary.ts) from Cache Storage, and leaves every
 * other request to the network exactly as before. Only playback packages,
 * title artwork, seek thumbnails and stored subtitles are ever looked up, so
 * ordinary API traffic never pays for a cache lookup, and nothing that was
 * not deliberately downloaded is served from here.
 *
 * Ranges are answered by slicing the stored file: a package addresses one
 * file in byte ranges, and hls.js asks for them one at a time.
 */

/* global self, caches, Response, fetch, Blob, URL */

const OFFLINE_CACHE = "seyirlik-offline-v1";
// A large file is stored as parts plus an index under its own URL; see
// `storeInParts` in src/lib/offline/offlineLibrary.ts, which must agree.
const PARTS_CONTENT_TYPE = "application/vnd.seyirlik.parts+json";

function partUrl(url, index) {
  const part = new URL(url);
  part.searchParams.set("seyirlik-part", String(index));
  return part.toString();
}
const STORED_PATHS =
  /\/ownAPI\/v1\/(?:playback\/renditions\/|items\/[^/]+\/(?:images|trickplay\/sprites)\/|downloads\/items\/[^/]+\/subtitles\/)/;

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
  if (stored.headers.get("Content-Type") === PARTS_CONTENT_TYPE) {
    return answerFromParts(cache, request.url, stored, rangeHeader);
  }
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

/** Answers a stored-in-parts file, reading only the parts the range spans. */
async function answerFromParts(cache, url, index, rangeHeader) {
  const { size, partBytes, contentType } = await index.json();
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const pieces = [];
  for (
    let part = Math.floor(start / partBytes);
    part <= Math.floor(end / partBytes);
    part += 1
  ) {
    const stored = await cache.match(partUrl(url, part));
    if (!stored) return null;
    const body = await stored.blob();
    const partStart = part * partBytes;
    pieces.push(
      body.slice(Math.max(0, start - partStart), end - partStart + 1),
    );
  }
  const body = new Blob(pieces, { type: contentType });
  const headers = {
    "Content-Type": contentType,
    "Content-Length": String(body.size),
    "Accept-Ranges": "bytes",
  };
  if (!range) return new Response(body, { status: 200, headers });
  return new Response(body, {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
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
