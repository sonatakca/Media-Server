import { describe, expect, it } from "vitest";
import {
  normalizeForMatch,
  selectBestMatch,
  titleSimilarity,
  type MatchCandidate,
} from "./matcher";

function candidate(
  providerId: string,
  title: string,
  year?: number,
  extra: Partial<MatchCandidate> = {},
): MatchCandidate {
  return {
    providerId,
    title,
    ...(year === undefined ? {} : { year }),
    ...extra,
  };
}

describe("normalizeForMatch", () => {
  it("folds case, diacritics, punctuation and leading articles", () => {
    expect(normalizeForMatch("The Lord of the Rings: The Two Towers")).toBe(
      "lord of the rings the two towers",
    );
    expect(normalizeForMatch("Amélie")).toBe("amelie");
    expect(normalizeForMatch("Fast & Furious")).toBe("fast and furious");
  });
});

describe("titleSimilarity", () => {
  it("scores an exact match as 1 regardless of punctuation", () => {
    expect(titleSimilarity("Spider-Man: No Way Home", "Spider Man No Way Home")).toBe(1);
  });

  it("does not treat a prefix as a full match", () => {
    expect(titleSimilarity("Dune", "Dune Part Two")).toBeLessThan(0.75);
  });

  it("scores unrelated titles near zero", () => {
    expect(titleSimilarity("Arrival", "Sicario")).toBe(0);
  });
});

describe("selectBestMatch", () => {
  it("returns null when there are no candidates", () => {
    expect(selectBestMatch({ title: "Anything" }, [])).toBeNull();
  });

  it("matches an exact title and year with high confidence", () => {
    const result = selectBestMatch({ title: "The Matrix", year: 1999 }, [
      candidate("603", "The Matrix", 1999),
      candidate("604", "The Matrix Reloaded", 2003),
    ]);

    expect(result?.candidate.providerId).toBe("603");
    expect(result?.confidence).toBe("high");
  });

  it("tolerates a one-year release difference", () => {
    const result = selectBestMatch({ title: "Parasite", year: 2020 }, [
      candidate("496243", "Parasite", 2019),
    ]);
    expect(result?.candidate.providerId).toBe("496243");
    expect(result?.confidence).not.toBe("low");
  });

  it("prefers the correct year when titles are identical", () => {
    const result = selectBestMatch({ title: "Dune", year: 1984 }, [
      candidate("438631", "Dune", 2021, { popularity: 900 }),
      candidate("841", "Dune", 1984, { popularity: 30 }),
    ]);

    expect(result?.candidate.providerId).toBe("841");
  });

  it("does not let popularity outrank a better title match", () => {
    const result = selectBestMatch({ title: "Dune Part Two", year: 2024 }, [
      candidate("438631", "Dune", 2021, { popularity: 5_000 }),
      candidate("693134", "Dune: Part Two", 2024, { popularity: 10 }),
    ]);

    expect(result?.candidate.providerId).toBe("693134");
  });

  it("matches against the original title when the folder uses it", () => {
    const result = selectBestMatch({ title: "Sen to Chihiro no Kamikakushi" }, [
      candidate("129", "Spirited Away", 2001, {
        originalTitle: "Sen to Chihiro no Kamikakushi",
      }),
    ]);

    expect(result?.candidate.providerId).toBe("129");
    expect(result?.confidence).toBe("high");
  });

  it("reports low confidence when two plausible titles are nearly tied", () => {
    const result = selectBestMatch({ title: "The Killer" }, [
      candidate("1", "The Killer", 2023),
      candidate("2", "The Killer", 1989),
    ]);

    expect(result?.confidence).toBe("low");
  });

  it("reports low confidence for a weak title match", () => {
    const result = selectBestMatch({ title: "Some Home Video 2011" }, [
      candidate("5", "Home Alone", 1990),
    ]);

    expect(result?.confidence).toBe("low");
  });

  it("penalises a candidate whose year is far away", () => {
    const near = selectBestMatch({ title: "Alien", year: 1979 }, [
      candidate("348", "Alien", 1979),
    ]);
    const far = selectBestMatch({ title: "Alien", year: 1979 }, [
      candidate("999", "Alien", 2015),
    ]);

    expect(near?.score).toBeGreaterThan(far?.score ?? 0);
    expect(far?.confidence).not.toBe("high");
  });
});
