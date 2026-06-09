// Durable Object: one instance per page, handles WebSocket CRDT sync.
//
// Model: a live overlay of *uncommitted* edits on top of the last-saved page.
// Ops are stored per (path, user_id) so one editor's contributions can be
// removed independently of another's. The effective value of a field is the
// op with the highest HLC across users (last-write-wins).
//
// Protocol (JSON over WebSocket):
//   Client → Server  { type: 'sync' }
//   Client → Server  { type: 'op', path, value, hlc, opId }
//   Server → Client  { type: 'snapshot', ops: [...] }
//   Server → Client  { type: 'op', path, value, hlc, userId, userName, opId }
//   Server → Client  { type: 'reset', entries: [{ path, value, hlc } | { path, baseline: true }] }
//       — sent when an editor leaves without saving: their uncommitted edits are
//         dropped; each affected field falls back to the next editor's value, or
//         to the saved baseline if none remains.
//   Server → Client  { type: 'saved' }
//       — sent (via the save route's HTTP call) when the page is saved: the live
//         overlay is committed, so clients adopt current values as the baseline.
//
// HLC format: "<Date.now()>.<counter>.<userId>" – lexicographic ordering is sufficient.

import type { Env } from '../types';

interface WsAttachment {
  userId: string;
  userName: string;
}

interface CrdtRow {
  path: string;
  value: string;
  hlc: string;
  userId: string;
  userName: string;
  opId: string;
}

export class PageSyncDO implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState, _env: Env) {
    this.sql = state.storage.sql;

    // Migration: earlier versions keyed crdt_ops by path alone. Ops are an
    // ephemeral live overlay, so it's safe to drop a stale-shaped table.
    const cols = this.sql.exec(`PRAGMA table_info(crdt_ops)`).toArray() as Array<{ name: string }>;
    if (cols.length && !cols.some((col) => col.name === 'user_id')) {
      this.sql.exec(`DROP TABLE crdt_ops`);
    }

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS crdt_ops (
        path      TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        user_name TEXT NOT NULL,
        value     TEXT NOT NULL,
        hlc       TEXT NOT NULL,
        op_id     TEXT NOT NULL,
        PRIMARY KEY (path, user_id)
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal call from the save route: commit the live overlay.
    if (url.searchParams.get('action') === 'saved') {
      this.sql.exec(`DELETE FROM crdt_ops`);
      this.broadcast(JSON.stringify({ type: 'saved' }));
      return new Response('ok');
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const userId = request.headers.get('X-User-Id') ?? '';
    const userName = request.headers.get('X-User-Name') ?? '';

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, userName } satisfies WsAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { userId, userName } = ws.deserializeAttachment() as WsAttachment;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (msg.type === 'sync') {
      const ops = this.sql.exec(
        `SELECT path, value, hlc,
                user_id   AS userId,
                user_name AS userName,
                op_id     AS opId
         FROM crdt_ops`,
      ).toArray() as unknown as CrdtRow[];
      ws.send(JSON.stringify({ type: 'snapshot', ops }));
      return;
    }

    // Transient editing-presence signals: which field a user is in. Pure relay,
    // never stored — they only matter while both editors are connected.
    if (msg.type === 'focus') {
      const path = String(msg.path ?? '');
      const userAvatar = String(msg.userAvatar ?? '');
      if (!path) return;
      this.broadcast(JSON.stringify({ type: 'focus', path, userId, userName, userAvatar }), ws);
      return;
    }

    if (msg.type === 'blur') {
      const path = String(msg.path ?? '');
      if (!path) return;
      this.broadcast(JSON.stringify({ type: 'blur', path, userId }), ws);
      return;
    }

    if (msg.type === 'op') {
      const path  = String(msg.path  ?? '');
      const value = String(msg.value ?? '');
      const hlc   = String(msg.hlc   ?? '');
      const opId  = String(msg.opId  ?? crypto.randomUUID());

      if (!path || !hlc) return;

      const existing = this.sql.exec(
        `SELECT hlc FROM crdt_ops WHERE path = ? AND user_id = ?`, path, userId,
      ).toArray()[0] as { hlc: string } | undefined;

      if (!existing || hlc > existing.hlc) {
        this.sql.exec(
          `INSERT OR REPLACE INTO crdt_ops (path, user_id, user_name, value, hlc, op_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          path, userId, userName, value, hlc, opId,
        );

        const broadcast = JSON.stringify({ type: 'op', path, value, hlc, userId, userName, opId });
        this.broadcast(broadcast, ws);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws);
    try { ws.close(1000, 'Closing'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws);
    try { ws.close(1011, 'Error'); } catch { /* already closed */ }
  }

  // When an editor's last connection drops without saving, discard their
  // uncommitted ops and tell remaining clients what each field reverts to.
  private handleDisconnect(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    const userId = attachment?.userId;
    if (!userId) return;

    // Keep ops if the same user still has another connection open (e.g. 2 tabs).
    const stillConnected = this.state.getWebSockets().some(
      (other) => other !== ws && (other.deserializeAttachment() as WsAttachment | null)?.userId === userId,
    );
    if (stillConnected) return;

    // Remove the leaving user's editing highlights from every other client.
    this.broadcast(JSON.stringify({ type: 'blur', userId, clearAll: true }), ws);

    const paths = this.sql.exec(
      `SELECT DISTINCT path FROM crdt_ops WHERE user_id = ?`, userId,
    ).toArray() as unknown as Array<{ path: string }>;
    if (!paths.length) return;

    this.sql.exec(`DELETE FROM crdt_ops WHERE user_id = ?`, userId);

    const entries = paths.map(({ path }) => {
      const winner = this.sql.exec(
        `SELECT value, hlc FROM crdt_ops WHERE path = ? ORDER BY hlc DESC LIMIT 1`, path,
      ).toArray()[0] as { value: string; hlc: string } | undefined;
      return winner ? { path, value: winner.value, hlc: winner.hlc } : { path, baseline: true };
    });

    this.broadcast(JSON.stringify({ type: 'reset', entries }), ws);
  }

  private broadcast(payload: string, except?: WebSocket): void {
    for (const other of this.state.getWebSockets()) {
      if (other !== except) {
        try { other.send(payload); } catch { /* already closed */ }
      }
    }
  }
}
