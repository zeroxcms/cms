import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('rich-text Markdown pagefield', () => {
  it('renders editable, Markdown, and submitted HTML surfaces', async () => {
    const response = await env.VIEWS.fetch('https://views.local/snippets/pagefield/richtext/md.liquid');
    const source = await response.text();

    expect(response.ok).toBe(true);
    expect(source).toContain('contenteditable="true"');
    expect(source).toContain('data-richtext-preview');
    expect(source).toContain('data-richtext-markdown');
    expect(source).toMatch(/data-richtext-markdown[\s\S]*?text-white/);
    expect(source).toContain('name="{{ field.inputName }}"');
    expect(source).toContain('data-richtext-source');
    expect(source).toContain('>{{ field.value }}</textarea>');
    expect(source).not.toContain('field.value | escape');
  });

  it('repairs HTML entities saved by the double-escaping regression', async () => {
    const response = await env.VIEWS.fetch('https://views.local/assets/richtext-md.js');
    const source = await response.text();

    expect(response.ok).toBe(true);
    expect(source).toContain('decodeEscapedHtml');
    expect(source).toContain('&lt;');
  });

  it('preserves legacy style delimiters as the literal word-joiner entity', async () => {
    const response = await env.VIEWS.fetch('https://views.local/assets/richtext-md.js');
    const source = await response.text();

    expect(source).toContain('eventuai-emphasis');
    expect(source).toContain('&#8288;');
    expect(source).toContain('encodeWordJoiners');
    expect(source).toContain('stripWordJoiners');
    expect(source).toContain('replace(/\\u2060/g,"&#8288;")');
    expect(source).toContain('\\p{P}');
  });
});
