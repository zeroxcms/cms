import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveAsset,
  computeIntegrity,
  getAssetApproval,
  listApprovals,
  revokeAsset,
} from '../src/utils/plugin-assets';
import {
  approvePageTypeAccess,
  getPageTypeApproval,
  listPageTypeApprovals,
  revokePageTypeAccess,
} from '../src/utils/plugin-page-types';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM plugin_asset_approvals').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
});

describe('computeIntegrity', () => {
  it('produces a stable sha384 SRI hash for the same bytes', async () => {
    const bytes = new TextEncoder().encode('console.log(1)').buffer;
    const a = await computeIntegrity(bytes);
    const b = await computeIntegrity(bytes);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
  });

  it('produces a different hash when bytes change', async () => {
    const a = await computeIntegrity(new TextEncoder().encode('console.log(1)').buffer);
    const b = await computeIntegrity(new TextEncoder().encode('console.log(2)').buffer);
    expect(a).not.toBe(b);
  });
});

describe('plugin page type approval store', () => {
  it('has no approvals for an unapproved delegated scope', async () => {
    expect(await getPageTypeApproval(env.DB, 'checkin', 'guest', 'write')).toBeNull();
    expect(await listPageTypeApprovals(env.DB, 'checkin')).toEqual([]);
  });

  it('approves page type access and records who approved it', async () => {
    await approvePageTypeAccess(env.DB, 'checkin', 'guest', 'write', 'admin@example.com');
    const approval = await getPageTypeApproval(env.DB, 'checkin', 'guest', 'write');
    expect(approval).toMatchObject({
      plugin_id: 'checkin',
      page_type: 'guest',
      access: 'write',
      approved_by: 'admin@example.com',
    });
  });

  it('keeps read and write approvals separate', async () => {
    await approvePageTypeAccess(env.DB, 'checkin', 'guest', 'read', 'admin@example.com');
    expect(await getPageTypeApproval(env.DB, 'checkin', 'guest', 'write')).toBeNull();
  });

  it('re-approving the same scope updates the approver instead of duplicating', async () => {
    await approvePageTypeAccess(env.DB, 'checkin', 'guest', 'write', 'admin@example.com');
    await approvePageTypeAccess(env.DB, 'checkin', 'guest', 'write', 'other-admin@example.com');
    const all = await listPageTypeApprovals(env.DB, 'checkin');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ page_type: 'guest', access: 'write', approved_by: 'other-admin@example.com' });
  });

  it('revokes page type access', async () => {
    await approvePageTypeAccess(env.DB, 'checkin', 'guest', 'write', 'admin@example.com');
    await revokePageTypeAccess(env.DB, 'checkin', 'guest', 'write');
    expect(await getPageTypeApproval(env.DB, 'checkin', 'guest', 'write')).toBeNull();
  });
});

describe('plugin asset approval store', () => {
  it('has no approvals for an unapproved path', async () => {
    expect(await getAssetApproval(env.DB, 'checkin', '/assets/js/kiosk.js')).toBeNull();
    expect(await listApprovals(env.DB, 'checkin')).toEqual([]);
  });

  it('approves an asset and records who approved it', async () => {
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-abc', 'admin@example.com');
    const approval = await getAssetApproval(env.DB, 'checkin', '/assets/js/kiosk.js');
    expect(approval).toMatchObject({
      plugin_id: 'checkin',
      path: '/assets/js/kiosk.js',
      integrity: 'sha384-abc',
      approved_by: 'admin@example.com',
    });
  });

  it('re-approving the same path updates the pinned hash instead of duplicating', async () => {
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-old', 'admin@example.com');
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-new', 'other-admin@example.com');
    const all = await listApprovals(env.DB, 'checkin');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ integrity: 'sha384-new', approved_by: 'other-admin@example.com' });
  });

  it('scopes approvals by plugin id — same path on another plugin is separate', async () => {
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-a', 'admin@example.com');
    expect(await getAssetApproval(env.DB, 'other-plugin', '/assets/js/kiosk.js')).toBeNull();
  });

  it('revokes an approval', async () => {
    await approveAsset(env.DB, 'checkin', '/assets/js/kiosk.js', 'sha384-a', 'admin@example.com');
    await revokeAsset(env.DB, 'checkin', '/assets/js/kiosk.js');
    expect(await getAssetApproval(env.DB, 'checkin', '/assets/js/kiosk.js')).toBeNull();
  });
});
