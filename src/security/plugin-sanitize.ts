const URL_ATTRS = new Set(['action', 'href', 'src', 'xlink:href', 'formaction']);

const stripPluginScripts = new HTMLRewriter()
  .on('script', {
    element(element) {
      element.remove();
    },
  })
  .on('*', {
    element(element) {
      const removeAttrs: string[] = [];
      for (const [name, value] of element.attributes) {
        const normalized = name.toLowerCase();
        if (normalized.startsWith('on')) {
          removeAttrs.push(name);
          continue;
        }
        if (URL_ATTRS.has(normalized) && isJavascriptUrl(value)) {
          removeAttrs.push(name);
        }
      }
      for (const name of removeAttrs) element.removeAttribute(name);
    },
  });

export function sanitizePluginHtmlResponse(response: Response): Response {
  return stripPluginScripts.transform(response);
}

export async function sanitizePluginHtmlFragment(html: string): Promise<string> {
  return sanitizePluginHtmlResponse(
    new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  ).text();
}

function isJavascriptUrl(value: string): boolean {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase().startsWith('javascript:');
}
