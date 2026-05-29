// ============================================================
// PKCE (Proof Key for Code Exchange) helpers – RFC 7636
// Required by OAuth 2.1 for all public clients
// ============================================================

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Generate a random code verifier (43-128 chars of base64url). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32); // 256 bits → 43 base64url chars
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** Derive the S256 code challenge from a verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64urlEncode(hash);
}

/** Generate a random state parameter for CSRF protection. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
