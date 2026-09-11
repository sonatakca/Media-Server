import { describe, expect, it } from "vitest";
import type {
  SubtitleCandidate,
  SubtitleProvider,
  SubtitleQuery,
} from "./subtitleProvider";
import { assessCandidate, orderCandidates } from "./subtitleSelection";
import { normalizeWant } from "./subtitleState";

const provider = {
  id: "p",
  label: "P",
  requiresSession: false,
  rank: 1,
  languages: null,
} as unknown as SubtitleProvider;

const query: SubtitleQuery = {
  title: "Fight Club",
  year: 1999,
  season: null,
  episode: null,
  language: "tur",
  wantForced: false,
  releaseTitle: "Fight.Club.1999.1080p.BluRay.x264-SPARKS",
  releaseGroup: null,
  source: null,
  resolution: null,
  videoHash: null,
  durationSeconds: null,
  frameRate: 23.976,
};

const candidate = (
  id: string,
  overrides: Partial<SubtitleCandidate> = {},
): SubtitleCandidate => ({
  providerId: "p",
  candidateId: id,
  language: "tur",
  format: null,
  forced: false,
  hearingImpaired: false,
  releaseTitle: null,
  releaseGroup: null,
  source: null,
  resolution: null,
  hashMatched: false,
  providerRating: null,
  identity: { title: "Fight Club", year: 1999, season: null, episode: null },
  ...overrides,
});

const score = (c: SubtitleCandidate) => {
  const assessed = assessCandidate(
    query,
    normalizeWant({ language: "tur" }),
    c,
    provider,
  );
  if (!assessed.accepted) throw new Error(assessed.reason);
  return assessed.scored;
};

describe("frame rate in subtitle selection", () => {
  it("prefers a subtitle timed for this video's frame rate", () => {
    const [best] = orderCandidates([
      score(candidate("pal", { frameRate: 25 })),
      score(candidate("film", { frameRate: 23.98 })),
    ]);
    expect(best!.candidate.candidateId).toBe("film");
    expect(best!.score.reasons).toContain("Timed for the same frame rate.");
  });

  it("treats 23.976 and 24 as different rates", () => {
    const scored = score(candidate("24", { frameRate: 24 }));
    expect(
      scored.score.components.find((c) => c.dimension === "frameRate")!.matched,
    ).toBe(false);
  });

  it("breaks an equal fit by how many people downloaded it", () => {
    const [best] = orderCandidates([
      score(candidate("a", { providerRating: 10 })),
      score(candidate("b", { providerRating: 5000 })),
    ]);
    expect(best!.candidate.candidateId).toBe("b");
  });
});
