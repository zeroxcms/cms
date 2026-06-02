export type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

export interface CmsConfig {
  defaultLanguage: string;
  languages: string[];
  blueprint: Record<string, BlueprintEntry[]>;
  blocks: Record<string, BlueprintEntry[]>;
  blockLists: Record<string, string[]>;
  tagLists: Record<string, string[]>;
}

export const cmsConfig: CmsConfig = {
  defaultLanguage: 'en',
  languages: ['en', 'zh-hant'],
  blueprint: {
    default: ['@date', 'name', 'body', 'link__label', 'link__url', { items: ['name'] }],
    contact: ['name', { position: ['*company', 'name', 'address', 'title'] }],
    company: ['name', 'address'],
  },
  blocks: {
    default: ['@date', 'name', 'body', 'link__label', 'link__url', { items: ['name'] }],
    label: ['subject'],
    logos: ['label', { pictures: ['url'] }],
    paragraphs: ['subject', 'body', 'picture', 'caption', 'description'],
  },
  blockLists: {
    default: ['default', 'label', 'logos', 'paragraphs'],
  },
  tagLists: {
    default: ['years', 'categories', 'topics', 'collections'],
  },
};
