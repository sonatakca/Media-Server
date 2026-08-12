import { describe, expect, it } from "vitest";
import {
  getFirstLocalHlsUri,
  hasMixedContentRisk,
  redactDiagnosticsUrl,
} from "./playbackEnvironmentDiagnostics";

describe("playback environment diagnostics", () => {
  it("redacts sensitive query values but keeps the endpoint readable", () => {
    expect(
      redactDiagnosticsUrl(
        "https://media.test/stream?api_key=secret&ApiKey=secret2&foo=bar",
      ),
    ).toBe(
      "https://media.test/stream?api_key=REDACTED&ApiKey=REDACTED&foo=bar",
    );
  });

  it("hides the playback session id, which is itself a capability", () => {
    expect(
      redactDiagnosticsUrl(
        "https://seyirlik.test/ownAPI/v1/playback/sessions/abc-123/master.m3u8",
      ),
    ).toBe(
      "https://seyirlik.test/ownAPI/v1/playback/sessions/[redacted]/master.m3u8",
    );
  });

  it("detects mixed-content risk only for HTTPS pages loading non-local HTTP media", () => {
    expect(
      hasMixedContentRisk(
        "https://seyirlik.test/home",
        "http://jellyfin.test/Videos/1/stream",
      ),
    ).toBe(true);
    expect(
      hasMixedContentRisk(
        "http://192.168.1.21:5173/home",
        "http://jellyfin.test/Videos/1/stream",
      ),
    ).toBe(false);
    expect(
      hasMixedContentRisk(
        "https://seyirlik.test/home",
        "http://127.0.0.1:43110/api/playback/request",
      ),
    ).toBe(false);
  });

  it("finds the first local HLS segment URI and ignores comments or absolute URLs", () => {
    expect(
      getFirstLocalHlsUri(
        [
          "#EXTM3U",
          "#EXT-X-VERSION:6",
          "https://cdn.test/segment.ts",
          "#EXTINF:4.000000,",
          "segment_00000.ts",
          "",
        ].join("\n"),
      ),
    ).toBe("segment_00000.ts");
  });
});
