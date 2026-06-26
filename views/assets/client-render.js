(function () {
  'use strict';

  class TemplateNotFoundError extends Error {}

  const payloadEl = document.getElementById('cms-render-payload');
  const payload = payloadEl ? JSON.parse(payloadEl.textContent || '{}') : {};
  const templateCache = new Map();
  const engine = new liquidjs.Liquid({
    cache: true,
    extname: '.liquid',
    root: ['layout', 'templates', 'sections', 'snippets'],
    relativeReference: false,
    fs: {
      readFileSync(file) {
        throw new Error('Synchronous template reads are not supported: ' + file);
      },
      readFile(file) {
        return loadTemplate(file);
      },
      existsSync() {
        return false;
      },
      exists(file) {
        return templateExists(file);
      },
      contains() {
        return true;
      },
      containsSync() {
        return true;
      },
      resolve(root, file, ext) {
        const fileKey = file.endsWith(ext) ? file : file + ext;
        const folder = String(root).split('/').pop();
        if ((folder === 'sections' || folder === 'snippets') && !fileKey.startsWith(folder + '/')) {
          return folder + '/' + fileKey;
        }
        return fileKey;
      },
    },
  });

  function normalizePath(path) {
    return path.startsWith('/') ? path : '/' + path;
  }

  function withRevision(url) {
    const revision = payload.viewRevision;
    if (!revision) return url;
    return url + (url.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(revision);
  }

  async function loadTemplate(path) {
    const normalized = normalizePath(path);
    if (templateCache.has(normalized)) return templateCache.get(normalized);

    const basePath = payload.viewBasePath || '/admin/views';
    const promise = fetch(withRevision(basePath + normalized), {
      credentials: 'same-origin',
      headers: { Accept: normalized.endsWith('.json') ? 'application/json' : 'text/plain' },
    }).then(async (response) => {
      if (!response.ok) {
        templateCache.delete(normalized);
        throw new TemplateNotFoundError('View file not found: ' + normalized);
      }
      return response.text();
    });
    templateCache.set(normalized, promise);
    return promise;
  }

  async function templateExists(path) {
    try {
      await loadTemplate(path);
      return true;
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return false;
      throw error;
    }
  }

  async function renderView(viewPath, data) {
    if (viewPath.endsWith('.json')) return renderJsonTemplate(viewPath, data);
    if (viewPath.endsWith('.liquid')) return renderLiquid(viewPath, data);

    const liquidPath = viewPath + '.liquid';
    if (await templateExists(liquidPath)) return renderLiquid(liquidPath, data);

    const jsonPath = viewPath + '.json';
    if (await templateExists(jsonPath)) return renderJsonTemplate(jsonPath, data);

    throw new TemplateNotFoundError('View file not found: ' + viewPath);
  }

  async function renderLiquid(templatePath, data) {
    const template = await loadTemplate(templatePath);
    return String(await engine.parseAndRender(template, { nonce: payload.nonce, ...data }));
  }

  async function renderJsonTemplate(templatePath, data) {
    const rawTemplate = await loadTemplate(templatePath);
    const jsonTemplate = JSON.parse(rawTemplate);
    if (!jsonTemplate.order || !jsonTemplate.order.length) return '';

    const renderData = await prepareRenderData(templatePath, { meta: {}, nonce: payload.nonce, ...data });
    const renders = {};

    for (const key of jsonTemplate.order) {
      const sourceSection = jsonTemplate.sections && jsonTemplate.sections[key];
      if (!sourceSection) continue;
      const section = clone(sourceSection);
      section.id = key;

      if (typeof section.type === 'string' && section.type.startsWith('#')) {
        mergeMetaSection(renderData, section);
        continue;
      }

      await parseSettings(section, renderData);
      normalizeBlocks(section);
      if (Array.isArray(section.blocks)) {
        await Promise.all(section.blocks.map((block) => parseSettings(block, renderData)));
      }

      const sectionHtml = await renderLiquid('/sections/' + section.type + '.liquid', {
        ...renderData,
        section,
      });
      renders[key] = addSectionComments(key, section, sectionHtml, renderData);
    }

    let result = jsonTemplate.order.map((key) => renders[key]).filter(Boolean).join('\n');
    if (jsonTemplate.wrapper) {
      throw new Error('JSON template wrappers are not supported by the browser renderer: ' + templatePath);
    }
    if (renderData.debug === true) {
      return '<!-- begin json template: ' + escapeComment(templatePath) + ' -->\n' +
        result +
        '\n<!-- end json template: ' + escapeComment(templatePath) + ' -->';
    }
    return result;
  }

  async function parseSettings(node, data) {
    if (typeof node.type === 'string' && hasLiquidSyntax(node.type)) {
      node.type = await renderString(node.type, data);
    }

    const settings = node.settings || {};
    for (const key of Object.keys(settings)) {
      const value = settings[key];
      if (typeof value !== 'string' || !hasLiquidSyntax(value)) continue;
      settings[key] = await renderString(value, data, true);
    }
  }

  async function renderString(value, data, secondPass) {
    let text = String(await engine.parseAndRender(value, data));
    if (secondPass && hasLiquidSyntax(text)) {
      text = String(await engine.parseAndRender(text, data));
    }
    return text;
  }

  function normalizeBlocks(section) {
    if (!section.block_order || !section.block_order.length || !section.blocks || Array.isArray(section.blocks)) return;
    section.blocks = section.block_order.map((key) => section.blocks[key]).filter(Boolean);
  }

  function mergeMetaSection(data, section) {
    const metaKey = String(section.type || '').replace(/^#/, '');
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    const existing = meta[metaKey];
    const settings = section.settings || {};
    const value = settings.value;

    if (Array.isArray(value)) {
      const set = existing instanceof Set ? existing : new Set();
      value.forEach((item) => set.add(item));
      meta[metaKey] = set;
    } else if (value && typeof value === 'object') {
      meta[metaKey] = {
        ...(existing && typeof existing === 'object' && !(existing instanceof Set) ? existing : {}),
        ...value,
      };
    }
    data.meta = meta;
  }

  function addSectionComments(key, section, html, data) {
    if (data.sectionComments === false) return html;
    const label = key + ': ' + section.type;
    return '<!-- begin section: ' + escapeComment(label) + ' -->\n' +
      html +
      '\n<!-- end section: ' + escapeComment(label) + ' -->';
  }

  async function prepareRenderData(_templatePath, data) {
    if (data.structuredModel) {
      data.structuredBlock = await renderStructuredEditor(data.structuredModel);
    }
    return data;
  }

  async function renderStructuredEditor(model) {
    const prepared = {
      ...model,
      settingsHtml: await renderFieldSet(model.settingsFields, model.itemGroups, false),
      contentHtml: await renderFieldSet(model.contentFields, model.itemGroups, true),
      blocks: await Promise.all((model.blocks || []).map(async (block) => ({
        ...block,
        settingsHtml: await renderFieldSet(block.settingsFields, block.itemGroups, false),
        contentHtml: await renderFieldSet(block.contentFields, block.itemGroups, true),
      }))),
    };
    return renderLiquid('/snippets/structured-editor.liquid', prepared);
  }

  async function renderFieldSet(fields, itemGroups, includeItems) {
    const fieldHtml = await renderFieldGrid(await renderFields(fields || []));
    if (!includeItems) return fieldHtml;
    const groups = await Promise.all((itemGroups || []).map((group) => renderItemGroup(group)));
    return fieldHtml + groups.join('');
  }

  async function renderFields(fields) {
    return (await Promise.all(fields.map((field) => renderPageField(field)))).join('');
  }

  async function renderPageField(model) {
    if (model.templatePath) {
      try {
        return await renderLiquid(model.templatePath, model.data);
      } catch (error) {
        if (!(error instanceof TemplateNotFoundError)) console.error(error);
      }
    }
    return renderInput(model.inputName, model.label, model.value, model.type, model.placeholder);
  }

  async function renderFieldGrid(fieldsHtml) {
    if (!fieldsHtml.trim()) return '';
    return '\n    <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">\n      ' +
      fieldsHtml +
      '\n    </div>';
  }

  async function renderItemGroup(group) {
    const rows = group.rows && group.rows.length
      ? (await Promise.all(group.rows.map((row) => renderItemRow(row)))).join('')
      : '<p class="text-sm text-gray-400">No items yet.</p>';

    return '\n    <div class="min-w-0 rounded-lg border border-gray-100 bg-gray-50 p-4 space-y-4">\n' +
      '      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">\n' +
      '        <p class="min-w-0 break-words text-sm font-semibold text-gray-700">' + escapeHtml(group.name) + '</p>\n' +
      '        <button type="submit" name="action" value="' + escapeHtml(group.addAction) + '"\n' +
      '                class="w-full shrink-0 px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-xs font-semibold text-gray-700 sm:w-auto">Add Item</button>\n' +
      '      </div>\n' +
      rows +
      '\n    </div>';
  }

  async function renderItemRow(row) {
    const settingsHtml = await renderFieldSet(row.settingsFields, row.itemGroups, false);
    const contentHtml = await renderFieldSet(row.contentFields, row.itemGroups, true);
    const deleteButton = row.showDelete
      ? '<button type="submit" name="action" value="' + escapeHtml(row.deleteAction) + '"\n' +
        '                   title="Delete ' + escapeHtml(row.label.toLowerCase()) + '" aria-label="Delete ' + escapeHtml(row.label.toLowerCase()) + '"\n' +
        '                   class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-50 hover:text-red-700">\n' +
        '             <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#trash-can"></use></svg>\n' +
        '             <span class="sr-only">Delete</span>\n' +
        '           </button>'
      : '';

    return '<div class="min-w-0 rounded-lg bg-white border border-gray-200 p-4 space-y-3">\n' +
      '                <div class="flex items-center justify-between gap-3">\n' +
      '                  <span class="min-w-0 text-xs text-gray-400">' + escapeHtml(row.label) + '</span>\n' +
      '                  <div class="flex shrink-0 items-center gap-3">\n' +
      renderCompactWeightInput(row.weightInputName, row.weight, 'Weight for ' + row.label.toLowerCase()) +
      deleteButton +
      '                  </div>\n' +
      '                </div>\n' +
      (row.hasSettings
        ? '<div class="space-y-3">\n' +
          '                         <p class="text-xs font-semibold uppercase tracking-wide text-gray-400">Settings</p>\n' +
          settingsHtml +
          '                       </div>'
        : '') +
      contentHtml +
      '              </div>';
  }

  function renderCompactWeightInput(name, value, label) {
    const id = fieldId(name);
    return '<div class="flex items-center gap-1 text-sm text-gray-500">\n' +
      '            <span aria-hidden="true">#</span>\n' +
      '            <label for="' + escapeHtml(id) + '" class="sr-only">' + escapeHtml(label) + '</label>\n' +
      '            <input type="number" id="' + escapeHtml(id) + '" name="' + escapeHtml(name) + '"\n' +
      '                   value="' + escapeHtml(String(value ?? '')) + '"\n' +
      '                   class="w-12 border-b border-transparent bg-transparent p-0 text-right text-lg font-bold focus:border-indigo-500 focus:outline-none">\n' +
      '          </div>';
  }

  function renderInput(name, label, value, type, placeholder) {
    const isLong = String(type).includes('textarea') || label === 'body' || label === 'description';
    const inputType = type === 'date' || type === 'number' ? type : 'text';
    const id = fieldId(name);
    const input = isLong
      ? '<textarea id="' + escapeHtml(id) + '" name="' + escapeHtml(name) + '" rows="4"\n' +
        '                 placeholder="' + escapeHtml(placeholder || '') + '"\n' +
        '                 class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">' + escapeHtml(value ?? '') + '</textarea>'
      : '<input id="' + escapeHtml(id) + '" type="' + escapeHtml(inputType) + '" name="' + escapeHtml(name) + '"\n' +
        '              value="' + escapeHtml(value ?? '') + '"\n' +
        '              placeholder="' + escapeHtml(placeholder || '') + '"\n' +
        '              class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">';

    return '<label for="' + escapeHtml(id) + '" class="' + (isLong ? 'sm:col-span-2 ' : '') + 'min-w-0 block">\n' +
      '            <span class="block text-sm font-medium text-gray-700 mb-1">' + escapeHtml(label) + '</span>\n' +
      input +
      '\n          </label>';
  }

  function fieldId(name) {
    return 'field_' + Array.from(String(name))
      .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : '_' + char.charCodeAt(0).toString(16) + '_'))
      .join('');
  }

  function replaceDocument(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const attr of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(attr.name);
    }
    for (const attr of Array.from(parsed.documentElement.attributes)) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }
    document.title = parsed.title;
    for (const attr of Array.from(document.body.attributes)) {
      document.body.removeAttribute(attr.name);
    }
    for (const attr of Array.from(parsed.body.attributes)) {
      document.body.setAttribute(attr.name, attr.value);
    }
    document.body.innerHTML = parsed.body.innerHTML;
    executeScripts(parsed);
  }

  function executeScripts(parsed) {
    parsed.querySelectorAll('script').forEach((oldScript) => {
      const script = document.createElement('script');
      for (const attr of Array.from(oldScript.attributes)) {
        script.setAttribute(attr.name, attr.value);
      }
      if (!script.nonce && payload.nonce) script.setAttribute('nonce', payload.nonce);
      script.textContent = oldScript.textContent;
      document.body.appendChild(script);
    });
  }

  function hasLiquidSyntax(value) {
    return /{{.*}}|{%.*%}/.test(value);
  }

  function escapeComment(value) {
    return String(value).replace(/-->/g, '--&gt;');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function main() {
    try {
      const layoutData = { ...(payload.layoutData || {}) };
      if (payload.bodyView) {
        layoutData.body = await renderView(payload.bodyView.viewPath, payload.bodyView.data || {});
      }
      const html = await renderLiquid(payload.layoutPath || '/layout/default.liquid', layoutData);
      replaceDocument(html);
    } catch (error) {
      console.error(error);
      const root = document.getElementById('cms-client-root') || document.body;
      root.innerHTML = '<div class="p-6 text-sm text-red-700">Unable to render this page.</div>';
    }
  }

  main();
})();
