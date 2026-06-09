// Durable Object: one instance per page, handles WebSocket CRDT sync.
//
// Protocol (JSON over WebSocket):
//   Client → Server  { type: 'sync' }
//     → Server replies with snapshot of all stored ops
//   Client → Server  { type: 'op', path, value, hlc, opId }
//     → Server applies LWW merge and broadcasts to all other clients
//   Server → Client  { type: 'snapshot', ops: [...] }
//   Server → Client  { type: 'op', path, value, hlc, userId, userName, opId }
//
// HLC format: "<Date.now()>.<counter>.<userId>" – lexicographic ordering is sufficient.
// path mirrors the lect form-field name (e.g. ".name|en", "@date", "#0.title|en").

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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS crdt_ops (
        path      TEXT PRIMARY KEY,
        value     TEXT NOT NULL,
        hlc       TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        user_name TEXT NOT NULL,
        op_id     TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
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

    if (msg.type === 'op') {
      const path  = String(msg.path  ?? '');
      const value = String(msg.value ?? '');
      const hlc   = String(msg.hlc   ?? '');
      const opId  = String(msg.opId  ?? crypto.randomUUID());

      if (!path || !hlc) return;

      const existing = this.sql.exec(
        `SELECT hlc FROM crdt_ops WHERE path = ?`, path,
      ).toArray()[0] as { hlc: string } | undefined;

      if (!existing || hlc > existing.hlc) {
        this.sql.exec(
          `INSERT OR REPLACE INTO crdt_ops (path, value, hlc, user_id, user_name, op_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          path, value, hlc, userId, userName, opId,
        );

        const broadcast = JSON.stringify({ type: 'op', path, value, hlc, userId, userName, opId });
        for (const other of this.state.getWebSockets()) {
          if (other !== ws) {
            try { other.send(broadcast); } catch { /* already closed */ }
          }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000, 'Closing'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'Error'); } catch { /* already closed */ }
  }
}
