import { Liquid } from 'liquidjs';

const engine = new Liquid({
  cache: true,
});

const templateCache = new Map<string, Promise<string>>();

async function loadTemplate(views: Fetcher, path: string): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const cached = templateCache.get(normalizedPath);
  if (cached) return cached;

  const template = views
    .fetch(`https://views.local${normalizedPath}`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Liquid template not found: ${normalizedPath}`);
      }
      return response.text();
    });

  templateCache.set(normalizedPath, template);
  return template;
}

export async function renderLiquid(
  views: Fetcher,
  templatePath: string,
  data: Record<string, unknown>,
): Promise<string> {
  const template = await loadTemplate(views, templatePath);
  return String(await engine.parseAndRender(template, data));
}
