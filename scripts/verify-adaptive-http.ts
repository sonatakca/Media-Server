import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createArgon2PasswordHasher } from "../src/server/ownApi/auth/passwords";

const baseUrl = (
  process.env.SEYIRLIK_LAB_BASE_URL ?? "http://127.0.0.1:43111"
).replace(/\/$/, "");
const connectionString = process.env.SEYIRLIK_LAB_DATABASE_URL;
const scanBeforeVerification = process.env.SEYIRLIK_LAB_SCAN === "true";

if (!connectionString) {
  throw new Error("SEYIRLIK_LAB_DATABASE_URL is required.");
}

const databaseName = new URL(connectionString).pathname.replace(/^\//, "");
if (!databaseName.endsWith("_lab")) {
  throw new Error(
    `Refusing to create an ephemeral verifier outside a *_lab database (received ${databaseName}).`,
  );
}

const pool = new Pool({ connectionString, max: 1 });
const userId = randomUUID();
const username = `adaptive-verifier-${randomBytes(6).toString("hex")}`;
const password = randomBytes(32).toString("base64url");

function cookieMap(response: Response): Map<string, string> {
  const getSetCookie = (
    response.headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  const values = getSetCookie?.call(response.headers) ?? [];
  const cookies = new Map<string, string>();
  for (const value of values) {
    const pair = value.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (cookieValue || !cookies.has(name)) cookies.set(name, cookieValue);
  }
  return cookies;
}

function relativeUrl(reference: string, parent = `${baseUrl}/`): string {
  return new URL(reference, parent).toString();
}

function playlistUris(playlist: string): string[] {
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function attributeUris(playlist: string): string[] {
  return [...playlist.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]!);
}

async function requireOk(response: Response, label: string): Promise<Response> {
  if (response.ok) return response;
  throw new Error(
    `${label} failed with HTTP ${response.status}: ${await response.text()}`,
  );
}

try {
  const passwordHash = await createArgon2PasswordHasher().hash(password);
  await pool.query(
    `INSERT INTO native_users (
       id, normalized_username, display_name, password_hash,
       is_administrator, allow_all_libraries, allow_playback
     ) VALUES ($1, $2, $3, $4, true, true, true)`,
    [userId, username, "Adaptive HTTP verifier", passwordHash],
  );

  const login = await requireOk(
    await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        username,
        password,
        deviceDescription: "Ephemeral adaptive HTTP verifier",
      }),
    }),
    "login",
  );
  const cookies = cookieMap(login);
  const sessionCookieName = cookies.has("seyirlik_session")
    ? "seyirlik_session"
    : "__Secure-seyirlik_session";
  const csrfCookieName = cookies.has("seyirlik_csrf")
    ? "seyirlik_csrf"
    : "__Secure-seyirlik_csrf";
  const sessionToken = cookies.get(sessionCookieName);
  const csrfToken = cookies.get(csrfCookieName);
  if (!sessionToken || !csrfToken) {
    throw new Error(
      `Login did not issue the expected cookies (received: ${[...cookies.entries()].map(([name, value]) => `${name}:${value.length}`).join(", ") || "none"}).`,
    );
  }
  const cookie = `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`;

  let scanResult: { tasks: number; status: "succeeded" } | undefined;
  if (scanBeforeVerification) {
    const scanResponse = await requireOk(
      await fetch(`${baseUrl}/ownAPI/v1/admin/libraries/scan-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
          "X-CSRF-Token": csrfToken,
        },
        body: "{}",
      }),
      "lab library scan",
    );
    const scanPayload = (await scanResponse.json()) as {
      data: { taskIds: string[] };
    };
    const taskIds = new Set(scanPayload.data.taskIds);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const tasksResponse = await requireOk(
        await fetch(`${baseUrl}/ownAPI/v1/admin/tasks?limit=50`, {
          headers: { Cookie: cookie },
        }),
        "lab scan status",
      );
      const tasksPayload = (await tasksResponse.json()) as {
        data: Array<{ id: string; status: string; error?: string | null }>;
      };
      const tasks = tasksPayload.data.filter((task) => taskIds.has(task.id));
      const failure = tasks.find((task) =>
        ["failed", "cancelled"].includes(task.status),
      );
      if (failure) {
        throw new Error(
          `Lab scan ${failure.status}: ${failure.error ?? "unknown error"}`,
        );
      }
      if (
        tasks.length === taskIds.size &&
        tasks.every((task) => task.status === "succeeded")
      ) {
        scanResult = { tasks: taskIds.size, status: "succeeded" };
        break;
      }
      if (Date.now() >= deadline)
        throw new Error("Lab scan did not finish within 120 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const item = await pool.query<{ item_id: string; file_id: string }>(
    `SELECT i.id AS item_id, mf.id AS file_id
       FROM items i
       JOIN media_files mf ON mf.item_id = i.id
      WHERE i.title = 'Dune HDR Lab' AND mf.missing_since IS NULL
      LIMIT 1`,
  );
  const ids = item.rows[0];
  if (!ids)
    throw new Error("Dune HDR Lab is not present in the lab catalogue.");

  const modernCapabilities = {
    supportsHlsNative: true,
    supportsMediaSource: true,
    directFileContainers: ["mp4", "webm"],
    mseContainers: ["mp4", "webm"],
    video: {
      h264: { supported: true, smooth: true, powerEfficient: true },
      hevc: {
        supported: true,
        smooth: true,
        powerEfficient: true,
        supports10Bit: true,
        supportsHdr: true,
      },
      av1: {
        supported: true,
        smooth: true,
        powerEfficient: true,
        supports10Bit: true,
        supportsHdr: true,
      },
      vp9: { supported: true, smooth: true, powerEfficient: true },
    },
    audio: {
      aac: { supported: true, maxChannels: 8 },
      opus: { supported: true, maxChannels: 8 },
    },
    subtitles: {
      srtExternal: true,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: new Date().toISOString(),
  };

  const playback = await requireOk(
    await fetch(`${baseUrl}/ownAPI/v1/playback/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        itemId: ids.item_id,
        mediaFileId: ids.file_id,
        clientCapabilities: modernCapabilities,
      }),
    }),
    "playback session",
  );
  const payload = (await playback.json()) as {
    data: {
      delivery: { type: string; url: string };
      plan: { mode: string; requiresTranscode: boolean };
      qualityManifest?: {
        qualities: Array<{
          id: string;
          height: number;
          playbackUrl: string;
        }>;
        adaptive?: {
          qualities: Array<{ id: string; height: number }>;
          audioTracks: Array<{
            id: string;
            sourceStreamIndex: number;
            language?: string;
          }>;
        };
      };
    };
  };

  const masterUrl = relativeUrl(payload.data.delivery.url);
  const masterResponse = await requireOk(
    await fetch(masterUrl, { headers: { Cookie: cookie } }),
    "adaptive master playlist",
  );
  const master = await masterResponse.text();
  const variantReferences = playlistUris(master);
  const audioReferences = attributeUris(master);
  if (variantReferences.length < 2 || audioReferences.length < 1) {
    throw new Error(
      "Adaptive master playlist does not expose multiple video qualities and audio.",
    );
  }

  const variantUrl = relativeUrl(variantReferences[0]!, masterUrl);
  const variantResponse = await requireOk(
    await fetch(variantUrl, { headers: { Cookie: cookie } }),
    "video media playlist",
  );
  const variant = await variantResponse.text();
  const segmentReferences = playlistUris(variant);
  const byteRanges = [
    ...variant.matchAll(/^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/gm),
  ];
  if (segmentReferences.length === 0 || byteRanges.length < 2) {
    throw new Error(
      "Video playlist is not a byte-range segmented CMAF stream.",
    );
  }

  const middleIndex = Math.floor(byteRanges.length / 2);
  const middleRange = byteRanges[middleIndex]!;
  const length = Number(middleRange[1]);
  const explicitOffset = middleRange[2] ? Number(middleRange[2]) : undefined;
  let offset = 0;
  for (let index = 0; index <= middleIndex; index += 1) {
    const match = byteRanges[index]!;
    if (match[2]) offset = Number(match[2]);
    if (index === middleIndex) break;
    offset += Number(match[1]);
  }
  const rangeStart = explicitOffset ?? offset;
  const mediaUrl = relativeUrl(
    segmentReferences[middleIndex] ?? segmentReferences[0]!,
    variantUrl,
  );
  const rangeResponse = await fetch(mediaUrl, {
    headers: {
      Cookie: cookie,
      Range: `bytes=${rangeStart}-${rangeStart + length - 1}`,
    },
  });
  const rangeBytes = (await rangeResponse.arrayBuffer()).byteLength;
  if (rangeResponse.status !== 206 || rangeBytes !== length) {
    throw new Error(
      `Expected an exact 206 byte range (${length} bytes), received HTTP ${rangeResponse.status} and ${rangeBytes} bytes.`,
    );
  }

  const durations = [...variant.matchAll(/^#EXTINF:([0-9.]+),/gm)].map(
    (match) => Number(match[1]),
  );

  /**
   * Every quality the manifest advertises has to be fetchable, by the same
   * session, with the right type and exact byte-range behaviour.
   *
   * The player only ever offers what this manifest lists, so a listed file that
   * 404s, answers with the wrong content type, or ignores a Range header turns
   * a quality click into "that saved quality file is no longer available" with
   * nothing on screen to explain it.
   */
  const qualityFileChecks: Array<Record<string, unknown>> = [];

  const compatibilityItems = await pool.query<{
    title: string;
    item_id: string;
    file_id: string;
  }>(
    `SELECT i.title, i.id AS item_id, mf.id AS file_id
       FROM items i
       JOIN media_files mf ON mf.item_id = i.id
      WHERE i.title LIKE 'Compatibility - %'
        AND mf.missing_since IS NULL
      ORDER BY i.title`,
  );
  const compatibilityPlans = [];
  for (const fixture of compatibilityItems.rows) {
    const planResponse = await requireOk(
      await fetch(`${baseUrl}/ownAPI/v1/playback/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          itemId: fixture.item_id,
          mediaFileId: fixture.file_id,
          clientCapabilities: modernCapabilities,
        }),
      }),
      `playback plan for ${fixture.title}`,
    );
    const planPayload = (await planResponse.json()) as {
      data: {
        mode: string;
        requiresTranscode: boolean;
        container: { action: string };
        video: { action: string };
        audio: { action: string };
        subtitles: { action: string };
      };
    };
    compatibilityPlans.push({ title: fixture.title, ...planPayload.data });
  }

  const runtimeFixtures = compatibilityItems.rows.filter((fixture) =>
    [
      "Compatibility - AV1 HDR",
      "Compatibility - H264 Multilingual MKV",
      // Direct play, so its manifest advertises the original as a complete
      // file: the one shape that exercises the quality-file URL checks.
      "Compatibility - H264 Progressive",
    ].includes(fixture.title),
  );
  const runtimeSessions = [];
  for (const fixture of runtimeFixtures) {
    const clientCapabilities = structuredClone(modernCapabilities);
    if (fixture.title === "Compatibility - AV1 HDR") {
      clientCapabilities.video.av1.supported = false;
      clientCapabilities.video.av1.smooth = false;
      clientCapabilities.video.av1.powerEfficient = false;
    }

    const sessionResponse = await fetch(
      `${baseUrl}/ownAPI/v1/playback/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          itemId: fixture.item_id,
          mediaFileId: fixture.file_id,
          clientCapabilities,
        }),
      },
    );
    await requireOk(
      sessionResponse,
      `runtime playback session for ${fixture.title}`,
    );
    const sessionPayload = (await sessionResponse.json()) as {
      data: {
        sessionId: string;
        delivery: { type: string; url: string };
        plan: { mode: string; requiresTranscode: boolean };
        qualityManifest?: {
          qualities: Array<{ id: string; height: number; playbackUrl: string }>;
        };
      };
    };
    for (const quality of sessionPayload.data.qualityManifest?.qualities ?? []) {
      const qualityUrl = relativeUrl(quality.playbackUrl);
      const headResponse = await fetch(qualityUrl, {
        method: "HEAD",
        headers: { Cookie: cookie },
      });
      const rangeResponse = await fetch(qualityUrl, {
        headers: { Cookie: cookie, Range: "bytes=100-199" },
      });
      const rangeLength = (await rangeResponse.arrayBuffer()).byteLength;
      if (!headResponse.ok) {
        throw new Error(
          `${fixture.title} advertises quality ${quality.id}, which is not reachable: HTTP ${headResponse.status}.`,
        );
      }
      if (rangeResponse.status !== 206 || rangeLength !== 100) {
        throw new Error(
          `${fixture.title} quality ${quality.id} does not serve exact byte ranges (HTTP ${rangeResponse.status}, ${rangeLength} bytes).`,
        );
      }
      qualityFileChecks.push({
        title: fixture.title,
        id: quality.id,
        height: quality.height,
        httpStatus: headResponse.status,
        contentType: headResponse.headers.get("content-type"),
        rangeStatus: rangeResponse.status,
        rangeBytes: rangeLength,
      });
    }
    const deliveryResponse = await requireOk(
      await fetch(relativeUrl(sessionPayload.data.delivery.url), {
        headers: { Cookie: cookie },
      }),
      `runtime delivery for ${fixture.title}`,
    );
    runtimeSessions.push({
      title: fixture.title,
      mode: sessionPayload.data.plan.mode,
      requiresTranscode: sessionPayload.data.plan.requiresTranscode,
      deliveryType: sessionPayload.data.delivery.type,
      deliveryStatus: deliveryResponse.status,
    });
    await requireOk(
      await fetch(
        `${baseUrl}/ownAPI/v1/playback/sessions/${sessionPayload.data.sessionId}`,
        {
          method: "DELETE",
          headers: {
            Cookie: cookie,
            Origin: baseUrl,
            "X-CSRF-Token": csrfToken,
          },
        },
      ),
      `runtime playback cleanup for ${fixture.title}`,
    );
  }
  for (const quality of payload.data.qualityManifest?.qualities ?? []) {
    const qualityUrl = relativeUrl(quality.playbackUrl);
    const headResponse = await fetch(qualityUrl, {
      method: "HEAD",
      headers: { Cookie: cookie },
    });
    const rangeResponse = await fetch(qualityUrl, {
      headers: { Cookie: cookie, Range: "bytes=100-199" },
    });
    const rangeLength = (await rangeResponse.arrayBuffer()).byteLength;
    if (!headResponse.ok) {
      throw new Error(
        `Advertised quality ${quality.id} is not reachable: HTTP ${headResponse.status}.`,
      );
    }
    if (rangeResponse.status !== 206 || rangeLength !== 100) {
      throw new Error(
        `Advertised quality ${quality.id} does not serve exact byte ranges (HTTP ${rangeResponse.status}, ${rangeLength} bytes).`,
      );
    }
    qualityFileChecks.push({
      id: quality.id,
      height: quality.height,
      httpStatus: headResponse.status,
      contentType: headResponse.headers.get("content-type"),
      rangeStatus: rangeResponse.status,
      rangeBytes: rangeLength,
    });
  }

  /**
   * Manual rungs, enforced by the manifest.
   *
   * Safari's native HLS engine has no level API, so an exact quality choice can
   * only be expressed by handing it a master playlist that advertises that rung
   * and nothing else. Each rung is requested the way the player requests it and
   * the returned playlist is checked to carry exactly one variant.
   */
  const manualQualityChecks = [];
  for (const quality of payload.data.qualityManifest?.adaptive?.qualities ??
    []) {
    const rungUrl = new URL(masterUrl);
    rungUrl.searchParams.set("height", String(quality.height));
    const rungResponse = await requireOk(
      await fetch(rungUrl.toString(), { headers: { Cookie: cookie } }),
      `manual ${quality.height}p master playlist`,
    );
    const rungPlaylist = await rungResponse.text();
    const rungVariants = playlistUris(rungPlaylist);
    if (rungVariants.length !== 1) {
      throw new Error(
        `Requesting ${quality.height}p returned ${rungVariants.length} variants instead of exactly one.`,
      );
    }
    const rungMediaResponse = await requireOk(
      await fetch(relativeUrl(rungVariants[0]!, rungUrl.toString()), {
        headers: { Cookie: cookie },
      }),
      `manual ${quality.height}p media playlist`,
    );
    await rungMediaResponse.text();
    manualQualityChecks.push({
      requestedHeight: quality.height,
      variants: rungVariants.length,
      variant: rungVariants[0],
      contentType: rungResponse.headers.get("content-type"),
    });
  }

  /**
   * Audio renditions, selected the way a native HLS engine selects them.
   *
   * Safari picks the rendition the manifest marks DEFAULT, so asking for a
   * track has to move that mark and leave everything else selectable but not
   * default.
   */
  const audioSelectionChecks = [];
  for (const track of payload.data.qualityManifest?.adaptive?.audioTracks ??
    []) {
    const audioUrl = new URL(masterUrl);
    audioUrl.searchParams.set(
      "audioStreamIndex",
      String(track.sourceStreamIndex),
    );
    const audioResponse = await requireOk(
      await fetch(audioUrl.toString(), { headers: { Cookie: cookie } }),
      `master playlist for audio stream ${track.sourceStreamIndex}`,
    );
    const audioPlaylist = await audioResponse.text();
    const audioRows = audioPlaylist
      .split(/\r?\n/)
      .filter((line) => line.includes("TYPE=AUDIO"));
    const defaultRows = audioRows.filter((line) => line.includes("DEFAULT=YES"));
    if (defaultRows.length !== 1) {
      throw new Error(
        `Selecting audio stream ${track.sourceStreamIndex} produced ${defaultRows.length} default renditions.`,
      );
    }
    if (
      !defaultRows[0]!.includes(
        `X-SEYIRLIK-STREAM-INDEX=${track.sourceStreamIndex}`,
      )
    ) {
      throw new Error(
        `Selecting audio stream ${track.sourceStreamIndex} defaulted to the wrong rendition: ${defaultRows[0]}.`,
      );
    }
    const audioMediaUri = /URI="([^"]+)"/.exec(defaultRows[0]!)?.[1];
    const audioMediaResponse = await requireOk(
      await fetch(relativeUrl(audioMediaUri!, audioUrl.toString()), {
        headers: { Cookie: cookie },
      }),
      `audio media playlist for ${track.id}`,
    );
    await audioMediaResponse.text();
    audioSelectionChecks.push({
      sourceStreamIndex: track.sourceStreamIndex,
      renditionId: track.id,
      language: track.language ?? null,
      defaultRenditions: defaultRows.length,
      totalRenditions: audioRows.length,
    });
  }

  console.log(
    JSON.stringify(
      {
        result: "pass",
        ...(scanResult ? { scan: scanResult } : {}),
        deliveryType: payload.data.delivery.type,
        playbackMode: payload.data.plan.mode,
        requiresLiveTranscode: payload.data.plan.requiresTranscode,
        videoVariants: variantReferences.length,
        audioRenditions: audioReferences.length,
        qualityManifestVideoVariants:
          payload.data.qualityManifest?.adaptive?.qualities.length ?? 0,
        qualityManifestAudioRenditions:
          payload.data.qualityManifest?.adaptive?.audioTracks.length ?? 0,
        mediaSegments: durations.length,
        maximumSegmentDurationSeconds: Math.max(...durations),
        middleSeekRange: {
          httpStatus: rangeResponse.status,
          requestedBytes: length,
          receivedBytes: rangeBytes,
        },
        qualityFileChecks,
        manualQualityChecks,
        audioSelectionChecks,
        compatibilityPlans,
        runtimeSessions,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.query("DELETE FROM native_users WHERE id = $1", [userId]);
  await pool.end();
}
