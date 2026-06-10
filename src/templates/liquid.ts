import { Liquid } from 'liquidjs';
import expand from 'emmet';
import { currentCspNonce } from '../utils/request-context';

const templateCache = new Map<string, Promise<string>>();

class TemplateNotFoundError extends Error {}

interface JsonTemplate {
  sections?: Record<string, JsonSection>;
  order?: string[];
  wrapper?: string;
}

interface JsonSection {
  id?: string;
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, JsonBlock> | JsonBlock[];
  block_order?: string[];
  [key: string]: unknown;
}

interface JsonBlock {
  type?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

function getEngine(views: Fetcher, globals: Record<string, unknown>) {
  return new Liquid({
    cache: true,
    extname: '.liquid',
    globals,
    root: ['layout', 'templates', 'sections', 'snippets'],
    relativeReference: false,
    fs: {
      readFileSync(file: string): string {
        throw new Error(`Synchronous asset reads are not supported: ${file}`);
      },
      async readFile(file: string): Promise<string> {
        return loadTemplate(views, file);
      },
      existsSync(): boolean {
        return false;
      },
      async exists(file: string): Promise<boolean> {
        return templateExists(views, file);
      },
      async contains(): Promise<boolean> {
        return true;
      },
      containsSync(): boolean {
        return true;
      },
      resolve(_root: string, file: string, ext: string): string {
        const fileKey = file.endsWith(ext) ? file : `${file}${ext}`;
        const folder = _root.split('/').pop();
        if ((folder === 'sections' || folder === 'snippets') && !fileKey.startsWith(`${folder}/`)) {
          return `${folder}/${fileKey}`;
        }
        return fileKey;
      },
    },
  });
}

async function loadTemplate(views: Fetcher, path: string): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const cached = templateCache.get(normalizedPath);
  if (cached) return cached;

  const template = views
    .fetch(`https://views.local${normalizedPath}`)
    .then(async (response) => {
      if (!response.ok) {
        templateCache.delete(normalizedPath);
        throw new TemplateNotFoundError(`View file not found: ${normalizedPath}`);
      }
      return response.text();
    });

  templateCache.set(normalizedPath, template);
  return template;
}

export async function templateExists(views: Fetcher, path: string): Promise<boolean> {
  try {
    await loadTemplate(views, path);
    return true;
  } catch (error) {
    if (error instanceof TemplateNotFoundError) return false;
    throw error;
  }
}

export async function renderLiquid(
  views: Fetcher,
  templatePath: string,
  data: Record<string, unknown>,
): Promise<string> {
  const template = await loadTemplate(views, templatePath);
  const renderData = withRequestGlobals(data);
  const engine = getEngine(views, renderData);
  return String(await engine.parseAndRender(template, renderData));
}

/** Inject request-scoped globals (the CSP nonce) every template can rely on. */
function withRequestGlobals(data: Record<string, unknown>): Record<string, unknown> {
  return { nonce: currentCspNonce(), ...data };
}

export async function renderView(
  views: Fetcher,
  viewPath: string,
  data: Record<string, unknown>,
): Promise<string> {
  if (viewPath.endsWith('.json')) return renderJsonTemplate(views, viewPath, data);
  if (viewPath.endsWith('.liquid')) return renderLiquid(views, viewPath, data);

  const liquidPath = `${viewPath}.liquid`;
  if (await templateExists(views, liquidPath)) return renderLiquid(views, liquidPath, data);

  const jsonPath = `${viewPath}.json`;
  if (await templateExists(views, jsonPath)) return renderJsonTemplate(views, jsonPath, data);

  throw new TemplateNotFoundError(`View file not found: ${viewPath}`);
}

async function renderJsonTemplate(
  views: Fetcher,
  templatePath: string,
  data: Record<string, unknown>,
): Promise<string> {
  const rawTemplate = await loadTemplate(views, templatePath);
  const jsonTemplate = JSON.parse(rawTemplate) as JsonTemplate;
  if (!jsonTemplate.order?.length) return '';

  const renderData = withRequestGlobals({
    meta: {},
    ...data,
  });
  const engine = getEngine(views, renderData);
  const renders: Record<string, string> = {};

  for (const key of jsonTemplate.order) {
    const section = jsonTemplate.sections?.[key];
    if (!section) continue;
    section.id = key;

    if (section.type.startsWith('#')) {
      mergeMetaSection(renderData, section);
      continue;
    }

    await parseSettings(engine, section, renderData);
    normalizeBlocks(section);
    if (Array.isArray(section.blocks)) {
      await Promise.all(section.blocks.map((block) => parseSettings(engine, block, renderData)));
    }

    const sectionHtml = await renderLiquid(views, `/sections/${section.type}.liquid`, {
      ...renderData,
      section,
    });
    renders[key] = addSectionComments(key, section, sectionHtml, renderData);
  }

  let result = jsonTemplate.order.map((key) => renders[key]).filter(Boolean).join('\n');

  if (jsonTemplate.wrapper) {
    result = await wrapJsonTemplate(engine, jsonTemplate.wrapper, result, renderData, templatePath);
  }

  if (renderData.debug === true) {
    return `<!-- begin json template: ${escapeComment(templatePath)} -->\n${result}\n<!-- end json template: ${escapeComment(templatePath)} -->`;
  }

  return result;
}

async function parseSettings(
  engine: Liquid,
  node: JsonSection | JsonBlock,
  data: Record<string, unknown>,
): Promise<void> {
  if ('type' in node && typeof node.type === 'string' && hasLiquidSyntax(node.type)) {
    node.type = await renderString(engine, node.type, data);
  }

  for (const key of Object.keys(node.settings ?? {})) {
    const value = node.settings?.[key];
    if (typeof value !== 'string' || !hasLiquidSyntax(value)) continue;
    node.settings![key] = await renderString(engine, value, data, true);
  }
}

async function renderString(
  engine: Liquid,
  value: string,
  data: Record<string, unknown>,
  secondPass = false,
): Promise<string> {
  let text = String(await engine.parseAndRender(value, data));
  if (secondPass && hasLiquidSyntax(text)) {
    text = String(await engine.parseAndRender(text, data));
  }
  return text;
}

function normalizeBlocks(section: JsonSection): void {
  if (!section.block_order?.length || !section.blocks || Array.isArray(section.blocks)) return;
  section.blocks = section.block_order
    .map((key) => (section.blocks as Record<string, JsonBlock>)[key])
    .filter(Boolean);
}

function mergeMetaSection(data: Record<string, unknown>, section: JsonSection): void {
  const metaKey = section.type.replace(/^#/, '');
  const meta = data.meta && typeof data.meta === 'object'
    ? data.meta as Record<string, unknown>
    : {};
  const existing = meta[metaKey];
  const settings = section.settings ?? {};
  const value = settings['value'];

  if (Array.isArray(value)) {
    const set = existing instanceof Set ? existing : new Set();
    value.forEach((item) => set.add(item));
    meta[metaKey] = set;
  } else if (value && typeof value === 'object') {
    meta[metaKey] = {
      ...(existing && typeof existing === 'object' && !(existing instanceof Set) ? existing : {}),
      ...(value as Record<string, unknown>),
    };
  }

  data.meta = meta;
}

async function wrapJsonTemplate(
  engine: Liquid,
  wrapper: string,
  result: string,
  data: Record<string, unknown>,
  templatePath: string,
): Promise<string> {
  let renderedWrapper = wrapper;
  if (hasLiquidSyntax(renderedWrapper)) {
    renderedWrapper = await renderString(engine, renderedWrapper, data);
  }

  try {
    const escapedWrapper = renderedWrapper.replaceAll('\\[', '--sbrk--').replaceAll('\\]', '--ebrk--');
    const expanded = expand(`${escapedWrapper}>span.internal_content`)
      .replaceAll('--sbrk--', '[')
      .replaceAll('--ebrk--', ']');
    return expanded.replace('<span class="internal_content"></span>', result);
  } catch (error) {
    throw new Error(`Error parsing JSON template wrapper: ${templatePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addSectionComments(
  key: string,
  section: JsonSection,
  html: string,
  data: Record<string, unknown>,
): string {
  if (data.sectionComments === false) return html;
  const label = `${key}: ${section.type}`;
  return `<!-- begin section: ${escapeComment(label)} -->\n${html}\n<!-- end section: ${escapeComment(label)} -->`;
}

function hasLiquidSyntax(value: string): boolean {
  return /{{.*}}|{%.*%}/.test(value);
}

function escapeComment(value: string): string {
  return value.replace(/-->/g, '--&gt;');
}
