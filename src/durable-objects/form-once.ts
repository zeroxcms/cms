// Durable Object coordinator for single-use admin form tokens.
//
// Tokens use the built-in key/value storage API rather than an application SQL
// table. The Worker hashes each token and sends it to one of a fixed number of
// shards, so identical submissions are serialized without contending on D1.

const TOKEN_PREFIX = 'token:';
const LIST_PAGE_SIZE = 128;

interface FormOnceRequest {
  action?: unknown;
  tokenHash?: unknown;
  expiresAt?: unknown;
}

export class FormOnceDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    const body = await request.json().catch(() => null) as FormOnceRequest | null;
    const tokenHash = typeof body?.tokenHash === 'string' ? body.tokenHash : '';
    if (!tokenHash) return Response.json({ error: 'invalid_token_hash' }, { status: 400 });
    const key = `${TOKEN_PREFIX}${tokenHash}`;

    if (body?.action === 'claim') {
      const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : NaN;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        return Response.json({ error: 'invalid_expiry' }, { status: 400 });
      }

      const result = await this.state.storage.transaction(async (txn) => {
        const existing = await txn.get<number>(key);
        if (typeof existing === 'number' && existing > Date.now()) {
          return { claim: 'duplicate' as const, alarmAt: existing };
        }
        await txn.put(key, expiresAt);
        return { claim: 'claimed' as const, alarmAt: expiresAt };
      });

      await this.scheduleEarlierAlarm(result.alarmAt);
      return Response.json({ claim: result.claim });
    }

    if (body?.action === 'release') {
      await this.state.storage.delete(key);
      await this.rescheduleAlarm();
      return Response.json({ released: true });
    }

    return Response.json({ error: 'invalid_action' }, { status: 400 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let startAfter: string | undefined;
    let nextExpiry: number | null = null;

    while (true) {
      const page = await this.state.storage.list<number>({
        prefix: TOKEN_PREFIX,
        startAfter,
        limit: LIST_PAGE_SIZE,
      });
      if (!page.size) break;

      const expired: string[] = [];
      for (const [key, expiresAt] of page) {
        startAfter = key;
        if (expiresAt <= now) expired.push(key);
        else if (nextExpiry === null || expiresAt < nextExpiry) nextExpiry = expiresAt;
      }
      if (expired.length) await this.state.storage.delete(expired);
      if (page.size < LIST_PAGE_SIZE) break;
    }

    if (nextExpiry === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(nextExpiry);
  }

  private async scheduleEarlierAlarm(expiresAt: number): Promise<void> {
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null || expiresAt < scheduled) {
      await this.state.storage.setAlarm(expiresAt);
    }
  }

  private async rescheduleAlarm(): Promise<void> {
    let startAfter: string | undefined;
    let nextExpiry: number | null = null;

    while (true) {
      const page = await this.state.storage.list<number>({
        prefix: TOKEN_PREFIX,
        startAfter,
        limit: LIST_PAGE_SIZE,
      });
      if (!page.size) break;
      for (const [key, expiresAt] of page) {
        startAfter = key;
        if (nextExpiry === null || expiresAt < nextExpiry) nextExpiry = expiresAt;
      }
      if (page.size < LIST_PAGE_SIZE) break;
    }

    if (nextExpiry === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(nextExpiry);
  }
}
