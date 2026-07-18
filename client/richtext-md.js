import { marked } from 'marked';
import TurndownService from 'turndown';

// Keeps the rich-text preview, Markdown source, and submitted HTML textarea in
// sync. The conversion order intentionally matches the legacy Eventuai editor:
// contenteditable HTML -> Markdown -> normalized HTML submitted to the CMS.
(function () {
  if (window.WorkerCmsRichtextMd) {
    window.WorkerCmsRichtextMd.scan(document);
    return;
  }

  const turndown = new TurndownService();
  turndown.keep(['u']);

  function markdownToHtml(markdown) {
    const rendered = marked.parse(String(markdown || ''), { async: false }).trim();
    const paragraphs = rendered.match(/<p(?:\s[^>]*)?>/g) || [];
    if (paragraphs.length === 1 && /^<p>[\s\S]*<\/p>$/.test(rendered)) {
      return rendered.replace(/^<p>/, '').replace(/<\/p>$/, '').trim();
    }
    return rendered;
  }

  function htmlToMarkdown(html) {
    return turndown.turndown(String(html || '')).trim();
  }

  function decodeEscapedHtml(value) {
    const source = String(value || '');
    if (source.includes('<')) return source;
    const encodedTags = source.match(/&lt;\/?(?:p|h[1-6]|div|span|strong|em|u|s|del|a|ul|ol|li|blockquote|pre|code|br|hr|img|table|thead|tbody|tr|th|td)(?:\s|&gt;)/gi);
    if (!encodedTags || encodedTags.length < 2) return source;

    const decoder = document.createElement('textarea');
    decoder.innerHTML = source;
    return decoder.value;
  }

  function bind(root) {
    if (root.dataset.richtextReady === 'true') return;

    const preview = root.querySelector('[data-richtext-preview]');
    const markdown = root.querySelector('[data-richtext-markdown]');
    const source = root.querySelector('[data-richtext-source]');
    const modes = root.querySelectorAll('[data-richtext-mode]');
    if (!preview || !markdown || !source || !modes.length) return;

    root.dataset.richtextReady = 'true';
    let syncingSource = false;

    function notifySource() {
      syncingSource = true;
      source.dispatchEvent(new Event('input', { bubbles: true }));
      syncingSource = false;
    }

    function setSourceHtml(html) {
      source.value = html;
      notifySource();
    }

    function syncFromPreview() {
      const markdownValue = htmlToMarkdown(preview.innerHTML);
      markdown.value = markdownValue;
      setSourceHtml(markdownToHtml(markdownValue));
    }

    function syncFromMarkdown() {
      const html = markdownToHtml(markdown.value);
      preview.innerHTML = html;
      setSourceHtml(html);
    }

    function syncFromSource() {
      preview.innerHTML = source.value;
      markdown.value = htmlToMarkdown(source.value);
    }

    function showMode(mode) {
      root.querySelectorAll('[data-richtext-panel]').forEach(function (panel) {
        const active = panel.getAttribute('data-richtext-panel') === mode;
        panel.classList.toggle('hidden', !active);
        panel.setAttribute('aria-hidden', active ? 'false' : 'true');
      });
    }

    const restoredHtml = decodeEscapedHtml(source.value);
    if (restoredHtml !== source.value) source.value = restoredHtml;
    syncFromSource();
    const selectedMode = root.querySelector('[data-richtext-mode]:checked');
    showMode(selectedMode ? selectedMode.value : 'preview');

    preview.addEventListener('input', syncFromPreview);
    preview.addEventListener('blur', function () {
      preview.innerHTML = source.value;
      source.dispatchEvent(new Event('blur'));
    });
    preview.addEventListener('focus', function () {
      source.dispatchEvent(new Event('focus'));
    });
    markdown.addEventListener('input', syncFromMarkdown);
    source.addEventListener('input', function () {
      if (!syncingSource) syncFromSource();
    });
    source.addEventListener('invalid', function () {
      modes.forEach(function (mode) {
        mode.checked = mode.value === 'html';
      });
      showMode('html');
    });
    modes.forEach(function (mode) {
      mode.addEventListener('change', function () {
        if (mode.checked) showMode(mode.value);
      });
    });
  }

  function scan(scope) {
    scope.querySelectorAll('[data-richtext-md]').forEach(bind);
  }

  window.WorkerCmsRichtextMd = {
    htmlToMarkdown,
    markdownToHtml,
    decodeEscapedHtml,
    scan,
  };
  scan(document);
})();
