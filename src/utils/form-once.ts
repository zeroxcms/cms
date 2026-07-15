// ============================================================
// Single-use form-submit tokens ("_cms_once") — server side of the
// double-submit protection that complements the client-side guard in
// views/layout/default.liquid.
//
// Lifecycle:
//   - buildBaseProps() mints a signed page token per admin page render
//     (stateless — no DB write on GET).
//   - The layout's submit guard stamps `<pageToken>:<randomSuffix>` into a
//     hidden `_cms_once` input at first submit, one suffix per form.
//   - proxyToPlugin() claims the full submitted value in D1; a second POST
//     carrying the same value (double click, browser resubmit dialog,
//     network retry) hits the primary key and is rejected as a duplicate.
//   - A claim is released if the downstream work fails, so users can retry.
//
// Missing or unverifiable tokens are allowed through (soft enforcement):
// the token exists to stop accidental duplicates, not to authenticate —
// the admin session already does that.
// ============================================================

import { timingSafeEqualStr } from '../security/plugin-proxy';

export const FORM_ONCE_FIELD = '_cms_once';

/** Page tokens older than this fail verification; claimed rows are kept for
 *  twice this long so a duplicate of a nearly-expired token is still caught. */
const FORM_ONCE_TTL_SECONDS = 12 * 60 * 60;

/** Allowed clock skew when a token's issue time is slightly in the future. */
const CLOCK_SKEW_SECONDS = 5 * 60;

/** Upper bound on a submitted token; anything longer is treated as invalid
 *  rather than stored. Minted tokens are ~100 chars. */
const MAX_TOKEN_LENGTH = 256;

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signPagePart(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`form-once:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return base64urlEncode(signature);
}

/** Mints the signed page token embedded in the admin layout:
 *  `<nonce>.<issuedAtSeconds>.<hmac>` (all base64url-safe characters). */
export async function mintFormOnceToken(secret: string): Promise<string> {
  const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signPagePart(secret, `${nonce}.${issuedAt}`);
  return `${nonce}.${issuedAt}.${signature}`;
}

/** Verifies a submitted `<pageToken>:<suffix>` value: host-minted signature,
 *  within TTL, and a sane per-form suffix. */
async function verifySubmittedToken(secret: string, submitted: string): Promise<boolean> {
  if (submitted.length > MAX_TOKEN_LENGTH) return false;
  const colon = submitted.lastIndexOf(':');
  if (colon <= 0) return false;
  const suffix = submitted.slice(colon + 1);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(suffix)) return false;

  const parts = submitted.slice(0, colon).split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAtRaw, signature] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!nonce || !Number.isInteger(issuedAt) || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + CLOCK_SKEW_SECONDS) return false;
  if (now - issuedAt > FORM_ONCE_TTL_SECONDS) return false;

  const expected = await signPagePart(secret, `${nonce}.${issuedAt}`);
  return timingSafeEqualStr(expected, signature);
}

/** Pulls the `_cms_once` field out of a buffered form POST body
 *  (urlencoded or multipart). Returns null when absent or unparsable. */
export async function extractFormOnceToken(body: ArrayBuffer, contentType: string): Promise<string | null> {
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(new TextDecoder().decode(body));
      return params.get(FORM_ONCE_FIELD);
    }
    if (contentType.includes('multipart/form-data')) {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      const form = await request.formData();
      const value = form.get(FORM_ONCE_FIELD);
      return typeof value === 'string' ? value : null;
    }
  } catch {
    // Malformed body — let the downstream handler produce its own error.
  }
  return null;
}

export type FormOnceClaim = 'claimed' | 'duplicate' | 'unverified';

/**
 * Atomically claims a submitted token. 'duplicate' means this exact value was
 * already claimed — the submission is a repeat and must not be forwarded.
 * 'unverified' covers missing, malformed, forged, and expired tokens; callers
 * allow those through (soft enforcement, see header comment).
 */
export async function claimFormOnceToken(db: D1Database, secret: string, submitted: string | null): Promise<FormOnceClaim> {
  if (!submitted) return 'unverified';
  if (!(await verifySubmittedToken(secret, submitted))) return 'unverified';
  // RETURNING (not meta.changes) confirms whether this call inserted the row.
  const claimed = await db
    .prepare('INSERT INTO used_form_tokens (token, used_at) VALUES (?1, ?2) ON CONFLICT (token) DO NOTHING RETURNING token')
    .bind(submitted, Math.floor(Date.now() / 1000))
    .all();
  return claimed.results.length > 0 ? 'claimed' : 'duplicate';
}

/** Releases a claim after the downstream work failed, so a retry of the same
 *  form (same token) is not misread as a duplicate. */
export async function releaseFormOnceToken(db: D1Database, submitted: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM used_form_tokens WHERE token = ?1').bind(submitted).run();
  } catch (error) {
    // Worst case the user sees one spurious "already submitted" on retry.
    console.error('form-once: failed to release claim', error);
  }
}

/** Occasionally prunes rows old enough that their page token can no longer
 *  verify anyway. Call fire-and-forget (waitUntil) after a successful claim. */
export function maybeCleanupFormOnceTokens(db: D1Database): Promise<unknown> | null {
  if (Math.random() >= 0.02) return null;
  const cutoff = Math.floor(Date.now() / 1000) - FORM_ONCE_TTL_SECONDS * 2;
  return db
    .prepare('DELETE FROM used_form_tokens WHERE used_at < ?1')
    .bind(cutoff)
    .run()
    .catch((error) => console.error('form-once: cleanup failed', error));
}
