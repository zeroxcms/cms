import type { BlueprintEntry } from '../cms-config';

export type OriginalScalar = string;
export type OriginalValues = Record<string, Record<string, OriginalScalar>>;

export interface OriginalItem {
  attributes: Record<string, OriginalScalar>;
  pointers: Record<string, OriginalScalar>;
  values: OriginalValues;
  items: Record<string, OriginalItem[]>;
}

export interface Original extends OriginalItem {
  blocks: Original[];
  tags?: Original[];
}

export interface FieldProps {
  name: string;
  type: string;
}

export interface ItemProps {
  name: string;
  attributes: FieldProps[];
  pointers: FieldProps[];
  fields: FieldProps[];
  items?: ItemProps[];
}

export interface BlueprintProps {
  attributes: FieldProps[];
  pointers: FieldProps[];
  fields: FieldProps[];
  items: ItemProps[];
}

export interface PrintItem {
  attributes: Record<string, OriginalScalar>;
  pointers: Record<string, OriginalScalar>;
  values: OriginalValues;
  tokens: Record<string, OriginalScalar | PrintItem[]>;
  items: Record<string, PrintItem[]>;
  _key: number;
  _weight: number;
}

export interface PrintOriginal {
  attributes: Record<string, OriginalScalar>;
  pointers: Record<string, OriginalScalar>;
  values: OriginalValues;
  tokens: Record<string, OriginalScalar | PrintItem[]>;
  items: Record<string, PrintItem[]>;
  blocks: PrintOriginal[];
  raw: Original;
}

type FormDataEntryValue = string | File;
type FormLike = FormData | Record<string, FormDataEntryValue>;

export function defaultOriginalItem(): OriginalItem {
  return {
    attributes: {},
    pointers: {},
    values: {},
    items: {},
  };
}

export function defaultOriginal(): Original {
  return {
    ...defaultOriginalItem(),
    blocks: [],
  };
}

export function safeParseOriginal(value: string | null | undefined): Original {
  if (!value) return defaultOriginal();
  try {
    return normalizeOriginal(JSON.parse(value) as Partial<Original>);
  } catch {
    return defaultOriginal();
  }
}

export function normalizeOriginal(value: Partial<Original>): Original {
  return {
    attributes: normalizeRecord(value.attributes),
    pointers: normalizeRecord(value.pointers),
    values: normalizeValues(value.values),
    items: normalizeItems(value.items),
    blocks: Array.isArray(value.blocks)
      ? value.blocks.map((block) => normalizeOriginal(block))
      : [],
    tags: Array.isArray(value.tags)
      ? value.tags.map((tag) => normalizeOriginal(tag))
      : undefined,
  };
}

export function getBlueprintProps(configBlueprint: BlueprintEntry[]): BlueprintProps {
  const attributes: FieldProps[] = [];
  const pointers: FieldProps[] = [];
  const fields: FieldProps[] = [];
  const items: ItemProps[] = [];

  for (const entry of configBlueprint) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) {
        attributes.push(getProps(entry, '@'));
      } else if (entry.startsWith('*')) {
        pointers.push(getPointerProps(entry));
      } else {
        fields.push(getProps(entry));
      }
      continue;
    }

    for (const [name, definitions] of Object.entries(entry)) {
      items.push(getItemProps(name, definitions));
    }
  }

  return { attributes, pointers, fields, items };
}

export function blueprintToOriginal(
  pageType: string,
  blueprints: Record<string, BlueprintEntry[]>,
  defaultLanguage: string,
): Original {
  const original = defaultOriginal();
  original.values[defaultLanguage] = {};

  const blueprint = blueprints[pageType] ?? blueprints.default;
  if (!blueprint) return original;

  original.attributes._type = pageType;

  for (const entry of blueprint) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) {
        original.attributes[fieldName(entry, '@')] = '';
      } else if (entry.startsWith('*')) {
        original.pointers[fieldName(entry, '*')] = '';
      } else {
        original.values[defaultLanguage][fieldName(entry)] = '';
      }
      continue;
    }

    for (const [name, definitions] of Object.entries(entry)) {
      original.items[name] = [blueprintItemToOriginal(definitions, defaultLanguage)];
    }
  }

  return original;
}

export function blockToOriginal(
  blockType: string,
  blocks: Record<string, BlueprintEntry[]>,
  defaultLanguage: string,
): Original {
  const original = blueprintToOriginal(blockType, blocks, defaultLanguage);
  original.attributes._type = blockType;
  original.attributes._id = Date.now().toString(36);
  original.attributes._weight = '0';
  original.blocks = [];
  return original;
}

export function postToOriginal(form: FormLike, language: string): Original {
  const original = defaultOriginal();
  original.values[language] = {};
  const blockPosts: Record<number, Record<string, FormDataEntryValue>> = {};

  for (const [name, value] of formEntries(form).sort(([left], [right]) => left.localeCompare(right))) {
    const scalar = formValueToString(value);

    let match = name.match(/^@(\w+)$/);
    if (match) {
      original.attributes[match[1]] = scalar;
      continue;
    }

    match = name.match(/^\*(\w+)$/);
    if (match) {
      original.pointers[match[1]] = scalar;
      continue;
    }

    match = name.match(/^\.(\w+)\|?([a-z-]+)?$/);
    if (match) {
      const targetLanguage = match[2] || language;
      original.values[targetLanguage] ||= {};
      original.values[targetLanguage][match[1]] = scalar;
      continue;
    }

    match = name.match(/^\.(\w+)\[(\d+)]\.(\w+)\[(\d+)](@(\w+)$|\.(\w+)\|?([a-z-]+)?$|\*(\w+)$)/);
    if (match) {
      const item = ensureNestedItem(original, match[1], Number(match[2]), match[3], Number(match[4]));
      if (match[6]) item.attributes[match[6]] = scalar;
      if (match[7]) {
        const targetLanguage = match[8] || language;
        item.values[targetLanguage] ||= {};
        item.values[targetLanguage][match[7]] = scalar;
      }
      if (match[9]) item.pointers[match[9]] = scalar;
      continue;
    }

    match = name.match(/^\.(\w+)\[(\d+)](@(\w+)$|\.(\w+)\|?([a-z-]+)?$|\*(\w+)$)/);
    if (match) {
      const item = ensureItem(original, match[1], Number(match[2]));
      if (match[4]) item.attributes[match[4]] = scalar;
      if (match[5]) {
        const targetLanguage = match[6] || language;
        item.values[targetLanguage] ||= {};
        item.values[targetLanguage][match[5]] = scalar;
      }
      if (match[7]) item.pointers[match[7]] = scalar;
      continue;
    }

    match = name.match(/^#(\d+)([.@*][\w+\[\].@*|-]+)$/);
    if (match) {
      const index = Number(match[1]);
      blockPosts[index] ||= {};
      blockPosts[index][match[2]] = value;
    }
  }

  original.blocks = Object.keys(blockPosts)
    .map((key) => Number(key))
    .sort((left, right) => left - right)
    .map((index) => postToOriginal(blockPosts[index], language));

  return original;
}

export function mergeOriginals(target: Original, source: Original): Original {
  const result = defaultOriginal();
  result.attributes = { ...target.attributes, ...source.attributes };
  result.pointers = { ...target.pointers, ...source.pointers };
  result.values = mergeValues(target.values, source.values);
  result.items = mergeItems(target.items, source.items);
  result.blocks = mergeOriginalArrays(target.blocks, source.blocks);
  result.tags = source.tags ?? target.tags;
  return result;
}

export function originalToPrint(
  original: Original,
  language: string,
  defaultLanguage: string,
): PrintOriginal {
  return {
    attributes: original.attributes,
    pointers: original.pointers,
    values: original.values,
    tokens: originalTokens(original, language, defaultLanguage),
    items: printItems(original.items, language, defaultLanguage),
    blocks: sortByWeight(original.blocks).map((block) => originalToPrint(block, language, defaultLanguage)),
    raw: original,
  };
}

export function stringifyOriginal(original: Original): string {
  return JSON.stringify(original);
}

function getProps(rawKey: string, prefix = ''): FieldProps {
  const keyParts = rawKey.split(':');
  return {
    name: keyParts[0].replace(prefix, '').split('__')[0],
    type: keyParts[1] || 'text',
  };
}

function getPointerProps(rawKey: string): FieldProps {
  const keyParts = rawKey.split(':');
  return {
    name: keyParts[0].replace('*', '').split('__')[0],
    type: keyParts[1] || (/[.@]/.test(keyParts[0]) ? 'text' : 'page/basic'),
  };
}

function getItemProps(name: string, definitions: BlueprintEntry[]): ItemProps {
  const attributes: FieldProps[] = [];
  const pointers: FieldProps[] = [];
  const fields: FieldProps[] = [];
  const items: ItemProps[] = [];

  for (const definition of definitions) {
    if (typeof definition === 'string') {
      if (definition.startsWith('@')) attributes.push(getProps(definition, '@'));
      else if (definition.startsWith('*')) pointers.push(getPointerProps(definition));
      else fields.push(getProps(definition));
      continue;
    }
    for (const [nestedName, nestedDefinitions] of Object.entries(definition)) {
      items.push(getItemProps(nestedName, nestedDefinitions));
    }
  }

  return {
    name,
    attributes,
    pointers,
    fields,
    items: items.length ? items : undefined,
  };
}

function blueprintItemToOriginal(definitions: BlueprintEntry[], defaultLanguage: string): OriginalItem {
  const item = defaultOriginalItem();
  item.attributes._weight = '0';
  item.values[defaultLanguage] = {};

  for (const definition of definitions) {
    if (typeof definition === 'string') {
      if (definition.startsWith('@')) item.attributes[fieldName(definition, '@')] = '';
      else if (definition.startsWith('*')) item.pointers[fieldName(definition, '*')] = '';
      else item.values[defaultLanguage][fieldName(definition)] = '';
      continue;
    }

    for (const [nestedName, nestedDefinitions] of Object.entries(definition)) {
      item.items[nestedName] = [blueprintItemToOriginal(nestedDefinitions, defaultLanguage)];
    }
  }

  return item;
}

function fieldName(raw: string, prefix = ''): string {
  return raw.replace(prefix, '').split(':')[0];
}

function ensureItem(original: Original | OriginalItem, name: string, index: number): OriginalItem {
  original.items[name] ||= [];
  original.items[name][index] ||= defaultOriginalItem();
  return original.items[name][index];
}

function ensureNestedItem(
  original: Original,
  parentName: string,
  parentIndex: number,
  nestedName: string,
  nestedIndex: number,
): OriginalItem {
  const parent = ensureItem(original, parentName, parentIndex);
  parent.items[nestedName] ||= [];
  parent.items[nestedName][nestedIndex] ||= defaultOriginalItem();
  return parent.items[nestedName][nestedIndex];
}

function formEntries(form: FormLike): Array<[string, FormDataEntryValue]> {
  if (form instanceof FormData) return Array.from(form.entries());
  return Object.entries(form);
}

function formValueToString(value: FormDataEntryValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRecord(value: unknown): Record<string, OriginalScalar> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, OriginalScalar> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = typeof item === 'string' ? item : String(item ?? '');
  }
  return result;
}

function normalizeValues(value: unknown): OriginalValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: OriginalValues = {};
  for (const [language, entries] of Object.entries(value)) {
    result[language] = normalizeRecord(entries);
  }
  return result;
}

function normalizeItems(value: unknown): Record<string, OriginalItem[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, OriginalItem[]> = {};
  for (const [key, entries] of Object.entries(value)) {
    result[key] = Array.isArray(entries)
      ? entries.map((entry) => normalizeItem(entry))
      : [];
  }
  return result;
}

function normalizeItem(value: unknown): OriginalItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultOriginalItem();
  }
  const item = value as Partial<OriginalItem>;
  return {
    attributes: normalizeRecord(item.attributes),
    pointers: normalizeRecord(item.pointers),
    values: normalizeValues(item.values),
    items: normalizeItems(item.items),
  };
}

function mergeValues(target: OriginalValues, source: OriginalValues): OriginalValues {
  const result: OriginalValues = {};
  for (const language of new Set([...Object.keys(target), ...Object.keys(source)])) {
    result[language] = {
      ...(target[language] ?? {}),
      ...(source[language] ?? {}),
    };
  }
  return result;
}

function mergeItems(
  target: Record<string, OriginalItem[]>,
  source: Record<string, OriginalItem[]>,
): Record<string, OriginalItem[]> {
  const result: Record<string, OriginalItem[]> = {};
  for (const key of new Set([...Object.keys(target), ...Object.keys(source)])) {
    const targetItems = target[key] ?? [];
    const sourceItems = source[key] ?? [];
    result[key] = mergeItemArrays(targetItems, sourceItems);
  }
  return result;
}

function mergeItemArrays(target: OriginalItem[], source: OriginalItem[]): OriginalItem[] {
  const length = Math.max(target.length, source.length);
  const result: OriginalItem[] = [];
  for (let index = 0; index < length; index++) {
    const targetItem = target[index] ?? defaultOriginalItem();
    const sourceItem = source[index];
    result[index] = sourceItem ? mergeOriginalItems(targetItem, sourceItem) : targetItem;
  }
  return result;
}

function mergeOriginalArrays(target: Original[], source: Original[]): Original[] {
  const length = Math.max(target.length, source.length);
  const result: Original[] = [];
  for (let index = 0; index < length; index++) {
    const targetItem = target[index] ?? defaultOriginal();
    const sourceItem = source[index];
    result[index] = sourceItem ? mergeOriginals(targetItem, sourceItem) : targetItem;
  }
  return result;
}

function mergeOriginalItems(target: OriginalItem, source: OriginalItem): OriginalItem {
  return {
    attributes: { ...target.attributes, ...source.attributes },
    pointers: { ...target.pointers, ...source.pointers },
    values: mergeValues(target.values, source.values),
    items: mergeItems(target.items, source.items),
  };
}

function originalTokens(
  original: Original | OriginalItem,
  language: string,
  defaultLanguage: string,
): Record<string, OriginalScalar | PrintItem[]> {
  const tokens: Record<string, OriginalScalar | PrintItem[]> = {
    ...original.attributes,
    ...original.pointers,
    ...(original.values[defaultLanguage] ?? {}),
    ...(original.values[language] ?? {}),
  };

  const items = printItems(original.items, language, defaultLanguage);
  for (const [key, value] of Object.entries(items)) {
    tokens[key] = value;
  }

  return tokens;
}

function printItems(
  items: Record<string, OriginalItem[]>,
  language: string,
  defaultLanguage: string,
): Record<string, PrintItem[]> {
  const result: Record<string, PrintItem[]> = {};
  for (const [key, entries] of Object.entries(items)) {
    result[key] = sortByWeight(entries).map((item, index) => ({
      attributes: item.attributes,
      pointers: item.pointers,
      values: item.values,
      tokens: originalTokens(item, language, defaultLanguage),
      items: printItems(item.items, language, defaultLanguage),
      _key: index,
      _weight: parseInt(item.attributes._weight ?? '0', 10) || 0,
    }));
  }
  return result;
}

function sortByWeight<T extends { attributes: Record<string, OriginalScalar> }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftWeight = parseInt(left.attributes._weight ?? '0', 10) || 0;
    const rightWeight = parseInt(right.attributes._weight ?? '0', 10) || 0;
    return leftWeight - rightWeight;
  });
}
