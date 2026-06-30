import { describe, expect, it } from 'vitest';
import {
  csvImportMode,
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
import { csvFormatValue, csvRowsToObjects, parseCsv } from '../src/utils/csv';

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

  it('resolves the CSV import mode, defaulting safely', () => {
    expect(csvImportMode('overwrite')).toBe('overwrite');
    expect(csvImportMode('force-new')).toBe('force-new');
    expect(csvImportMode('bogus')).toBe('new-append');
    expect(csvImportMode(undefined)).toBe('new-append');
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

describe('CSV parsing and formatting', () => {
  it('parses quoted CSV and drops fully empty rows', () => {
    const rows = parseCsv('name,note\n"Hello, World","line1\nline2"\n,\n"Quote ""x"""');
    expect(rows[0]).toEqual(['name', 'note']);
    expect(rows[1]).toEqual(['Hello, World', 'line1\nline2']);
    expect(rows[2]).toEqual(['Quote "x"']);
  });

  it('maps rows to objects keyed by header', () => {
    const objects = csvRowsToObjects([
      ['name', 'slug'],
      ['About', 'about'],
    ]);
    expect(objects).toEqual([{ name: 'About', slug: 'about' }]);
  });

  it('formats CSV cells, escaping and protecting numeric strings', () => {
    expect(csvFormatValue(null)).toBe('');
    expect(csvFormatValue('plain')).toBe('plain');
    expect(csvFormatValue('a,b')).toBe('"a,b"');
    expect(csvFormatValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvFormatValue('0123')).toBe('="0123"');
  });

  it('neutralizes CSV/formula-injection payloads', () => {
    // Leading formula triggers are prefixed with an apostrophe so a spreadsheet
    // treats them as text rather than evaluating them.
    expect(csvFormatValue('=1+1')).toBe("'=1+1");
    expect(csvFormatValue('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvFormatValue('+cmd')).toBe("'+cmd");
    expect(csvFormatValue('-cmd|calc')).toBe("'-cmd|calc");
    // A comma in a guarded value still gets quoted (apostrophe retained inside).
    expect(csvFormatValue('=a,b')).toBe('"\'=a,b"');
    // Purely numeric values keep the ="…" text-wrapping (no apostrophe needed).
    expect(csvFormatValue('-5')).toBe('="-5"');
    expect(csvFormatValue('+1')).toBe('="+1"');
  });
});
