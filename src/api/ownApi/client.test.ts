import { describe, expect, it, vi } from "vitest";
import {
  createOwnApiClient,
  OwnApiClientError,
  type OwnApiHealthResponse,
} from "./client";

describe("own API browser client", () => {
  it("runtime-validates native current-user responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              user: {
                id: "user-1",
                username: "person",
                displayName: "Person",
                isAdministrator: true,
              },
            },
            requestId: "identity-request",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "identity-request",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "identity-request",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getCurrentUser()).resolves.toEqual({
      id: "user-1",
      username: "person",
      displayName: "Person",
      isAdministrator: true,
    });
  });

  it("rejects unsafe native user DTOs rather than accepting database records", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              user: {
                id: "user-1",
                username: "person",
                displayName: "Person",
                isAdministrator: true,
                passwordHash: "$argon2id$must-not-be-accepted",
              },
            },
            requestId: "unsafe-identity-request",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "unsafe-identity-request",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "unsafe-identity-request",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("adds CSRF tokens to refresh/logout and preserves 204 correlation", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          data: {
            user: {
              id: "user-1",
              username: "person",
              displayName: "Person",
              isAdministrator: false,
            },
          },
          requestId: "refresh-request",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "refresh-request",
          },
        },
      ),
      new Response(null, {
        status: 204,
        headers: { "X-Request-Id": "logout-request" },
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const ids = ["refresh-request", "logout-request"];
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => ids.shift() as string,
      csrfTokenProvider: () => "csrf-token",
    });

    await client.refreshSession();
    await client.logout();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/ownAPI/v1/auth/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/ownAPI/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token" }),
      }),
    );
  });

  it("uses the relative versioned base path, cookies, and request IDs", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              status: "ok",
              alive: true,
              ready: false,
              checks: {
                database: "unavailable",
                jobs: "disabled",
                ffmpeg: "available",
                ffprobe: "available",
                mediaStorage: "available",
                generatedStorage: "writable",
              },
            },
            requestId: "browser-request-id",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "browser-request-id",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "browser-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    const health = await client.getHealth();

    expect(health.ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/ownAPI/v1/health",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        headers: expect.objectContaining({
          Accept: "application/json",
          "X-Request-Id": "browser-request-id",
        }),
      }),
    );
  });

  it("sends JSON without allowing an absolute or traversing API path", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { ok: true }, requestId: "req-1" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "req-1",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "req-1",
      csrfTokenProvider: () => "csrf-token",
    });

    await client.request<{ ok: boolean }>("/auth/login", {
      method: "POST",
      body: { username: "person" },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/ownAPI/v1/auth/login",
      expect.objectContaining({
        body: JSON.stringify({ username: "person" }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    await expect(
      client.request("https://jellyfin.invalid/Users"),
    ).rejects.toThrow("Own API paths must be relative");
    await expect(client.request("/../private")).rejects.toThrow(
      "Own API paths must be relative",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends binary files directly with request correlation and CSRF", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { ok: true }, requestId: "binary-request" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "binary-request",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "binary-request",
      csrfTokenProvider: () => "csrf-token",
    });
    const image = new Blob(["image-bytes"], { type: "image/webp" });

    await client.request("/admin/items/item-1/artwork/upload?kind=poster", {
      method: "POST",
      binaryBody: image,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/ownAPI/v1/admin/items/item-1/artwork/upload?kind=poster",
      expect.objectContaining({
        body: image,
        headers: expect.objectContaining({
          "Content-Type": "image/webp",
          "X-CSRF-Token": "csrf-token",
          "X-Request-Id": "binary-request",
        }),
      }),
    );
  });

  it("normalizes safe structured errors and reports authentication expiry", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "AUTH_REQUIRED",
              message: "Authentication is required.",
              requestId: "auth-request-id",
            },
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "auth-request-id",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      onUnauthorized,
      requestIdFactory: () => "auth-request-id",
    });

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnApiClientError);
    expect(error).toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Authentication is required.",
      requestId: "auth-request-id",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-JSON server errors as invalid responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("private stack and filesystem path", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "X-Request-Id": "header-request-id" },
        }),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "header-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      status: 500,
      code: "INVALID_RESPONSE",
      message: "Seyirlik returned an invalid response.",
      requestId: "header-request-id",
    });
  });

  it("normalizes malformed successful JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{not-json", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "response-request-id",
          },
        }),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "response-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      requestId: "response-request-id",
    });
  });

  it.each([
    { status: "ok", alive: "yes", ready: false, checks: {} },
    { status: "degraded", alive: true, ready: false, checks: {} },
    {
      status: "ok",
      alive: true,
      ready: false,
      checks: {
        database: "available",
        jobs: "available",
        ffmpeg: "available",
        ffprobe: "available",
        mediaStorage: "available",
        generatedStorage: "available",
      },
    },
  ])("rejects a malformed health payload %#", async (data) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data, requestId: "health-validation-request" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "health-validation-request",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "health-validation-request",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      requestId: "health-validation-request",
    });
  });

  it("preserves collection pagination and response correlation", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "movie-1" }],
            pagination: { limit: 25, nextCursor: "cursor-2", total: 60 },
            requestId: "collection-request-id",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "collection-request-id",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "collection-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(
      client.requestCollection<{ id: string }>("/libraries/library-1/items"),
    ).resolves.toEqual({
      data: [{ id: "movie-1" }],
      pagination: { limit: 25, nextCursor: "cursor-2", total: 60 },
      requestId: "collection-request-id",
    });
  });

  it("rejects invalid generated request IDs and ignores header overrides", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: { ok: true },
            requestId: "safe-client-request-id",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "safe-client-request-id",
            },
          },
        ),
    );
    const invalidClient = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => `invalid ${"x".repeat(200)}`,
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(invalidClient.request("/health")).rejects.toMatchObject({
      status: 0,
      code: "INVALID_REQUEST_ID",
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "safe-client-request-id",
      csrfTokenProvider: () => "csrf-token",
    });
    await client.request("/health", {
      headers: { "x-request-id": "attacker-override" },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/ownAPI/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Request-Id": "safe-client-request-id",
        }),
      }),
    );
    const requestHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(requestHeaders["x-request-id"]).toBeUndefined();
  });

  it("normalizes network failures without leaking the transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("private upstream and filesystem detail");
    });
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "network-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Seyirlik could not reach the server.",
      requestId: "network-request-id",
    });
  });

  it("rejects missing or mismatched response correlation", async () => {
    const onUnauthorized = vi.fn();
    const responses = [
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({ data: { ok: true }, requestId: "body-request-id" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "header-request-id",
          },
        },
      ),
      new Response(
        JSON.stringify({
          error: {
            code: "AUTH_REQUIRED",
            message: "Authentication is required.",
            requestId: "wrong-error-id",
          },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "correlation-request-id",
          },
        },
      ),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const client = createOwnApiClient({
      fetchImpl,
      onUnauthorized,
      requestIdFactory: () => "correlation-request-id",
    });

    await expect(client.request("/health")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "correlation-request-id",
    });
    await expect(client.request("/health")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "correlation-request-id",
    });
    await expect(client.request("/health")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "correlation-request-id",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("distinguishes request serialization failures from network errors", async () => {
    const fetchImpl = vi.fn();
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "serialization-request-id",
      csrfTokenProvider: () => "csrf-token",
    });
    const circularBody: Record<string, unknown> = {};
    circularBody.self = circularBody;

    await expect(
      client.request("/auth/login", { method: "POST", body: circularBody }),
    ).rejects.toMatchObject({
      status: 0,
      code: "INVALID_REQUEST_BODY",
      requestId: "serialization-request-id",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not demand a CSRF token to sign in", async () => {
    // There is no session yet, so nothing could have issued one; the server
    // verifies login by strict origin instead.
    let csrfHeader: string | null = "unset";
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      csrfHeader = new Headers(init?.headers).get("X-CSRF-Token");
      return new Response(
        JSON.stringify({
          data: {
            user: {
              id: "user-1",
              username: "person",
              displayName: "Person",
              isAdministrator: false,
            },
          },
          requestId: "login",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "login",
          },
        },
      );
    });

    const client = createOwnApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => "login",
      // No readable cookie, as on a fresh browser.
      csrfTokenProvider: () => undefined,
    });

    await expect(
      client.login({ username: "person", password: "secret" }),
    ).resolves.toMatchObject({ id: "user-1" });
    expect(csrfHeader).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("attaches CSRF evidence to every unsafe method without being asked", async () => {
    const seen: Array<{ method: string; csrf: string | undefined }> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? "GET",
        csrf: headers.get("X-CSRF-Token") ?? undefined,
      });
      return new Response(null, {
        status: 204,
        headers: { "X-Request-Id": "unsafe-request" },
      });
    });
    const client = createOwnApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => "unsafe-request",
      csrfTokenProvider: () => "csrf-token",
    });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      await client.request<void>("/items/x/played", { method });
    }

    expect(seen).toHaveLength(4);
    expect(seen.every((call) => call.csrf === "csrf-token")).toBe(true);
  });

  it("does not attach CSRF evidence to a read", async () => {
    let csrfHeader: string | null = "unset";
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      csrfHeader = new Headers(init?.headers).get("X-CSRF-Token");
      return new Response(JSON.stringify({ data: [], requestId: "read" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "read",
        },
      });
    });
    const client = createOwnApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => "read",
      csrfTokenProvider: () => "csrf-token",
    });

    await client.request("/libraries");
    expect(csrfHeader).toBeNull();
  });

  it("reissues a CSRF token when the browser holds a session but no readable one", async () => {
    const calls: string[] = [];
    let hasToken = false;
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/csrf")) {
        // Standing in for the Set-Cookie the browser would store.
        hasToken = true;
        return new Response(
          JSON.stringify({ data: { csrfToken: "fresh" }, requestId: "csrf" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "csrf",
            },
          },
        );
      }
      return new Response(null, {
        status: 204,
        headers: { "X-Request-Id": "mutation" },
      });
    });

    const client = createOwnApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestIdFactory: () => "mutation",
      csrfTokenProvider: () => (hasToken ? "fresh" : undefined),
    });

    await expect(
      client.request<void>("/items/x/played", { method: "POST" }),
    ).resolves.toBeUndefined();
    expect(calls.some((url) => url.endsWith("/auth/csrf"))).toBe(true);
  });

  it("accepts a 204 response only when its request ID matches", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "X-Request-Id": "no-content-request-id" },
        }),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "no-content-request-id",
      csrfTokenProvider: () => "csrf-token",
    });

    await expect(
      client.request<void>("/sessions/current", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it.each([undefined, "different-request-id"])(
    "rejects a 204 response with correlation %s",
    async (responseRequestId) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(null, {
            status: 204,
            headers: responseRequestId
              ? { "X-Request-Id": responseRequestId }
              : undefined,
          }),
      );
      const client = createOwnApiClient({
        fetchImpl,
        requestIdFactory: () => "no-content-request-id",
        csrfTokenProvider: () => "csrf-token",
      });

      await expect(
        client.request<void>("/sessions/current", { method: "DELETE" }),
      ).rejects.toMatchObject({
        status: 204,
        code: "INVALID_RESPONSE",
        requestId: "no-content-request-id",
      });
    },
  );

  it("accepts an abort signal without creating hidden retries", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              status: "ok",
              alive: true,
              ready: false,
              checks: {
                database: "unavailable",
                jobs: "disabled",
                ffmpeg: "available",
                ffprobe: "available",
                mediaStorage: "available",
                generatedStorage: "writable",
              },
            } satisfies OwnApiHealthResponse,
            requestId: "req-1",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "req-1",
            },
          },
        ),
    );
    const client = createOwnApiClient({
      fetchImpl,
      requestIdFactory: () => "req-1",
      csrfTokenProvider: () => "csrf-token",
    });
    const controller = new AbortController();

    await client.getHealth({ signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
