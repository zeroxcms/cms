export type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

export interface CmsConfig {
  defaultLanguage: string;
  languages: string[];
  blueprint: Record<string, BlueprintEntry[]>;
  blocks: Record<string, BlueprintEntry[]>;
  blockLists: Record<string, string[]>;
  taxonomies: Record<string, string>;
  taxonomyLists: Record<string, string[]>;
}

export const cmsConfig: CmsConfig = {
  defaultLanguage: 'mis',
  languages: ['mis', 'en', 'zh-hant', 'zh-hans'],
  blueprint: {
    default: ['@date:date', 'name:text', 'body:textarea', 'link:link', { items: ['name'] }],
  },
  blocks: {
    default: ['@date', 'name', 'body', 'link__label', 'link__url', { items: ['name'] }],
    label: ['@key:text','subject'],
    logos: ['label', { pictures: ['url'] }],
    paragraphs: ['subject:text', 'body:textarea', 'picture:picture', 'caption:text', 'description:textarea'],
  },
  blockLists: {
    default: ['default', 'label', 'logos', 'paragraphs'],
  },
  taxonomies: {
    years: 'Years',
    categories: 'Categories',
    topics: 'Topics',
    collections: 'Collections',
  },
  taxonomyLists: {
    default: ['years', 'categories', 'topics', 'collections'],
  },
};
