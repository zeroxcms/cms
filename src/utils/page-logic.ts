// Lect / page-structure helpers used by the admin editor handlers.

import { cmsConfig } from '../cms-config';
import type { CmsConfig } from '../cms-config';
import {
  blockToLect,
  blueprintToLect,
  defaultLectItem,
  getBlueprintProps,
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  mergeLects,
  normalizeLect,
  postToLect,
  safeParseLect,
  stringifyLect,
} from './lect';
import type { Lect, LectItem } from './lect';
import { num, str } from './forms';

export function withDraftMetadata(lect: Lect, modifier: number): Lect {
  return {
    ...normalizeLect(lect),
    _modifier: modifier,
    _updated_at: new Date().toISOString(),
  };
}

export function blueprintPropsFor(config: CmsConfig, pageType: string) {
  return getBlueprintProps(config.blueprint[pageType] ?? config.blueprint.default);
}

export function blockPropsByName(config: CmsConfig): Record<string, ReturnType<typeof getBlueprintProps>> {
  const props: Record<string, ReturnType<typeof getBlueprintProps>> = {};
  for (const [name, blueprint] of Object.entries(config.blocks)) {
    props[name] = getBlueprintProps(blueprint);
  }
  return props;
}

export function lectsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if ((left ?? '') === (right ?? '')) return true;
  return stringifyLect(safeParseLect(left)) === stringifyLect(safeParseLect(right));
}

export function lectForPage(config: CmsConfig, pageType: string, stored: string | null | undefined): Lect {
  return mergeLects(
    blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
    safeParseLect(stored),
  );
}

export function lectFromForm(config: CmsConfig, pageType: string, existing: Lect, form: FormData, language: string): Lect {
  const jsonLect = safeParseLect(str(form.get('lect_json')));
  const postedLect = postToLect(form, language);
  return mergeLects(
    mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), existing),
    mergeLects(jsonLect, postedLect),
  );
}

export function applyStructuredAction(config: CmsConfig, lect: Lect, pageType: string, action: string, form: FormData): Lect {
  const next = normalizeLect(lect);
  const [actionType, actionParam = ''] = action.split(':');
  const actionParams = actionParam.split('|');
  const count = Math.max(1, num(form.get(`count:${actionParam}`), 1));

  if (actionType === 'block-add') {
    const blockName = str(form.get('block-select'));
    if (!blockName || !config.blocks[blockName]) return next;
    const block = blockToLect(blockName, config.blocks, config.defaultLanguage);
    next._blocks ||= [];
    block._weight = getNextWeight(next._blocks);
    next._blocks.push(block);
    return next;
  }

  if (actionType === 'block-delete') {
    next._blocks?.splice(parseInt(actionParam, 10), 1);
    return next;
  }

  if (actionType === 'item-add') {
    addDefaultItem(config, next, pageType, actionParam, count);
    return next;
  }

  if (actionType === 'item-delete') {
    const [itemName, itemIndex] = actionParams;
    getMutableItems(next, itemName).splice(parseInt(itemIndex, 10), 1);
    return next;
  }

  if (actionType === 'block-item-add') {
    const [blockIndex, itemName] = actionParams;
    const block = getLectBlocks(next)[parseInt(blockIndex, 10)];
    if (block) addDefaultBlockItem(config, block, itemName, count);
    next._blocks = replaceBlock(next, parseInt(blockIndex, 10), block);
    return next;
  }

  if (actionType === 'block-item-delete') {
    const [blockIndex, itemName, itemIndex] = actionParams;
    const index = parseInt(blockIndex, 10);
    const block = getLectBlocks(next)[index];
    if (block) {
      getMutableItems(block, itemName).splice(parseInt(itemIndex, 10), 1);
      next._blocks = replaceBlock(next, index, block);
    }
    return next;
  }

  return next;
}

export function addDefaultItem(config: CmsConfig, lect: Lect, pageType: string, itemName: string, count: number): void {
  if (!itemName) return;
  const defaults = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(lect, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

export function addDefaultBlockItem(config: CmsConfig, block: Lect, itemName: string, count: number): void {
  if (!itemName) return;
  const blockType = String(block._type || 'default');
  const defaults = blockToLect(blockType, config.blocks, config.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(block, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

export function cloneItem(item: LectItem): LectItem {
  return JSON.parse(JSON.stringify(item)) as LectItem;
}

export function getMutableItems(lect: Lect, itemName: string): LectItem[] {
  if (!Array.isArray(lect[itemName])) lect[itemName] = [];
  return lect[itemName] as LectItem[];
}

export function getNextWeight(items: LectItem[]): number {
  return items.reduce((max, entry) => Math.max(max, num(entry._weight, 0)), -1) + 1;
}

export function replaceBlock(lect: Lect, index: number, block?: Lect): Lect[] {
  const blocks = getLectBlocks(lect);
  if (block) blocks[index] = block;
  return blocks;
}

export function ensureDefaultLectName(lect: Lect, name: string): void {
  if (getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage)) return;
  const current = lect.name;
  const languageMap = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, string>
    : {};
  lect.name = {
    ...languageMap,
    [cmsConfig.defaultLanguage]: name,
  };
}

export function isStructuredEditorAction(action: string): boolean {
  return [
    'block-add',
    'block-delete',
    'item-add',
    'item-delete',
    'block-item-add',
    'block-item-delete',
  ].includes(action.split(':')[0] || '');
}
