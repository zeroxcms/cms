import { describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../src/types';
import { withD1Sessions } from '../src/utils/d1-sessions';

describe('withD1Sessions', () => {
  it('starts both database bindings on the primary', () => {
    const dbSession = { prepare: vi.fn(), batch: vi.fn() };
    const publishedSession = { prepare: vi.fn(), batch: vi.fn() };
    const db = { withSession: vi.fn(() => dbSession) };
    const publishedDb = { withSession: vi.fn(() => publishedSession) };
    const env = {
      DB: db,
      PUBLISHED_DB: publishedDb,
      VIEWS: {},
    } as unknown as WorkerEnv;

    const sessionEnv = withD1Sessions(env);

    expect(db.withSession).toHaveBeenCalledWith('first-primary');
    expect(publishedDb.withSession).toHaveBeenCalledWith('first-primary');
    expect(sessionEnv.DB).toBe(dbSession);
    expect(sessionEnv.PUBLISHED_DB).toBe(publishedSession);
    expect(sessionEnv.VIEWS).toBe(env.VIEWS);
  });
});
