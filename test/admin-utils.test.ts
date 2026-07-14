import { describe, expect, it } from 'vitest';
import {
  dashboardPageHref,
  dashboardPageNumber,
  dashboardPageSize,
  dashboardStatusFilter,
  editorsFromForm,
  nullableStr,
  num,
  safeAdminReturnPath,
  slugify,
  str,
  strParam,
} from '../src/utils/forms';
import { validatePageBasics } from '../src/utils/validation';
import {
  advancedSearchCondition,
  advancedSearchOperator,
  advancedSearchOrder,
  advancedSearchSort,
  getPathValue,
  parseAdvancedSearchCriteria,
  sqliteJsonPath,
} from '../src/utils/search';
import { chineseSearchVariants, toSimplified, toTraditional } from '../src/utils/chinese';

describe('forms helpers', () => {
  it('coerces form values to trimmed strings', () => {
    expect(str('  hi  ')).toBe('hi');
    expect(str(undefined)).toBe('');
    expect(str(null)).toBe('');
    expect(strParam('  q ')).toBe('q');
    expect(nullableStr('   ')).toBeNull();
    expect(nullableStr(' x ')).toBe('x');
  });

  it('parses numbers with a fallback', () => {
    expect(num('5')).toBe(5);
    expect(num(3)).toBe(3);
    expect(num('not-a-number', 9)).toBe(9);
    expect(num(undefined)).toBe(5); // default fallback
  });

  it('slugifies names', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Trim --- Me  ')).toBe('trim-me');
    expect(slugify('Café & Co')).toBe('caf-co');
  });

  it('normalizes editor id lists, deduping and dropping invalid ids', () => {
    const form = new FormData();
    form.set('editors', '1, 2 ,2,abc,3');
    expect(editorsFromForm(form)).toBe('1,2,3');

    const empty = new FormData();
    empty.set('editors', 'abc, ,');
    expect(editorsFromForm(empty)).toBeNull();
  });

  it('clamps dashboard page size and number', () => {
    expect(dashboardPageSize('50')).toBe(50);
    expect(dashboardPageSize('0')).toBe(1);
    expect(dashboardPageSize('9999')).toBe(100);
    expect(dashboardPageSize(undefined)).toBe(100);
    expect(dashboardPageNumber('3')).toBe(3);
    expect(dashboardPageNumber('-2')).toBe(1);
    expect(dashboardPageNumber(undefined)).toBe(1);
  });

  it('builds dashboard page hrefs', () => {
    expect(dashboardPageHref('/admin', 2, 50)).toBe('/admin?page=2&pagesize=50');
    expect(dashboardPageHref('/admin', 2, 50, { status: 'live' })).toBe('/admin?page=2&pagesize=50&status=live');
  });

  it('normalizes dashboard status filters', () => {
    expect(dashboardStatusFilter('draft')).toBe('draft');
    expect(dashboardStatusFilter('live')).toBe('live');
    expect(dashboardStatusFilter('published')).toBe('');
    expect(dashboardStatusFilter(undefined)).toBe('');
  });

  it('only allows admin-relative return paths', () => {
    expect(safeAdminReturnPath('/admin/pages/list/default')).toBe('/admin/pages/list/default');
    expect(safeAdminReturnPath('https://evil.example/admin')).toBe('/admin');
    expect(safeAdminReturnPath('/somewhere-else')).toBe('/admin');
    expect(safeAdminReturnPath(undefined, '/admin/trash')).toBe('/admin/trash');
  });
});

describe('validatePageBasics', () => {
  it('flags missing name and slug', () => {
    expect(validatePageBasics('', '')).toEqual([
      'Page name is required.',
      'Slug is required.',
    ]);
  });

  it('flags invalid slug characters only when a slug is present', () => {
    expect(validatePageBasics('Name', 'Bad Slug')).toEqual([
      'Slug may only contain lowercase letters, numbers and hyphens.',
    ]);
  });

  it('accepts a valid name and slug', () => {
    expect(validatePageBasics('Name', 'ok-slug-1')).toEqual([]);
  });
});

describe('advanced search parsing', () => {
  it('parses indexed criteria from a URL, deduping tags', () => {
    const url = 'https://cms.test/admin/advanced-search?search1=hello%20world&path1=name&tags1=1,2&tags1=2&search2=&tags2=5';
    const criteria = parseAdvancedSearchCriteria(url);
    expect(criteria).toEqual([
      { index: 1, term: 'hello world', path: 'name', tags: ['1', '2'] },
      { index: 2, term: '', path: '', tags: ['5'] },
    ]);
  });

  it('omits criteria with neither a term nor tags', () => {
    const url = 'https://cms.test/admin/advanced-search?search1=&path1=name&tags1=';
    expect(parseAdvancedSearchCriteria(url)).toEqual([]);
  });

  it('normalizes operator, sort, and order with safe defaults', () => {
    expect(advancedSearchOperator('or')).toBe('OR');
    expect(advancedSearchOperator('NOT')).toBe('NOT');
    expect(advancedSearchOperator('weird')).toBe('AND');
    expect(advancedSearchSort('name')).toBe('name');
    expect(advancedSearchSort('drop table')).toBe('updated_at');
    expect(advancedSearchOrder('asc')).toBe('ASC');
    expect(advancedSearchOrder('whatever')).toBe('DESC');
  });

  it('builds sqlite json paths and reads nested values', () => {
    expect(sqliteJsonPath('name')).toBe('$.name');
    expect(sqliteJsonPath('link.url')).toBe('$.link.url');
    expect(sqliteJsonPath('')).toBe('$');
    expect(getPathValue({ link: { url: '/x' } }, 'link.url')).toBe('/x');
    expect(getPathValue({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('Chinese Simplified/Traditional search variants', () => {
  it('converts between scripts character by character', () => {
    expect(toTraditional('苏玮')).toBe('蘇瑋');
    expect(toSimplified('蘇瑋')).toBe('苏玮');
    // Unmapped (shared) characters are left untouched.
    expect(toTraditional('中文')).toBe('中文');
  });

  it('adds the opposite-script variant for a Chinese term', () => {
    expect(chineseSearchVariants('苏玮').sort()).toEqual(['苏玮', '蘇瑋'].sort());
    expect(chineseSearchVariants('蘇瑋').sort()).toEqual(['苏玮', '蘇瑋'].sort());
  });

  it('returns a single variant for non-Chinese or shared-character terms', () => {
    expect(chineseSearchVariants('hello')).toEqual(['hello']);
    expect(chineseSearchVariants('')).toEqual(['']);
    // 中文 is identical in both scripts, so no extra variant is produced.
    expect(chineseSearchVariants('中文')).toEqual(['中文']);
  });

  it('ORs a LIKE per variant in the SQL condition for a Chinese term', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: '苏玮', path: '', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['(p.lect LIKE ? OR p.lect LIKE ?)']);
    expect(params).toEqual(['%苏玮%', '%蘇瑋%']);
  });

  it('keeps a single LIKE (no OR) for a non-Chinese term', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: 'hello world', path: '', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['p.lect LIKE ?']);
    expect(params).toEqual(['%hello%world%']);
  });

  it('ORs variants within a json path condition', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: '苏玮', path: 'name', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['(json_extract(p.lect, ?) LIKE ? OR json_extract(p.lect, ?) LIKE ?)']);
    expect(params).toEqual(['$.name', '%苏玮%', '$.name', '%蘇瑋%']);
  });
});
