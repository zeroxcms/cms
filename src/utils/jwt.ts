// ============================================================
// JWT utilities using the Web Crypto API (no external deps)
// Implements HS256-signed JWTs compatible with RFC 7519
// ============================================================

import type { JWTPayload } from '../types';

function base64urlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  return atob(padded);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign a JWT payload with HS256.  `exp` must be provided as a Unix timestamp. */
export async function signJWT(
  payload: Omit<JWTPayload, 'iat'> & Partial<Pick<JWTPayload, 'iat'>>,
  secret: string,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    ...(payload as JWTPayload),
    iat: payload.iat ?? now,
  };

  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** Verify a JWT and return its payload, or null if invalid / expired. */
export async function verifyJWT(
  token: string,
  secret: string,
): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const signingInput = `${headerEncoded}.${payloadEncoded}`;

    const key = await importHmacKey(secret);
    const signatureBytes = Uint8Array.from(
      atob(signatureEncoded.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );
    if (!valid) return null;

    const payload = JSON.parse(base64urlDecode(payloadEncoded)) as JWTPayload;

    // Reject expired tokens
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Hash a token with SHA-256 for safe storage in the database. */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generate a cryptographically random opaque token (for use as jti). */
export function generateTokenId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
