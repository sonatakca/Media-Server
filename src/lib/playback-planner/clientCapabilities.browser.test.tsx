import { describe, expect, it } from "vitest";

import { buildClientCapabilities } from "./clientCapabilities";

describe("client media capabilities in a real browser", () => {
  it("reports the H.264 MP4 path used by generated renditions as playable", async () => {
    const capabilities = await buildClientCapabilities();

    // This is the server-side rendition filter's input. A false answer here
    // hides every H.264 quality from Chrome; in WebKit it can force playback
    // through a transcode path even though the browser just decoded the same
    // kind of fixture in the handoff suite.
    expect(capabilities.video.h264?.supported).toBe(true);
    expect(capabilities.directFileContainers).toContain("mp4");
  });
});
