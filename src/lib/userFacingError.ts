import { OwnApiClientError } from "../api/ownApi/client";
import type { TranslationKey } from "../i18n/translations";
import { formatTemplate } from "./format";
import { describeErrorSafely } from "./safeErrorText";

/**
 * An error, said in the language the page is in.
 *
 * The API client and the server both describe failures in English, and pages
 * used to put that `message` straight on screen — so a Turkish page could show
 * "Seyirlik returned an invalid response." beside its own "Tekrar dene". The
 * English messages stay where they are, for logs and tests; this is the one
 * place that turns a failure into copy a person reads.
 *
 * Only codes whose meaning is one fixed sentence are listed. A code the server
 * uses for several different explanations (VALIDATION_FAILED,
 * PROCESSING_PACKAGE_INCOMPLETE, …) is left out on purpose: its message is the
 * useful part, so it falls through to the caller's fallback with the redacted
 * original attached rather than being flattened into something vaguer.
 */
const API_ERROR_KEYS: ReadonlyMap<string, TranslationKey> = new Map(
  Object.entries<TranslationKey>({
    // Raised by the client itself, before or instead of a server answer.
    INVALID_RESPONSE: "apiError.invalidResponse",
    INVALID_REQUEST_ID: "apiError.requestNotSent",
    INVALID_REQUEST_BODY: "apiError.requestNotSent",
    CSRF_TOKEN_UNAVAILABLE: "apiError.requestNotVerified",
    REQUEST_ABORTED: "apiError.requestCancelled",
    NETWORK_ERROR: "apiError.network",
    HTTP_ERROR: "apiError.requestFailed",

    // Sent by the server.
    AUTH_REQUIRED: "apiError.authRequired",
    FORBIDDEN: "apiError.forbidden",
    CSRF_REJECTED: "apiError.requestNotVerified",
    AUTH_RATE_LIMITED: "apiError.rateLimited",
    REQUEST_BODY_TOO_LARGE: "apiError.bodyTooLarge",
    INTERNAL_SERVER_ERROR: "apiError.internal",
    NOT_FOUND: "apiError.notFound",
    ITEM_NOT_FOUND: "apiError.notFound",
    MEDIA_NOT_FOUND: "apiError.notFound",
    SOURCE_UNAVAILABLE: "apiError.sourceUnavailable",
    PROCESSING_JOB_NOT_FOUND: "apiError.processingJobNotFound",
    PROCESSING_JOB_EXISTS: "apiError.processingJobExists",
    PROCESSING_JOB_ACTIVE: "apiError.processingJobActive",
    PROCESSING_JOB_NOT_RESUMABLE: "apiError.processingJobNotResumable",
    PROCESSING_JOB_CANCELLING: "apiError.processingJobCancelling",
    PROCESSING_ALREADY_CURRENT: "apiError.processingAlreadyCurrent",
    PROCESSING_STORAGE_GUARDED: "apiError.processingStorageGuarded",
    PROCESSING_STORAGE_NOT_VERIFIED: "apiError.processingStorageNotVerified",
    PROCESSING_STORAGE_UNAVAILABLE: "apiError.processingStorageUnavailable",
  }),
);

type Translate = (key: TranslationKey) => string;

function translatedApiError(error: unknown, t: Translate): string | null {
  if (!(error instanceof OwnApiClientError)) return null;
  const key = API_ERROR_KEYS.get(error.code);
  return key ? t(key) : null;
}

function safeRawText(error: unknown): string {
  return error instanceof Error ? describeErrorSafely(error, "") : "";
}

/**
 * What went wrong, on its own: the translated copy for a known code, else the
 * redacted original, else "". For a place that already has a heading saying
 * the action failed — a toast's description, a "Label: …" line.
 */
export function describeErrorDetail(error: unknown, t: Translate): string {
  return translatedApiError(error, t) ?? safeRawText(error);
}

/**
 * A complete sentence for a place with nothing else around it. A known code
 * gets its translated copy; anything else gets the caller's fallback, with the
 * redacted original after it when there is one.
 */
export function describeErrorForUser(
  error: unknown,
  t: Translate,
  fallbackKey: TranslationKey = "common.somethingWentWrong",
): string {
  const translated = translatedApiError(error, t);
  if (translated) return translated;

  const fallback = t(fallbackKey);
  const detail = safeRawText(error);

  return detail
    ? formatTemplate(t("apiError.withDetail"), {
        message: fallback.replace(/\.$/, ""),
        detail,
      })
    : fallback;
}
