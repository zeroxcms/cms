import type { JWTPayload } from '../types';
import { buildContentSecurityPolicy } from './http';

const PLUGIN_LAUNCH_ISS = 'worker-cms';
const PLUGIN_LAUNCH_AUD = 'worker-cms-plugin-admin';
const PLUGIN_LAUNCH_TTL_SECONDS = 5 * 60;

export interface PluginLaunchPayload {
  iss: typeof PLUGIN_LAUNCH_ISS;
  aud: typeof PLUGIN_LAUNCH_AUD;
  iat: number;
  exp: number;
  jti: string;
  pluginId: string;
  pluginOrigin: string;
  path: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export async function signPluginLaunchToken(opts: {
  pluginId: string;
  pluginOrigin: string;
  path: string;
  user: JWTPayload;
  secret: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: PluginLaunchPayload = {
    iss: PLUGIN_LAUNCH_ISS,
    aud: PLUGIN_LAUNCH_AUD,
    iat: now,
    exp: now + PLUGIN_LAUNCH_TTL_SECONDS,
    jti: randomHex(16),
    pluginId: opts.pluginId,
    pluginOrigin: opts.pluginOrigin,
    path: opts.path,
    user: {
      id: opts.user.sub,
      email: opts.user.email,
      name: opts.user.name,
      role: opts.user.role,
    },
  };
  return signPluginToken(payload, opts.secret);
}

export async function verifyPluginLaunchToken(token: string, secret: string): Promise<PluginLaunchPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const header = JSON.parse(base64urlDecode(headerEncoded)) as { alg?: unknown; typ?: unknown };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecodeBytes(signatureEncoded),
      new TextEncoder().encode(`${headerEncoded}.${payloadEncoded}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(base64urlDecode(payloadEncoded)) as PluginLaunchPayload;
    if (payload.iss !== PLUGIN_LAUNCH_ISS || payload.aud !== PLUGIN_LAUNCH_AUD) return null;
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.pluginId || !payload.pluginOrigin || !payload.path || !payload.user?.id) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildPluginFrameShellCsp(nonce: string, pluginOrigin: string): string {
  return buildContentSecurityPolicy(nonce).replace(
    "frame-ancestors 'none'",
    `frame-src 'self' ${pluginOrigin}; frame-ancestors 'none'`,
  );
}

async function signPluginToken(payload: PluginLaunchPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlEncode(signature)}`;
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

function base64urlEncode(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecodeBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64urlDecode(str: string): string {
  return new TextDecoder().decode(base64urlDecodeBytes(str));
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
