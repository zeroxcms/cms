// ============================================================
// Publish-time lect projection (data minimization).
//
// Plugins declare per-page-type rules in their manifest
// (contentTypes.publishLect); buildSnapshot applies them so fields no
// published-side consumer needs — PII, operational history, secrets — never
// reach the published DB or any other publish target. The SAME projection
// must be applied to the draft side wherever draft and live lects are
// compared (dashboard drift badges, the editor's live-version marker),
// otherwise projected types would show as permanently "modified since
// publish".
// ============================================================

import type { Env, PublishLectRule } from '../types';
import { getPlugins } from '../plugins/registry';
import { safeParseLect, stringifyLect } from '../utils/lect';

/**
 * Effective projection rules by page type. A rule is honored only when the
 * declaring plugin also owns the type's blueprint, so a plugin cannot thin
 * out pages it doesn't own. First declaration wins on (unexpected) overlap.
 */
export async function publishLectRules(env: Env): Promise<Record<string, PublishLectRule>> {
  const rules: Record<string, PublishLectRule> = {};
  const plugins = await getPlugins(env);
  for (const plugin of plugins) {
    const declared = plugin.manifest.contentTypes?.publishLect ?? {};
    const owned = plugin.manifest.contentTypes?.blueprint ?? {};
    for (const [pageType, rule] of Object.entries(declared)) {
      if (!Object.hasOwn(owned, pageType)) continue;
      if (!Object.hasOwn(rules, pageType)) rules[pageType] = rule;
    }
  }
  return rules;
}

/**
 * Draft-side projector for live-vs-draft comparisons (dashboard drift badges,
 * editor live-version marker). Returns what the page's lect WOULD look like
 * once published, so it compares equal to the live copy.
 */
export async function draftLectProjector(
  env: Env,
): Promise<(page: { page_type?: string | null; lect?: string | null }) => string | null> {
  const rules = await publishLectRules(env);
  return (page) => projectLect(page.lect ?? null, rules[page.page_type ?? '']);
}

/**
 * Applies one rule to a stored lect string. Without a rule (or with an empty
 * lect) the input is returned byte-identical, so non-projected types keep
 * exact string equality with their live copy. Structural `_`-prefixed keys
 * (`_type`, `_pointers`, draft metadata) always survive `keep` mode.
 */
export function projectLect(lect: string | null, rule: PublishLectRule | undefined): string | null {
  if (!rule || !lect) return lect;
  const keep = rule.keep;
  const drop = rule.drop;
  if (!keep?.length && !drop?.length) return lect;

  const parsed = safeParseLect(lect);
  if (keep?.length) {
    const allowed = new Set(keep);
    for (const key of Object.keys(parsed)) {
      if (!key.startsWith('_') && !allowed.has(key)) delete parsed[key];
    }
  } else if (drop?.length) {
    for (const key of drop) delete parsed[key];
  }
  return stringifyLect(parsed);
}
