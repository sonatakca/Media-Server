import { describe, expect, it, vi } from "vitest";
import { createOwnApiClient, OwnApiClientError } from "../api/ownApi/client";
import { translations, type TranslationKey } from "../i18n/translations";
import { describeErrorForUser } from "./userFacingError";

const tr = (key: TranslationKey) => translations.tr[key];
const en = (key: TranslationKey) => translations.en[key];

function apiError(code: string, message: string) {
  return new OwnApiClientError({ status: 409, code, message });
}

describe("errors said in the page's language", () => {
  it("puts the client's own invalid-response failure in Turkish", async () => {
    // The real failure, from the real client: a 200 whose body is not JSON.
    const client = createOwnApiClient({
      fetchImpl: vi.fn(
        async () =>
          new Response("<!doctype html>", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "request-id",
            },
          }),
      ),
      requestIdFactory: () => "request-id",
      csrfTokenProvider: () => "csrf-token",
    });
    const error = await client
      .request("/processing/overview")
      .catch((reason: unknown) => reason);

    // The English message is still there for logs and the client's own tests.
    expect(error).toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Seyirlik returned an invalid response.",
    });
    expect(describeErrorForUser(error, tr)).toBe(
      translations.tr["apiError.invalidResponse"],
    );
    expect(describeErrorForUser(error, en)).toBe(
      translations.en["apiError.invalidResponse"],
    );
  });

  it.each([
    "INVALID_RESPONSE",
    "INVALID_REQUEST_ID",
    "INVALID_REQUEST_BODY",
    "CSRF_TOKEN_UNAVAILABLE",
    "REQUEST_ABORTED",
    "NETWORK_ERROR",
    "HTTP_ERROR",
  ])("has its own copy for the client code %s", (code) => {
    const text = describeErrorForUser(apiError(code, "English text."), tr);

    expect(text).not.toContain("English text");
    expect(text).not.toBe(translations.tr["common.somethingWentWrong"]);
  });

  it("uses the mapped copy instead of the server's English for a known code", () => {
    expect(
      describeErrorForUser(
        apiError("PROCESSING_JOB_EXISTS", "This file already has a job."),
        tr,
        "processing.storage.verifyFailed",
      ),
    ).toBe(translations.tr["apiError.processingJobExists"]);
  });

  it("keeps the server's explanation, redacted, when the code has no copy", () => {
    const text = describeErrorForUser(
      apiError(
        "VALIDATION_FAILED",
        "profile must be one of hevc-10, read from /Volumes/Expansion/x",
      ),
      tr,
      "processing.storage.verifyFailed",
    );

    // "Depolama doğrulanamadı." loses its full stop before the colon.
    expect(text).toBe(
      "Depolama doğrulanamadı: profile must be one of hevc-10, read from",
    );
    expect(text).not.toContain("/Volumes");
  });

  it("treats a code inherited from Object.prototype as unknown", () => {
    expect(describeErrorForUser(apiError("toString", "Nope."), tr)).toBe(
      "Bir şeyler ters gitti: Nope.",
    );
  });

  it("falls back to the caller's copy when there is nothing to add", () => {
    expect(
      describeErrorForUser(undefined, tr, "processing.previewUnavailable"),
    ).toBe(translations.tr["processing.previewUnavailable"]);
    expect(describeErrorForUser(new Error(""), tr)).toBe(
      translations.tr["common.somethingWentWrong"],
    );
    expect(describeErrorForUser({ message: "not an Error" }, tr)).toBe(
      translations.tr["common.somethingWentWrong"],
    );
  });
});
