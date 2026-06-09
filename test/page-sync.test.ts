// Multi-user CRDT sync tests for the PageSyncDO Durable Object.
//
// These connect several real WebSocket clients to one DO instance and exercise
// the sync protocol directly (bypassing the Hono route + auth, which just
// forwards X-User-Id / X-User-Name headers). The focus is correctness with
// MORE THAN THREE concurrent editors: broadcast fan-out, last-write-wins
// convergence, snapshots for late joiners, per-user abandon-on-leave reverts,
// multi-tab handling, and save commits.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

type Json = Record<string, any>;

interface Client {
  userId: string;
  send(msg: Json): void;
  /** Resolve with the next message, or reject after `timeoutMs`. */
  next(timeoutMs?: number): Promise<Json>;
  /** Wait briefly and return every buffered message, clearing the buffer. */
  drain(ms?: number): Promise<Json[]>;
  /** Assert that no message arrives within `ms`. */
  expectSilent(ms?: number): Promise<void>;
  close(code?: number): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic HLC: "<ms>.<counter>.<userId>" — lexicographically ordered. */
function hlc(ms: number, counter: number, userId: string): string {
  return `${ms}.${String(counter).padStart(6, '0')}.${userId}`;
}

let pageCounter = 0;
/** A unique DO name per test so op state never leaks between tests. */
function freshPage(): string {
  return `page-test-${pageCounter++}-${crypto.randomUUID()}`;
}

async function connect(page: string, userId: string, userName = userId): Promise<Client> {
  const stub = env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(page));
  const res = await stub.fetch('https://page-sync/api/sync', {
    headers: { Upgrade: 'websocket', 'X-User-Id': userId, 'X-User-Name': userName },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error('expected a WebSocket from the Durable Object');

  const queue: Json[] = [];
  const waiters: Array<(msg: Json) => void> = [];
  ws.addEventListener('message', (event: MessageEvent) => {
    const data = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  ws.accept();

  return {
    userId,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    next(timeoutMs = 2000) {
      if (queue.length) return Promise.resolve(queue.shift() as Json);
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${userId}: timed out waiting for a message`)), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    async drain(ms = 60) {
      await wait(ms);
      const messages = queue.splice(0, queue.length);
      return messages;
    },
    async expectSilent(ms = 80) {
      await wait(ms);
      expect(queue).toEqual([]);
    },
    close(code = 1000) {
      ws.close(code);
    },
  };
}

function op(path: string, value: string, h: string): Json {
  return { type: 'op', path, value, hlc: h, opId: crypto.randomUUID() };
}

/** Pull a fresh full snapshot from the DO via a throwaway client. */
async function snapshotOf(page: string): Promise<Json[]> {
  const probe = await connect(page, 'probe');
  probe.send({ type: 'sync' });
  const snapshot = await probe.next();
  expect(snapshot.type).toBe('snapshot');
  probe.close();
  return snapshot.ops as Json[];
}

describe('PageSyncDO multi-user sync', () => {
  it('broadcasts one user\'s op to all other connected users, never the sender (4 users)', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send(op('.title|en', 'Hello', hlc(1000, 1, 'A')));

    for (const peer of [b, c, d]) {
      const msg = await peer.next();
      expect(msg).toMatchObject({ type: 'op', path: '.title|en', value: 'Hello', userId: 'A' });
    }
    // Sender is excluded from its own broadcast.
    await a.expectSilent();

    [a, b, c, d].forEach((client) => client.close());
  });

  it('fans every user\'s edits out to the other three (full mesh)', async () => {
    const page = freshPage();
    const clients = await Promise.all(['A', 'B', 'C', 'D'].map((u) => connect(page, u)));

    // Each of the four users edits a distinct field.
    clients.forEach((client, i) => client.send(op(`.f${i}|en`, `v${i}`, hlc(2000 + i, 1, client.userId))));

    // Every client should observe the three edits made by the others.
    for (const receiver of clients) {
      const seen = await receiver.drain(120);
      const fromOthers = seen.filter((m) => m.type === 'op');
      const senders = fromOthers.map((m) => m.userId).sort();
      const expected = clients.map((c) => c.userId).filter((u) => u !== receiver.userId).sort();
      expect(senders).toEqual(expected);
    }

    clients.forEach((client) => client.close());
  });

  it('converges to the highest-HLC write when 4 users edit the same field', async () => {
    const page = freshPage();
    const users = ['A', 'B', 'C', 'D'];
    const clients = await Promise.all(users.map((u) => connect(page, u)));

    // All four write the same path; D has the newest HLC and must win.
    clients[0].send(op('.headline|en', 'from A', hlc(5000, 1, 'A')));
    clients[1].send(op('.headline|en', 'from B', hlc(5001, 1, 'B')));
    clients[2].send(op('.headline|en', 'from C', hlc(5002, 1, 'C')));
    clients[3].send(op('.headline|en', 'from D', hlc(5003, 1, 'D')));

    await Promise.all(clients.map((c) => c.drain(120)));

    // The DO keeps one op per (path,user); the effective value is the max HLC.
    const ops = (await snapshotOf(page)).filter((o) => o.path === '.headline|en');
    expect(ops).toHaveLength(4);
    const winner = ops.reduce((best, o) => (o.hlc > best.hlc ? o : best));
    expect(winner).toMatchObject({ value: 'from D', userId: 'D' });

    clients.forEach((client) => client.close());
  });

  it('ignores and does not rebroadcast a stale (older-HLC) op from the same user', async () => {
    const page = freshPage();
    const [a, b] = await Promise.all([connect(page, 'A'), connect(page, 'B')]);

    a.send(op('.note|en', 'current', hlc(7000, 2, 'A')));
    expect(await b.next()).toMatchObject({ value: 'current' });

    // A's older edit for the same field must be dropped — no broadcast.
    a.send(op('.note|en', 'stale', hlc(6000, 1, 'A')));
    await b.expectSilent();

    const ops = (await snapshotOf(page)).filter((o) => o.path === '.note|en');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ value: 'current' });

    a.close();
    b.close();
  });

  it('gives a late-joining 4th user the full current state via snapshot', async () => {
    const page = freshPage();
    const [a, b, c] = await Promise.all([connect(page, 'A'), connect(page, 'B'), connect(page, 'C')]);

    a.send(op('.f1|en', 'A1', hlc(8000, 1, 'A')));
    b.send(op('.f2|en', 'B2', hlc(8001, 1, 'B')));
    c.send(op('.f3|en', 'C3', hlc(8002, 1, 'C')));
    await Promise.all([a.drain(), b.drain(), c.drain()]);

    // The fourth editor joins and requests a sync.
    const d = await connect(page, 'D');
    d.send({ type: 'sync' });
    const snapshot = await d.next();

    expect(snapshot.type).toBe('snapshot');
    const byPath = Object.fromEntries((snapshot.ops as Json[]).map((o) => [o.path, o]));
    expect(byPath['.f1|en']).toMatchObject({ value: 'A1', userId: 'A' });
    expect(byPath['.f2|en']).toMatchObject({ value: 'B2', userId: 'B' });
    expect(byPath['.f3|en']).toMatchObject({ value: 'C3', userId: 'C' });

    [a, b, c, d].forEach((client) => client.close());
  });

  it('reverts only the leaving user\'s abandoned fields, keeping co-editors\' work (4 users)', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    // A edits F1, F2. B also edits F1 (newer) and F3. C edits F4, D edits F5.
    a.send(op('.f1|en', 'A-f1', hlc(9000, 1, 'A')));
    a.send(op('.f2|en', 'A-f2', hlc(9001, 2, 'A')));
    b.send(op('.f1|en', 'B-f1', hlc(9100, 1, 'B'))); // newer than A's f1
    b.send(op('.f3|en', 'B-f3', hlc(9101, 2, 'B')));
    c.send(op('.f4|en', 'C-f4', hlc(9200, 1, 'C')));
    d.send(op('.f5|en', 'D-f5', hlc(9300, 1, 'D')));

    await Promise.all([a.drain(150), b.drain(150), c.drain(150), d.drain(150)]);

    // A leaves WITHOUT saving.
    a.close();

    // Remaining editors get A's highlight cleared AND a reset for A's paths.
    const msgsB = await b.drain(150);
    expect(msgsB.some((m) => m.type === 'blur' && m.clearAll && m.userId === 'A')).toBe(true);
    const reset = msgsB.find((m) => m.type === 'reset');
    expect(reset).toBeTruthy();
    const entries = Object.fromEntries((reset!.entries as Json[]).map((e) => [e.path, e]));
    expect(Object.keys(entries).sort()).toEqual(['.f1|en', '.f2|en']);
    // F1 still had B's (newer) op → falls back to B's value, not baseline.
    expect(entries['.f1|en']).toMatchObject({ value: 'B-f1' });
    expect(entries['.f1|en'].baseline).toBeUndefined();
    // F2 was A-only → no remaining op → revert to baseline.
    expect(entries['.f2|en']).toMatchObject({ baseline: true });

    // C and D receive the same reset.
    expect((await c.drain(150)).some((m) => m.type === 'reset')).toBe(true);
    expect((await d.drain(150)).some((m) => m.type === 'reset')).toBe(true);

    // Surviving server state: A's solo field is gone; everyone else's remains.
    const ops = Object.fromEntries((await snapshotOf(page)).map((o) => [o.path, o]));
    expect(ops['.f1|en']).toMatchObject({ value: 'B-f1', userId: 'B' });
    expect(ops['.f2|en']).toBeUndefined();
    expect(ops['.f3|en']).toMatchObject({ value: 'B-f3', userId: 'B' });
    expect(ops['.f4|en']).toMatchObject({ value: 'C-f4', userId: 'C' });
    expect(ops['.f5|en']).toMatchObject({ value: 'D-f5', userId: 'D' });

    [b, c, d].forEach((client) => client.close());
  });

  it('does NOT revert when a user closes one tab but keeps another open (multi-tab)', async () => {
    const page = freshPage();
    const [a1, a2, b] = await Promise.all([
      connect(page, 'A', 'Alice'), connect(page, 'A', 'Alice'), connect(page, 'B'),
    ]);

    a1.send(op('.f1|en', 'A-f1', hlc(11000, 1, 'A')));
    await Promise.all([a2.drain(), b.drain()]);

    // Close one of A's two connections.
    a1.close();

    // B must NOT receive a reset — A is still present via the second tab.
    await b.expectSilent(120);
    const ops = (await snapshotOf(page)).filter((o) => o.path === '.f1|en');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ value: 'A-f1', userId: 'A' });

    a2.close();
    b.close();
  });

  it('relays focus/blur editing signals to other users but not the sender', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A', 'Alice'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send({ type: 'focus', path: '.title|en', userAvatar: 'https://img/a.png' });
    for (const peer of [b, c, d]) {
      expect(await peer.next()).toMatchObject({
        type: 'focus', path: '.title|en', userId: 'A', userName: 'Alice', userAvatar: 'https://img/a.png',
      });
    }
    await a.expectSilent();

    a.send({ type: 'blur', path: '.title|en' });
    for (const peer of [b, c, d]) {
      expect(await peer.next()).toMatchObject({ type: 'blur', path: '.title|en', userId: 'A' });
    }

    [a, b, c, d].forEach((client) => client.close());
  });

  it('tells remaining users to clear a leaving user\'s highlights (clearAll)', async () => {
    const page = freshPage();
    const [a, b, c] = await Promise.all([connect(page, 'A'), connect(page, 'B'), connect(page, 'C')]);

    a.send({ type: 'focus', path: '.title|en', userAvatar: '' });
    await Promise.all([b.drain(), c.drain()]);

    a.close();

    for (const peer of [b, c]) {
      expect(await peer.next()).toMatchObject({ type: 'blur', userId: 'A', clearAll: true });
    }

    b.close();
    c.close();
  });

  it('commits on save: clears the overlay, broadcasts "saved", and a later leave reverts nothing', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send(op('.f1|en', 'A-f1', hlc(12000, 1, 'A')));
    b.send(op('.f2|en', 'B-f2', hlc(12001, 1, 'B')));
    await Promise.all([a.drain(), b.drain(), c.drain(), d.drain()]);

    // The save route notifies the DO that the page was committed.
    const stub = env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(page));
    const res = await stub.fetch('https://page-sync/?action=saved', { method: 'POST' });
    expect(res.status).toBe(200);

    // Every connected editor is told the overlay was committed.
    for (const client of [a, b, c, d]) {
      expect(await client.next()).toMatchObject({ type: 'saved' });
    }

    // The op log is now empty.
    expect(await snapshotOf(page)).toEqual([]);

    // A leaving after a save reverts nothing — there are no uncommitted ops.
    // (A highlight-clear may still be relayed, but never a value reset/op.)
    a.close();
    const [mb, mc, md] = await Promise.all([b.drain(120), c.drain(120), d.drain(120)]);
    [mb, mc, md].forEach((messages) => {
      expect(messages.some((m) => m.type === 'reset' || m.type === 'op')).toBe(false);
    });

    [b, c, d].forEach((client) => client.close());
  });
});
