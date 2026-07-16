import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

describe('claimFormOnceToken', () => {
  it('claims a freshly minted token once and flags the replay as duplicate', async () => {
    const submitted = await mintSubmitted();
    expect(await claimFormOnceToken(env, SECRET, submitted)).toBe('claimed');
    expect(await claimFormOnceToken(env, SECRET, submitted)).toBe('duplicate');
  });

  it('serializes concurrent claims so exactly one request wins', async () => {
    const submitted = await mintSubmitted();
    const claims = await Promise.all(Array.from(
      { length: 8 },
      () => claimFormOnceToken(env, SECRET, submitted),
    ));
    expect(claims.filter((claim) => claim === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim === 'duplicate')).toHaveLength(7);
  });

  it('treats different per-form suffixes of the same page token as distinct submissions', async () => {
    const pageToken = await mintFormOnceToken(SECRET);
    expect(await claimFormOnceToken(env, SECRET, `${pageToken}:1111`)).toBe('claimed');
    expect(await claimFormOnceToken(env, SECRET, `${pageToken}:2222`)).toBe('claimed');
  });

  it('allows a re-claim after the claim is released (failed downstream action)', async () => {
    const submitted = await mintSubmitted();
    expect(await claimFormOnceToken(env, SECRET, submitted)).toBe('claimed');
    await releaseFormOnceToken(env, submitted);
    expect(await claimFormOnceToken(env, SECRET, submitted)).toBe('claimed');
  });

  it('passes through missing tokens as unverified', async () => {
    expect(await claimFormOnceToken(env, SECRET, null)).toBe('unverified');
    expect(await claimFormOnceToken(env, SECRET, '')).toBe('unverified');
  });

  it('rejects tokens signed with a different secret without storing them', async () => {
    const forged = `${await mintFormOnceToken('other-secret')}:aabbccdd`;
    expect(await claimFormOnceToken(env, SECRET, forged)).toBe('unverified');
  });

  it('rejects a tampered signature and a malformed suffix', async () => {
    const submitted = await mintSubmitted();
    const tampered = submitted.replace(/:(.*)$/, 'x:$1');
    expect(await claimFormOnceToken(env, SECRET, tampered)).toBe('unverified');
    const pageToken = await mintFormOnceToken(SECRET);
    expect(await claimFormOnceToken(env, SECRET, `${pageToken}:not a suffix!`)).toBe('unverified');
    expect(await claimFormOnceToken(env, SECRET, pageToken)).toBe('unverified'); // no suffix at all
  });

  it('rejects tokens minted longer than the TTL ago', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 31 * 60 * 1000);
    const stale = await mintSubmitted();
    vi.useRealTimers();
    expect(await claimFormOnceToken(env, SECRET, stale)).toBe('unverified');
  });
});

describe('FormOnceDO cleanup', () => {
  it('uses key/value storage and removes expired claims when its alarm runs', async () => {
    const stub = env.FORM_ONCE.get(env.FORM_ONCE.idFromName(`alarm-test-${crypto.randomUUID()}`));
    const now = Date.now();

    for (const [tokenHash, expiresAt] of [
      ['expired-token', now + 60_000],
      ['live-token', now + 120_000],
    ] as const) {
      const response = await stub.fetch('https://form-once/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'claim', tokenHash, expiresAt }),
      });
      expect(response.status).toBe(200);
    }

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('token:expired-token', now - 1);
      await state.storage.setAlarm(now + 5 * 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('token:expired-token')).toBeUndefined();
      expect(await state.storage.get('token:live-token')).toBe(now + 120_000);
      expect(await state.storage.getAlarm()).toBe(now + 120_000);
      expect(state.storage.sql.exec(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'used_tokens'`,
      ).toArray()).toEqual([]);
    });
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
