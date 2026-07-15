import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimFormOnceToken,
  extractFormOnceToken,
  mintFormOnceToken,
  releaseFormOnceToken,
} from '../src/utils/form-once';

const SECRET = 'form-once-test-secret';

async function mintSubmitted(suffix = 'aabbccdd'): Promise<string> {
  return `${await mintFormOnceToken(SECRET)}:${suffix}`;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM used_form_tokens').run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('claimFormOnceToken', () => {
  it('claims a freshly minted token once and flags the replay as duplicate', async () => {
    const submitted = await mintSubmitted();
    expect(await claimFormOnceToken(env.DB, SECRET, submitted)).toBe('claimed');
    expect(await claimFormOnceToken(env.DB, SECRET, submitted)).toBe('duplicate');
  });

  it('treats different per-form suffixes of the same page token as distinct submissions', async () => {
    const pageToken = await mintFormOnceToken(SECRET);
    expect(await claimFormOnceToken(env.DB, SECRET, `${pageToken}:1111`)).toBe('claimed');
    expect(await claimFormOnceToken(env.DB, SECRET, `${pageToken}:2222`)).toBe('claimed');
  });

  it('allows a re-claim after the claim is released (failed downstream action)', async () => {
    const submitted = await mintSubmitted();
    expect(await claimFormOnceToken(env.DB, SECRET, submitted)).toBe('claimed');
    await releaseFormOnceToken(env.DB, submitted);
    expect(await claimFormOnceToken(env.DB, SECRET, submitted)).toBe('claimed');
  });

  it('passes through missing tokens as unverified', async () => {
    expect(await claimFormOnceToken(env.DB, SECRET, null)).toBe('unverified');
    expect(await claimFormOnceToken(env.DB, SECRET, '')).toBe('unverified');
  });

  it('rejects tokens signed with a different secret without storing them', async () => {
    const forged = `${await mintFormOnceToken('other-secret')}:aabbccdd`;
    expect(await claimFormOnceToken(env.DB, SECRET, forged)).toBe('unverified');
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM used_form_tokens').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('rejects a tampered signature and a malformed suffix', async () => {
    const submitted = await mintSubmitted();
    const tampered = submitted.replace(/:(.*)$/, 'x:$1');
    expect(await claimFormOnceToken(env.DB, SECRET, tampered)).toBe('unverified');
    const pageToken = await mintFormOnceToken(SECRET);
    expect(await claimFormOnceToken(env.DB, SECRET, `${pageToken}:not a suffix!`)).toBe('unverified');
    expect(await claimFormOnceToken(env.DB, SECRET, pageToken)).toBe('unverified'); // no suffix at all
  });

  it('rejects tokens minted longer than the TTL ago', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 13 * 60 * 60 * 1000);
    const stale = await mintSubmitted();
    vi.useRealTimers();
    expect(await claimFormOnceToken(env.DB, SECRET, stale)).toBe('unverified');
  });
});

describe('extractFormOnceToken', () => {
  it('reads the field from a urlencoded body', async () => {
    const body = new TextEncoder().encode('name=hello&_cms_once=abc.123.sig%3Adeadbeef').buffer as ArrayBuffer;
    expect(await extractFormOnceToken(body, 'application/x-www-form-urlencoded')).toBe('abc.123.sig:deadbeef');
  });

  it('reads the field from a multipart body', async () => {
    const form = new FormData();
    form.set('file', new Blob(['csv,data']), 'import.csv');
    form.set('_cms_once', 'abc.123.sig:deadbeef');
    const request = new Request('http://localhost/', { method: 'POST', body: form });
    const body = await request.arrayBuffer();
    expect(await extractFormOnceToken(body, request.headers.get('content-type') ?? '')).toBe('abc.123.sig:deadbeef');
  });

  it('returns null for absent fields and non-form content types', async () => {
    const urlencoded = new TextEncoder().encode('name=hello').buffer as ArrayBuffer;
    expect(await extractFormOnceToken(urlencoded, 'application/x-www-form-urlencoded')).toBeNull();
    const json = new TextEncoder().encode('{"_cms_once":"x"}').buffer as ArrayBuffer;
    expect(await extractFormOnceToken(json, 'application/json')).toBeNull();
  });
});
