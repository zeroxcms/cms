// Simplified/Traditional Chinese conversion, used to widen advanced-search
// queries: a search for 苏玮 should also match 蘇瑋 and vice versa.
// Conversion data is maintained by the opencc-js package (MIT/Apache-2.0).

import { ConverterFactory } from 'opencc-js/core';
import STCharacters from 'opencc-js/dict/STCharacters';
import TSCharacters from 'opencc-js/dict/TSCharacters';

// CJK Unified Ideographs, Extension A, Compatibility Ideographs.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const convertToTraditional = ConverterFactory([[STCharacters]]);
const convertToSimplified = ConverterFactory([[TSCharacters]]);

export function hasChinese(value: string): boolean {
  return CJK.test(value);
}

export function toTraditional(value: string): string {
  return convertToTraditional(value);
}

export function toSimplified(value: string): string {
  return convertToSimplified(value);
}

/**
 * Returns the distinct set of term variants to search for. For non-Chinese
 * input this is just `[term]`, so callers behave exactly as before. For Chinese
 * input it adds the fully-simplified and fully-traditional forms so a query in
 * either script matches content stored in the other.
 */
export function chineseSearchVariants(term: string): string[] {
  if (!term || !hasChinese(term)) return [term];
  const variants = new Set<string>([term]);
  variants.add(toSimplified(term));
  variants.add(toTraditional(term));
  return [...variants];
}
