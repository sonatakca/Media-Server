import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CSRF_NONCE_BYTES = 24;
const CSRF_TOKEN_PATTERN = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/;

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function csrfSignature(
  sessionTokenHash: Buffer,
  nonce: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update("seyirlik-csrf\0")
    .update(sessionTokenHash)
    .update("\0")
    .update(nonce)
    .digest("base64url");
}

export function createCsrfToken(
  sessionTokenHash: Buffer,
  secret: string,
  randomBytesFactory: (size: number) => Buffer = randomBytes,
): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SEYIRLIK_CSRF_SECRET must be at least 32 bytes.");
  }

  const nonceBytes = randomBytesFactory(CSRF_NONCE_BYTES);
  if (nonceBytes.length !== CSRF_NONCE_BYTES) {
    throw new Error("CSRF nonce factory returned an invalid nonce.");
  }
  const nonce = nonceBytes.toString("base64url");
  return `${nonce}.${csrfSignature(sessionTokenHash, nonce, secret)}`;
}

export function verifyCsrfToken({
  cookieToken,
  headerToken,
  sessionTokenHash,
  secret,
}: {
  cookieToken: string | undefined;
  headerToken: string | undefined;
  sessionTokenHash: Buffer;
  secret: string;
}): boolean {
  if (
    !cookieToken ||
    !headerToken ||
    !constantTimeStringEqual(cookieToken, headerToken)
  ) {
    return false;
  }

  const match = CSRF_TOKEN_PATTERN.exec(cookieToken);
  if (!match || Buffer.byteLength(secret, "utf8") < 32) {
    return false;
  }

  const nonce = match[1] as string;
  const providedSignature = match[2] as string;
  const expectedSignature = csrfSignature(sessionTokenHash, nonce, secret);
  return constantTimeStringEqual(providedSignature, expectedSignature);
}
