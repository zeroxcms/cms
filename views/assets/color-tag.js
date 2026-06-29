(function() {
  if (window.WorkerCmsColorTag) {
    window.WorkerCmsColorTag.scan(document);
    return;
  }

  function pickerFor(target) {
    return target instanceof Element ? target.closest('[data-color-tag-picker]') : null;
  }

  function colorFromSubmitter(form, submitter) {
    if (submitter instanceof HTMLButtonElement && submitter.name === 'color') {
      return submitter.value || '';
    }
    var checked = form.querySelector('[name="color"]:checked');
    if (checked instanceof HTMLInputElement) return checked.value || '';
    var current = form.getAttribute('data-color-tag-value');
    return current || '';
  }

  function setOpen(form, open) {
    var menu = form.querySelector('[data-color-tag-menu]');
    var toggle = form.querySelector('[data-color-tag-toggle]');
    if (open) form.removeAttribute('data-color-tag-suppress-open');
    if (menu) menu.classList.toggle('hidden', !open);
    if (menu) menu.classList.toggle('flex', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeAfterSelection(form) {
    form.setAttribute('data-color-tag-suppress-open', '1');
    var active = document.activeElement;
    if (active instanceof HTMLElement && form.contains(active)) active.blur();
    setOpen(form, false);
  }

  function closeAll(except) {
    document.querySelectorAll('[data-color-tag-picker]').forEach(function(form) {
      if (form !== except) setOpen(form, false);
    });
  }

  function setColor(form, color) {
    var normalized = String(color || '').trim().toLowerCase();
    form.setAttribute('data-color-tag-value', normalized);
    form.querySelectorAll('[data-color-tag-dot]').forEach(function(dot) {
      dot.setAttribute('data-color-tag-color', normalized);
    });
    form.querySelectorAll('[data-color-tag-option]').forEach(function(option) {
      option.setAttribute('aria-checked', option.getAttribute('data-color-tag-color') === normalized ? 'true' : 'false');
    });
    var row = form.closest('[data-table-filter-row]');
    if (row) row.setAttribute('data-filter-color', normalized);
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-color-tag-picker]').forEach(function(form) {
      setColor(form, form.getAttribute('data-color-tag-value') || '');
      setOpen(form, false);
    });
  }

  document.addEventListener('click', function(event) {
    var toggle = event.target instanceof Element ? event.target.closest('[data-color-tag-toggle]') : null;
    if (toggle) {
      var form = pickerFor(toggle);
      if (!form) return;
      event.preventDefault();
      var menu = form.querySelector('[data-color-tag-menu]');
      var open = !(menu && menu.classList.contains('flex'));
      closeAll(form);
      setOpen(form, open);
      return;
    }

    if (!pickerFor(event.target)) closeAll(null);
  });

  document.addEventListener('pointerover', function(event) {
    var toggle = event.target instanceof Element ? event.target.closest('[data-color-tag-toggle]') : null;
    if (!toggle) return;
    var form = pickerFor(toggle);
    if (form) form.removeAttribute('data-color-tag-suppress-open');
  });

  document.addEventListener('pointerout', function(event) {
    var form = pickerFor(event.target);
    if (!form) return;
    var related = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (!related || !form.contains(related)) form.removeAttribute('data-color-tag-suppress-open');
  });

  document.addEventListener('focusin', function(event) {
    var toggle = event.target instanceof Element ? event.target.closest('[data-color-tag-toggle]') : null;
    if (!toggle) return;
    var form = pickerFor(toggle);
    if (form) form.removeAttribute('data-color-tag-suppress-open');
  });

  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') closeAll(null);
  });

  document.addEventListener('submit', async function(event) {
    var form = pickerFor(event.target);
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();

    var submitter = event.submitter;
    var color = colorFromSubmitter(form, submitter);
    var previous = form.getAttribute('data-color-tag-value') || '';
    var body = new FormData(form);
    body.set('color', color);
    closeAfterSelection(form);
    form.setAttribute('data-color-tag-busy', '1');

    try {
      var response = await fetch(form.action, {
        method: form.method || 'post',
        headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
        body: body,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Color tag update failed');
      var payload = await response.json().catch(function() { return null; });
      var next = payload && payload.payload && typeof payload.payload.color === 'string'
        ? payload.payload.color
        : color;
      setColor(form, next);
      if (window.WorkerCmsTableFilter) window.WorkerCmsTableFilter.scan(document);
    } catch (error) {
      setColor(form, previous);
    } finally {
      form.removeAttribute('data-color-tag-busy');
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scan(document); });
  } else {
    scan(document);
  }

  window.WorkerCmsColorTag = { scan: scan };
})();
