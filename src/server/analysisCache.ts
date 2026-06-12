import { analyseMediaFile } from "../lib/playback-planner/mediaAnalysis";
import type { MediaAnalysis } from "../lib/playback-planner/types";
import type { ResolvedMedia } from "./mediaRegistry";

export interface AnalysisCache {
  getOrAnalyse(media: ResolvedMedia): Promise<MediaAnalysis>;
  clear(): void;
  delete(mediaId: string): void;
}

type AnalyseMediaFile = (
  filePath: string,
  mediaId: string,
) => Promise<MediaAnalysis>;

interface CachedAnalysis {
  mediaId: string;
  cacheKey: string;
  analysis: MediaAnalysis;
}

function makeCacheKey(media: ResolvedMedia): string {
  return `${media.mediaId}\0${media.size}\0${media.mtimeMs}`;
}

export class InMemoryAnalysisCache implements AnalysisCache {
  private entries = new Map<string, CachedAnalysis>();
  private inFlight = new Map<string, Promise<MediaAnalysis>>();
  private analyse: AnalyseMediaFile;

  constructor(analyse: AnalyseMediaFile = analyseMediaFile) {
    this.analyse = analyse;
  }

  getOrAnalyse(media: ResolvedMedia): Promise<MediaAnalysis> {
    const cacheKey = makeCacheKey(media);
    const cached = this.entries.get(cacheKey);

    if (cached) {
      return Promise.resolve(cached.analysis);
    }

    const existing = this.inFlight.get(cacheKey);

    if (existing) {
      return existing;
    }

    // TODO: Replace the in-memory analysis cache with a persistent database cache.
    const pending = this.analyse(media.filePath, media.mediaId)
      .then((analysis) => {
        this.delete(media.mediaId);
        this.entries.set(cacheKey, {
          mediaId: media.mediaId,
          cacheKey,
          analysis,
        });
        return analysis;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  delete(mediaId: string): void {
    for (const [cacheKey, entry] of this.entries.entries()) {
      if (entry.mediaId === mediaId) {
        this.entries.delete(cacheKey);
      }
    }
  }
}
