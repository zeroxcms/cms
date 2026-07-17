// ============================================================
// Credit system — manifest-declared costs, admin-configured prices,
// host-charged, ledger-logged.
//
// A plugin's manifest declares which chargeable actions exist
// (PluginManifest.credits): 'page_create' costs are charged automatically by
// the host at every page-create path (the /__cms write-back API and the
// built-in admin editor); 'metered' costs are reported by the plugin via
// POST /__cms/credits/charge for actions the host can't observe. The CMS
// stores configured prices in the `settings` table (`plugin.credits.<id>`),
// keeps each user's balance on users.credits, and appends every change to
// credit_ledger.
//
// Pricing semantics:
//   - configured number  → that's the price (0 = explicitly free)
//   - not configured     → the manifest `default`, or 0 (free) if none
//   - if several plugins price the same page type (via delegated writeTypes),
//     the effective cost is the SUM of all effective prices
//
// Charging is atomic and overdraft-proof: the ledger INSERT and the balance
// UPDATE share a `credits >= amount` guard and run in one DB.batch (a D1
// transaction), so concurrent spends can never take a balance below zero and
// the ledger can never disagree with the balance.
//
// Shared pool: besides per-user balances there is one site-wide pool
// (`shared_credits`, single row) with its own append-only ledger
// (`shared_credit_ledger`). spendCredits() tries the user's balance first and
// falls back to the pool for the FULL amount when the user can't cover it
// (all-or-nothing per pool — never split). Pool movements are recorded only in
// the shared ledger, with user_id as the beneficiary. Users holding the
// 'credits:share' permission may move pool credits to a user's balance
// (transferSharedCredits); admins top the pool up via adjustSharedCredits.
// ============================================================

import type { Env, PluginCreditBilling, PluginCreditCharge, PluginCreditDef, PluginManifest, ResolvedPlugin } from '../types';
import { getPlugins } from '../plugins/registry';
import { limitScopeTypes } from './plugin-limits';
import { getSetting, saveSetting } from './settings';

/** Cap on manifest-declared credit costs honored per plugin. */
export const MAX_DECLARED_CREDITS = 20;

const CREDIT_KEY_RE = /^[a-z0-9_]{1,64}$/;
const CHARGES = new Set<PluginCreditCharge>(['page_create', 'metered', 'recurring']);
const BILLINGS = new Set<PluginCreditBilling>(['advance', 'arrears']);
/** Cap on a recurring cost's billing block size. */
const MAX_RECURRING_PER = 1_000_000_000;

export function creditsSettingKey(pluginId: string): string {
  return `plugin.credits.${pluginId}`;
}

/** A manifest credit cost that survived validation, defaults normalized. */
export interface NormalizedCreditDef {
  key: string;
  label: string;
  description: string;
  charge: PluginCreditCharge;
  /** Set exactly when charge is 'page_create'. */
  pageType: string | null;
  /** Display unit for metered/recurring costs. */
  unit: string;
  /** Manifest default price; 0 = free until configured. */
  defaultValue: number;
  /** Recurring only: usage block size the price applies to (≥ 1). */
  per: number;
  /** Set exactly when charge is 'recurring'. */
  billing: PluginCreditBilling | null;
}

/** Configured prices keyed by credit key (always ≥ 0; 0 = explicitly free). */
export type PluginCreditValues = Record<string, number>;

/** A declared cost resolved to its effective (configured or default) price. */
export interface EffectiveCredit {
  pluginId: string;
  def: NormalizedCreditDef;
  value: number;
  configured: boolean;
}

export interface CreditChargeInput {
  userId: number;
  /** Credits to deduct; must be > 0 (0 is a caller-side no-op). */
  amount: number;
  /** Ledger action, e.g. 'events:create_guest_list' or 'admin:adjust'. */
  action: string;
  entityType?: string;
  entityId?: string;
  pluginId?: string;
  note?: string;
  /** Who triggered it: a user id, or 'plugin:<id>' for server-to-server. */
  createdBy: string;
}

export type CreditChargeResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; error: 'unknown_user' | 'insufficient_credits'; balance: number; required: number };

export interface CreditLedgerRow {
  id: number;
  user_id: number;
  delta: number;
  balance_after: number;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  plugin_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

function coercePrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.trunc(value);
  return n > 0 ? n : 0;
}

/**
 * Validates and normalizes a manifest's declared credit costs. Malformed
 * entries, duplicate keys, and page_create costs on page types outside
 * `allowedTypes` are dropped — a plugin must not be able to attach prices to
 * another plugin's content.
 */
export function declaredCredits(manifest: PluginManifest, allowedTypes: Set<string>): NormalizedCreditDef[] {
  const out: NormalizedCreditDef[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(manifest.credits) ? manifest.credits : []) {
    if (out.length >= MAX_DECLARED_CREDITS) break;
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as PluginCreditDef;
    if (typeof def.key !== 'string' || !CREDIT_KEY_RE.test(def.key) || seen.has(def.key)) continue;
    if (!CHARGES.has(def.charge as PluginCreditCharge)) continue;
    const pageType = typeof def.page_type === 'string' ? def.page_type : '';
    if (def.charge === 'page_create' && (!pageType || !allowedTypes.has(pageType))) continue;
    // Recurring costs bill monthly; an unknown period must not silently bill
    // at the wrong cadence, so anything but 'month' (or omitted) is dropped.
    if (def.charge === 'recurring' && def.period !== undefined && def.period !== 'month') continue;
    if (def.charge === 'recurring' && def.billing !== undefined && !BILLINGS.has(def.billing as PluginCreditBilling)) continue;
    const per = typeof def.per === 'number' && Number.isFinite(def.per)
      ? Math.min(Math.max(Math.trunc(def.per), 1), MAX_RECURRING_PER)
      : 1;

    seen.add(def.key);
    out.push({
      key: def.key,
      label: typeof def.label === 'string' && def.label.trim() ? def.label.trim().slice(0, 120) : def.key,
      description: typeof def.description === 'string' ? def.description.trim().slice(0, 500) : '',
      charge: def.charge,
      pageType: def.charge === 'page_create' ? pageType : null,
      unit: typeof def.unit === 'string' && def.unit.trim() ? def.unit.trim().slice(0, 40) : 'action',
      defaultValue: coercePrice(def.default),
      per: def.charge === 'recurring' ? per : 1,
      billing: def.charge === 'recurring' ? (def.billing as PluginCreditBilling | undefined) ?? 'advance' : null,
    });
  }
  return out;
}

/** Display unit for a cost: recurring block sizes read "5000 record". */
export function creditUnitLabel(def: NormalizedCreditDef): string {
  return def.per > 1 ? `${def.per} ${def.unit}` : def.unit;
}

export async function loadCreditValues(env: Env, pluginId: string): Promise<PluginCreditValues> {
  const raw = await getSetting(env, creditsSettingKey(pluginId));
  if (!raw) return {};
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const values: PluginCreditValues = {};
    for (const [key, value] of Object.entries(saved)) {
      if (!CREDIT_KEY_RE.test(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values[key] = Math.trunc(value);
    }
    return values;
  } catch {
    return {};
  }
}

export async function saveCreditValues(env: Env, pluginId: string, values: PluginCreditValues): Promise<void> {
  await saveSetting(env, creditsSettingKey(pluginId), JSON.stringify(values));
}

/** All of one plugin's declared costs resolved to effective prices. */
export async function effectiveCreditsForPlugin(env: Env, plugin: ResolvedPlugin): Promise<EffectiveCredit[]> {
  const allowed = await limitScopeTypes(env.DB, plugin.manifest);
  const defs = declaredCredits(plugin.manifest, allowed);
  if (!defs.length) return [];
  const values = await loadCreditValues(env, plugin.manifest.id);
  return defs.map((def) => {
    const configured = def.key in values;
    return { pluginId: plugin.manifest.id, def, value: configured ? values[def.key] : def.defaultValue, configured };
  });
}

export interface PageCreateCost {
  /** Sum of every plugin's effective price for creating one page of the type. */
  total: number;
  /** The priced parts (value > 0 only). */
  parts: Array<{ pluginId: string; key: string; label: string; value: number }>;
}

/** The effective cost of creating one page of `pageType`, across all plugins. */
export async function pageCreateCostForType(env: Env, pageType: string): Promise<PageCreateCost> {
  const plugins = await getPlugins(env);
  const parts: PageCreateCost['parts'] = [];
  for (const plugin of plugins) {
    // Cheap pre-filter before touching D1.
    const mentions = (plugin.manifest.credits ?? [])
      .some((def) => def?.charge === 'page_create' && def?.page_type === pageType);
    if (!mentions) continue;
    for (const credit of await effectiveCreditsForPlugin(env, plugin)) {
      if (credit.def.charge === 'page_create' && credit.def.pageType === pageType && credit.value > 0) {
        parts.push({ pluginId: credit.pluginId, key: credit.def.key, label: credit.def.label, value: credit.value });
      }
    }
  }
  return { total: parts.reduce((sum, part) => sum + part.value, 0), parts };
}

/** Ledger action for a page-create charge: the declaring plugin's key when
 *  there is exactly one priced part, else a generic page_create action. */
export function pageCreateAction(pageType: string, cost: PageCreateCost): string {
  return cost.parts.length === 1
    ? `${cost.parts[0].pluginId}:${cost.parts[0].key}`
    : `page_create:${pageType}`;
}

export async function getCreditBalance(env: Env, userId: number): Promise<number | null> {
  const row = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first<{ credits: number }>();
  return row ? row.credits : null;
}

/**
 * Atomically deducts `amount` credits and appends the ledger row. Both
 * statements share the `credits >= amount` guard and run in one DB.batch, so
 * a concurrent spend can never overdraw and the ledger stays consistent with
 * the balance. Fails closed with `insufficient_credits` (or `unknown_user`).
 */
export async function chargeCredits(env: Env, input: CreditChargeInput): Promise<CreditChargeResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`chargeCredits amount must be > 0, got ${input.amount}`);

  // Success is detected via RETURNING, not meta.changes: production D1
  // reports `changes` from internal row writes (indexes included), so a
  // one-row UPDATE can report changes > 1 there while local D1 reports 1.
  const results = await env.DB.batch<{ credits: number }>([
    env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, delta, balance_after, action, entity_type, entity_id, plugin_id, note, created_by)
       SELECT id, ?, credits - ?, ?, ?, ?, ?, ?, ?
         FROM users WHERE id = ? AND credits >= ?`,
    ).bind(
      -amount, amount, input.action, input.entityType ?? null, input.entityId ?? null,
      input.pluginId ?? null, input.note ?? null, input.createdBy, input.userId, amount,
    ),
    env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ? RETURNING credits')
      .bind(amount, input.userId, amount),
  ]);

  const updated = results[1].results;
  if (updated.length === 1) {
    return { ok: true, balanceAfter: updated[0].credits };
  }
  const balance = await getCreditBalance(env, input.userId);
  if (balance === null) return { ok: false, error: 'unknown_user', balance: 0, required: amount };
  return { ok: false, error: 'insufficient_credits', balance, required: amount };
}

/**
 * Grants (positive delta) or deducts (negative delta) credits with a ledger
 * row — admin adjustments, refunds. Deductions use the same overdraft guard
 * as chargeCredits; grants always apply.
 */
export async function adjustCredits(
  env: Env,
  input: { userId: number; delta: number; action: string; note?: string; pluginId?: string; entityType?: string; entityId?: string; createdBy: string },
): Promise<CreditChargeResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) throw new Error('adjustCredits delta must be non-zero');
  if (delta < 0) {
    return chargeCredits(env, {
      userId: input.userId,
      amount: -delta,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      pluginId: input.pluginId,
      note: input.note,
      createdBy: input.createdBy,
    });
  }

  // RETURNING instead of meta.changes for the same reason as chargeCredits.
  const results = await env.DB.batch<{ credits: number }>([
    env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, delta, balance_after, action, entity_type, entity_id, plugin_id, note, created_by)
       SELECT id, ?, credits + ?, ?, ?, ?, ?, ?, ?
         FROM users WHERE id = ?`,
    ).bind(
      delta, delta, input.action, input.entityType ?? null, input.entityId ?? null,
      input.pluginId ?? null, input.note ?? null, input.createdBy, input.userId,
    ),
    env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ? RETURNING credits')
      .bind(delta, input.userId),
  ]);

  const updated = results[1].results;
  if (updated.length !== 1) {
    return { ok: false, error: 'unknown_user', balance: 0, required: 0 };
  }
  return { ok: true, balanceAfter: updated[0].credits };
}

/**
 * Best-effort refund after a charged operation failed downstream (e.g. the
 * page insert threw after the deduction). Never throws: the original failure
 * is what the caller must surface, and a missed refund is admin-fixable from
 * the ledger. `source` routes the refund back to whichever balance paid
 * (spendCredits reports it): the user's own, or the shared pool.
 */
export async function refundCredits(
  env: Env,
  input: { userId: number; amount: number; action: string; note?: string; pluginId?: string; createdBy: string; source?: CreditSource },
): Promise<void> {
  if (Math.trunc(input.amount) <= 0) return;
  try {
    if (input.source === 'shared') {
      await adjustSharedCredits(env, {
        delta: Math.trunc(input.amount),
        action: `${input.action}:refund`,
        userId: input.userId,
        note: input.note,
        pluginId: input.pluginId,
        createdBy: input.createdBy,
      });
      return;
    }
    await adjustCredits(env, {
      userId: input.userId,
      delta: Math.trunc(input.amount),
      action: `${input.action}:refund`,
      note: input.note,
      pluginId: input.pluginId,
      createdBy: input.createdBy,
    });
  } catch (error) {
    console.error('credit refund failed', input, error);
  }
}

export type CreditTransferResult =
  | { ok: true; senderBalance: number; recipientBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from one user to another, writing a paired ledger row
 * on each side ('transfer:send' with a negative delta, 'transfer:receive' with
 * a positive one). The sender is debited first under the same overdraft guard
 * as a spend; only if that succeeds is the recipient credited. Should the
 * recipient credit fail (e.g. the row vanished mid-transfer), the sender is
 * auto-refunded so credits can never be destroyed. Recipient eligibility (not
 * the sender, not an administrator) is the caller's to enforce.
 */
export async function transferCredits(
  env: Env,
  input: { fromUserId: number; toUserId: number; amount: number; note?: string; createdBy: string },
): Promise<CreditTransferResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`transferCredits amount must be > 0, got ${input.amount}`);
  if (input.fromUserId === input.toUserId) throw new Error('transferCredits cannot target the same user');

  const debit = await chargeCredits(env, {
    userId: input.fromUserId,
    amount,
    action: 'transfer:send',
    entityType: 'user',
    entityId: String(input.toUserId),
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) {
    return debit.error === 'insufficient_credits'
      ? { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount }
      : { ok: false, error: 'unknown_user' };
  }

  const credit = await adjustCredits(env, {
    userId: input.toUserId,
    delta: amount,
    action: 'transfer:receive',
    entityType: 'user',
    entityId: String(input.fromUserId),
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!credit.ok) {
    await refundCredits(env, {
      userId: input.fromUserId,
      amount,
      action: 'transfer:send',
      note: 'auto-refund: recipient credit failed',
      createdBy: input.createdBy,
    });
    return { ok: false, error: 'unknown_user' };
  }

  return { ok: true, senderBalance: debit.balanceAfter, recipientBalance: credit.balanceAfter };
}

export async function listCreditLedger(
  env: Env,
  userId: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<CreditLedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await env.DB.prepare(
    'SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(userId, limit, offset).all<CreditLedgerRow>();
  return rows.results;
}

export async function countCreditLedger(env: Env, userId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM credit_ledger WHERE user_id = ?',
  ).bind(userId).first<{ total: number }>();
  return Math.max(0, row?.total ?? 0);
}

// ── Shared credit pool ────────────────────────────────────────────────────────

/** Which balance a spend was taken from. */
export type CreditSource = 'user' | 'shared';

export interface SharedCreditLedgerRow {
  id: number;
  delta: number;
  balance_after: number;
  action: string;
  /** The user the pool paid for / transferred to; NULL for pool top-ups. */
  user_id: number | null;
  entity_type: string | null;
  entity_id: string | null;
  plugin_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export type SharedCreditResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number };

export async function getSharedCreditBalance(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM shared_credits WHERE id = 1').first<{ balance: number }>();
  return row?.balance ?? 0;
}

interface SharedCreditChangeInput {
  /** The beneficiary recorded on the ledger row; null for pool top-ups. */
  userId?: number | null;
  action: string;
  entityType?: string;
  entityId?: string;
  pluginId?: string;
  note?: string;
  createdBy: string;
}

/** Atomic pool write: ledger INSERT + balance UPDATE sharing one guard, like
 *  chargeCredits. The INSERT OR IGNORE makes the singleton row's existence a
 *  non-issue (fresh databases, tests). Success detected via RETURNING. */
async function writeSharedCredits(
  env: Env,
  delta: number,
  guarded: boolean,
  input: SharedCreditChangeInput,
): Promise<SharedCreditResult> {
  const guardSql = guarded ? ' AND balance >= ?' : '';
  const guardArgs = guarded ? [-delta] : [];
  const results = await env.DB.batch<{ balance: number }>([
    env.DB.prepare('INSERT OR IGNORE INTO shared_credits (id, balance) VALUES (1, 0)'),
    env.DB.prepare(
      `INSERT INTO shared_credit_ledger (delta, balance_after, action, user_id, entity_type, entity_id, plugin_id, note, created_by)
       SELECT ?, balance + ?, ?, ?, ?, ?, ?, ?, ?
         FROM shared_credits WHERE id = 1${guardSql}`,
    ).bind(
      delta, delta, input.action, input.userId ?? null, input.entityType ?? null,
      input.entityId ?? null, input.pluginId ?? null, input.note ?? null, input.createdBy, ...guardArgs,
    ),
    env.DB.prepare(`UPDATE shared_credits SET balance = balance + ? WHERE id = 1${guardSql} RETURNING balance`)
      .bind(delta, ...guardArgs),
  ]);

  const updated = results[2].results;
  if (updated.length === 1) return { ok: true, balanceAfter: updated[0].balance };
  return { ok: false, error: 'insufficient_credits', balance: await getSharedCreditBalance(env), required: -delta };
}

/** Atomically deducts from the shared pool; fails closed when the pool can't
 *  cover the amount. `userId` is the beneficiary recorded on the ledger row. */
export async function chargeSharedCredits(
  env: Env,
  input: SharedCreditChangeInput & { amount: number },
): Promise<SharedCreditResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`chargeSharedCredits amount must be > 0, got ${input.amount}`);
  return writeSharedCredits(env, -amount, true, input);
}

/** Grants (positive delta) or deducts (negative delta) shared-pool credits —
 *  admin top-ups, refunds. Deductions use the overdraft guard. */
export async function adjustSharedCredits(
  env: Env,
  input: SharedCreditChangeInput & { delta: number },
): Promise<SharedCreditResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) throw new Error('adjustSharedCredits delta must be non-zero');
  return writeSharedCredits(env, delta, delta < 0, input);
}

export type CreditSpendResult =
  | { ok: true; source: CreditSource; balanceAfter: number }
  | { ok: false; error: 'unknown_user'; balance: number; sharedBalance: number; required: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; sharedBalance: number; required: number };

/**
 * Charges the user's own balance first; when it can't cover the FULL amount,
 * the shared pool pays the full amount instead (all-or-nothing per pool, never
 * split — refunds stay one-sided). A pool-covered spend is recorded only in
 * the shared ledger, with the user as beneficiary. An unknown user never falls
 * back — an invalid identity must not drain the pool. The result's `source`
 * says which balance paid, so a downstream refund can target it.
 */
export async function spendCredits(env: Env, input: CreditChargeInput): Promise<CreditSpendResult> {
  const amount = Math.trunc(input.amount);
  const charge = await chargeCredits(env, input);
  if (charge.ok) return { ok: true, source: 'user', balanceAfter: charge.balanceAfter };
  if (charge.error === 'unknown_user') {
    return { ok: false, error: 'unknown_user', balance: 0, sharedBalance: await getSharedCreditBalance(env), required: amount };
  }

  const shared = await chargeSharedCredits(env, {
    amount,
    action: input.action,
    userId: input.userId,
    entityType: input.entityType,
    entityId: input.entityId,
    pluginId: input.pluginId,
    note: input.note,
    createdBy: input.createdBy,
  });
  if (shared.ok) return { ok: true, source: 'shared', balanceAfter: shared.balanceAfter };
  return { ok: false, error: 'insufficient_credits', balance: charge.balance, sharedBalance: shared.balance, required: amount };
}

export type SharedDonationResult =
  | { ok: true; balanceAfter: number; sharedBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from a user's own balance into the shared pool — the
 * profile page's "donate" action, open to any user since the pool benefits
 * everyone. Paired 'shared:donate' ledger rows on both sides: negative on the
 * user's ledger (overdraft-guarded like any spend), positive on the shared
 * ledger with the donor as beneficiary. Should the pool credit fail, the user
 * is auto-refunded so credits can never be destroyed.
 */
export async function donateSharedCredits(
  env: Env,
  input: { fromUserId: number; amount: number; note?: string; createdBy: string },
): Promise<SharedDonationResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`donateSharedCredits amount must be > 0, got ${input.amount}`);

  const debit = await chargeCredits(env, {
    userId: input.fromUserId,
    amount,
    action: 'shared:donate',
    entityType: 'shared',
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) {
    return debit.error === 'insufficient_credits'
      ? { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount }
      : { ok: false, error: 'unknown_user' };
  }

  try {
    const credit = await adjustSharedCredits(env, {
      delta: amount,
      action: 'shared:donate',
      userId: input.fromUserId,
      note: input.note,
      createdBy: input.createdBy,
    });
    if (credit.ok) return { ok: true, balanceAfter: debit.balanceAfter, sharedBalance: credit.balanceAfter };
  } catch (error) {
    console.error('shared credit donation failed', input, error);
  }
  await refundCredits(env, {
    userId: input.fromUserId,
    amount,
    action: 'shared:donate',
    note: 'auto-refund: pool credit failed',
    createdBy: input.createdBy,
  });
  return { ok: false, error: 'unknown_user' };
}

export type SharedTransferResult =
  | { ok: true; sharedBalance: number; recipientBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from the shared pool to a user's balance, writing a
 * ledger row on each side ('shared:send' on the pool ledger with the recipient
 * as beneficiary, 'shared:receive' on the user ledger). The pool is debited
 * first under the overdraft guard; if the user credit then fails (unknown
 * user), the pool is auto-refunded so credits can never be destroyed.
 * Authorization ('credits:share') is the caller's to enforce.
 */
export async function transferSharedCredits(
  env: Env,
  input: { toUserId: number; amount: number; note?: string; createdBy: string },
): Promise<SharedTransferResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`transferSharedCredits amount must be > 0, got ${input.amount}`);

  // The shared ledger's beneficiary column is a foreign key — debiting with a
  // nonexistent recipient would abort on the constraint, so check first.
  const recipient = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(input.toUserId).first<{ id: number }>();
  if (!recipient) return { ok: false, error: 'unknown_user' };

  const debit = await chargeSharedCredits(env, {
    amount,
    action: 'shared:send',
    userId: input.toUserId,
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) return { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount };

  const credit = await adjustCredits(env, {
    userId: input.toUserId,
    delta: amount,
    action: 'shared:receive',
    entityType: 'shared',
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!credit.ok) {
    await adjustSharedCredits(env, {
      delta: amount,
      action: 'shared:send:refund',
      userId: input.toUserId,
      note: 'auto-refund: recipient credit failed',
      createdBy: input.createdBy,
    }).catch((error) => console.error('shared credit refund failed', input, error));
    return { ok: false, error: 'unknown_user' };
  }

  return { ok: true, sharedBalance: debit.balanceAfter, recipientBalance: credit.balanceAfter };
}

export async function listSharedCreditLedger(
  env: Env,
  opts: { limit?: number; offset?: number } = {},
): Promise<SharedCreditLedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await env.DB.prepare(
    'SELECT * FROM shared_credit_ledger ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(limit, offset).all<SharedCreditLedgerRow>();
  return rows.results;
}
