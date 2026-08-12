import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { LibraryKind } from "../scanner/libraryScan";

export interface LibraryDefinition {
  slug: string;
  name: string;
  kind: LibraryKind;
  /** Paths relative to the media root. */
  roots: string[];
  sortOrder?: number;
}

export interface LibraryWithRoots {
  id: string;
  slug: string;
  name: string;
  kind: LibraryKind;
  roots: string[];
}

export interface LibraryRepository {
  listAll(): Promise<LibraryWithRoots[]>;
  getById(libraryId: string): Promise<LibraryWithRoots | null>;
  /** Idempotent: creating the same definition twice changes nothing. */
  provision(definitions: LibraryDefinition[]): Promise<LibraryWithRoots[]>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const KINDS: LibraryKind[] = [
  "movies",
  "series",
  "books",
  "collections",
  "mixed",
];

/**
 * Parses `SEYIRLIK_LIBRARIES`, a JSON array of library definitions.
 *
 * Roots are validated as relative paths here rather than at scan time: a
 * configuration mistake should stop startup with a clear message, not surface
 * later as a traversal attempt from inside the scanner.
 */
export function parseLibraryDefinitions(
  raw: string | undefined,
): LibraryDefinition[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEYIRLIK_LIBRARIES must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SEYIRLIK_LIBRARIES must be a JSON array.");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`SEYIRLIK_LIBRARIES[${index}] must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const slug = candidate.slug;
    const name = candidate.name;
    const kind = candidate.kind;
    const roots = candidate.roots;

    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      throw new Error(
        `SEYIRLIK_LIBRARIES[${index}].slug must be lowercase letters, digits and dashes.`,
      );
    }
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`SEYIRLIK_LIBRARIES[${index}].name is required.`);
    }
    if (typeof kind !== "string" || !KINDS.includes(kind as LibraryKind)) {
      throw new Error(
        `SEYIRLIK_LIBRARIES[${index}].kind must be one of ${KINDS.join(", ")}.`,
      );
    }
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new Error(
        `SEYIRLIK_LIBRARIES[${index}].roots must be non-empty paths relative to the media root.`,
      );
    }

    // Normalize first, then validate. A leading slash is how people naturally
    // write "the Movies folder inside the media root", so it is stripped rather
    // than rejected; a drive letter, a UNC path or a traversal segment is a real
    // configuration error and must stop startup.
    const normalizedRoots = (roots as unknown[]).map((root) => {
      if (typeof root !== "string" || root.includes("\0")) {
        throw new Error(
          `SEYIRLIK_LIBRARIES[${index}].roots must be non-empty paths relative to the media root.`,
        );
      }
      const slashed = root.replace(/\\/g, "/").trim();
      // A drive letter or UNC prefix must be rejected before slashes are
      // stripped, otherwise "//server/share" would normalize into a plausible
      // relative path.
      const isRooted = /^[A-Za-z]:/.test(slashed) || slashed.startsWith("//");
      const normalized = slashed.replace(/^\/+|\/+$/g, "");

      if (
        isRooted ||
        normalized.length === 0 ||
        normalized.split("/").includes("..")
      ) {
        throw new Error(
          `SEYIRLIK_LIBRARIES[${index}].roots must be non-empty paths relative to the media root.`,
        );
      }
      return normalized;
    });

    return {
      slug,
      name: name.trim(),
      kind: kind as LibraryKind,
      roots: normalizedRoots,
      sortOrder: index,
    };
  });
}

export function createLibraryRepository(pool: DatabasePool): LibraryRepository {
  async function loadRoots(
    libraryIds: string[],
  ): Promise<Map<string, string[]>> {
    const roots = new Map<string, string[]>();
    if (libraryIds.length === 0) return roots;

    const result = await pool.query<{
      library_id: string;
      relative_path: string;
    }>(
      `SELECT library_id, relative_path FROM library_roots
       WHERE library_id = ANY($1) ORDER BY relative_path`,
      [libraryIds],
    );
    for (const row of result.rows) {
      const existing = roots.get(row.library_id);
      if (existing) existing.push(row.relative_path);
      else roots.set(row.library_id, [row.relative_path]);
    }
    return roots;
  }

  async function listWithRoots(where: string, values: unknown[]) {
    const result = await pool.query<{
      id: string;
      slug: string;
      name: string;
      kind: LibraryKind;
    }>(
      `SELECT id, slug, name, kind FROM libraries ${where} ORDER BY sort_order, name`,
      values,
    );
    const roots = await loadRoots(result.rows.map((row) => row.id));
    return result.rows.map<LibraryWithRoots>((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      roots: roots.get(row.id) ?? [],
    }));
  }

  return {
    listAll: () => listWithRoots("", []),

    getById: async (libraryId) => {
      const libraries = await listWithRoots("WHERE id = $1", [libraryId]);
      return libraries[0] ?? null;
    },

    provision: async (definitions) => {
      for (const definition of definitions) {
        const result = await pool.query<{ id: string }>(
          `INSERT INTO libraries (id, slug, name, kind, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (slug) DO UPDATE SET
             name = EXCLUDED.name,
             kind = EXCLUDED.kind,
             sort_order = EXCLUDED.sort_order,
             updated_at = now()
           RETURNING id`,
          [
            randomUUID(),
            definition.slug,
            definition.name,
            definition.kind,
            definition.sortOrder ?? 0,
          ],
        );
        const libraryId = result.rows[0]?.id;
        if (!libraryId)
          throw new Error("Library provisioning returned no row.");

        for (const root of definition.roots) {
          await pool.query(
            `INSERT INTO library_roots (id, library_id, relative_path)
             VALUES ($1, $2, $3)
             ON CONFLICT (library_id, relative_path) DO NOTHING`,
            [randomUUID(), libraryId, root],
          );
        }

        // A root removed from configuration stops being scanned; catalogued
        // items beneath it then age out through the normal missing-file grace
        // period rather than vanishing at once.
        await pool.query(
          `DELETE FROM library_roots
           WHERE library_id = $1 AND relative_path <> ALL($2)`,
          [libraryId, definition.roots],
        );
      }

      return listWithRoots("", []);
    },
  };
}
