import { ownApiClient } from "../api/ownApi/client";
import type { ReaderPlace } from "../pages/reader/readerModel";

/** Where a reader stands in a book, as the server keeps it for every device. */
export interface BookPosition {
  cfi: string | null;
  place: ReaderPlace | null;
  fraction: number;
  /** When the reader was there, in ms since the epoch. */
  readAt: number;
}

interface BookPositionDto {
  cfi: string | null;
  place: ReaderPlace | null;
  fraction: number;
  readAt: string;
}

function fromDto(dto: BookPositionDto | null): BookPosition | null {
  if (!dto) return null;
  const readAt = Date.parse(dto.readAt);
  return Number.isFinite(readAt) ? { ...dto, readAt } : null;
}

export async function getBookPosition(
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BookPosition | null> {
  return fromDto(
    await ownApiClient.request<BookPositionDto | null>(
      `/books/${encodeURIComponent(itemId)}/position`,
      { signal: options.signal, background: true },
    ),
  );
}

/**
 * Saves the place. A later place saved from another device wins; the reply
 * carries whichever place is now on record.
 */
export async function saveBookPosition(
  itemId: string,
  position: BookPosition,
  options: { keepalive?: boolean } = {},
): Promise<{ accepted: boolean; position: BookPosition | null }> {
  const result = await ownApiClient.request<{
    accepted: boolean;
    position: BookPositionDto | null;
  }>(`/books/${encodeURIComponent(itemId)}/position`, {
    method: "PUT",
    background: true,
    keepalive: options.keepalive,
    body: {
      ...(position.cfi ? { cfi: position.cfi } : {}),
      ...(position.place ? { place: position.place } : {}),
      fraction: position.fraction,
      readAt: Math.round(position.readAt),
    },
  });
  return { accepted: result.accepted, position: fromDto(result.position) };
}
