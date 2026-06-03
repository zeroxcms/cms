export function dismissFlashScript(): string {
  return `
    <script>
      const flash = document.getElementById('flash');
      if (flash) setTimeout(() => flash.remove(), 4000);
    </script>`;
}

export function tagFormScript(opts: { isEdit: boolean }): string {
  return `
    <script>
      function switchTagLanguage(language) {
        const params = new window.URLSearchParams(window.location.search);
        params.set('language', language);
        window.location.href = window.location.pathname + '?' + params.toString();
      }

      let tagSlugEdited = ${opts.isEdit ? 'true' : 'false'};
      const tagSlugInput = document.getElementById('tag_slug');
      if (tagSlugInput) {
        tagSlugInput.addEventListener('input', () => { tagSlugEdited = true; });
      }

      function autoTagSlug(name) {
        if (tagSlugEdited || !tagSlugInput) return;
        tagSlugInput.value = name.toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      }
    </script>`;
}
