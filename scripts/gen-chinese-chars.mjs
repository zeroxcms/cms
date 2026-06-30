// Regenerates src/utils/chinese-chars.ts from the OpenCC character dictionaries.
// Usage: node scripts/gen-chinese-chars.mjs
//
// These dictionaries are character-level (one CJK char per key). We keep the
// first / most-common candidate so each map is a simple 1:1 conversion, which
// is all advanced-search needs to widen a query across Simplified/Traditional.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'utils', 'chinese-chars.ts');

/** Parse an OpenCC dict (key<TAB>value1 value2 ...) into a 1:1 code-point map. */
function parse(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, rest] = line.split('\t');
    if (!key || !rest) continue;
    const val = rest.trim().split(' ')[0];
    // Single-code-point keys/values only; skip no-op entries and duplicates.
    if (!val || [...key].length !== 1 || [...val].length !== 1 || key === val) continue;
    if (!map.has(key)) map.set(key, val);
  }
  return map;
}

async function fetchDict(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch ${name}: ${res.status}`);
  return res.text();
}

const [stText, tsText] = await Promise.all([
  fetchDict('STCharacters.txt'),
  fetchDict('TSCharacters.txt'),
]);

const s2t = parse(stText);
const t2s = parse(tsText);

const keys = (m) => JSON.stringify([...m.keys()].join(''));
const vals = (m) => JSON.stringify([...m.values()].join(''));

const out = `// AUTO-GENERATED — do not edit by hand. Run \`node scripts/gen-chinese-chars.mjs\`.
// Source: OpenCC character dictionaries (STCharacters.txt / TSCharacters.txt),
// Apache-2.0, https://github.com/BYVoid/OpenCC
// Each pair is the first (most common) 1:1 character mapping, stored as two
// parallel strings indexed by code point (iterate with the spread operator).

// Simplified -> Traditional.
export const S2T_KEYS = ${keys(s2t)};
export const S2T_VALS = ${vals(s2t)};

// Traditional -> Simplified.
export const T2S_KEYS = ${keys(t2s)};
export const T2S_VALS = ${vals(t2s)};
`;

writeFileSync(OUT, out);
console.log(`Wrote ${OUT}`);
console.log(`S2T entries: ${s2t.size}, T2S entries: ${t2s.size}, bytes: ${Buffer.byteLength(out)}`);
