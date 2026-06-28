(function() {
  if (window.WorkerCmsTableFilter) {
    window.WorkerCmsTableFilter.scan();
    return;
  }

  function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function fieldKey(name) {
    return normalize(name).replace(/[^a-z0-9_-]+/g, '-');
  }

  function controls(form) {
    return Array.from(form.querySelectorAll('input[name], select[name], textarea[name]')).filter(function(control) {
      if (control.disabled) return false;
      if (control instanceof HTMLInputElement) {
        return !['hidden', 'submit', 'button', 'reset'].includes(control.type);
      }
      return true;
    });
  }

  function tableFor(form) {
    var selector = form.getAttribute('data-table-filter-target');
    if (selector) return document.querySelector(selector);
    return form.nextElementSibling && form.nextElementSibling.matches('[data-table-filter]')
      ? form.nextElementSibling
      : document.querySelector('[data-table-filter]');
  }

  function filterValue(control) {
    if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
      return control.checked ? control.value : '';
    }
    return control.value || '';
  }

  function rowValue(row, name) {
    return row.getAttribute('data-filter-' + fieldKey(name)) || '';
  }

  function rowMatches(row, filters) {
    return filters.every(function(filter) {
      var value = normalize(filter.value);
      if (!value) return true;
      if (filter.name === 'q' || filter.name === 'search') {
        return normalize(row.getAttribute('data-filter-search') || row.textContent || '').includes(value);
      }
      var current = normalize(rowValue(row, filter.name));
      return value === 'none' ? current === '' : current === value;
    });
  }

  function setCount(form, count) {
    var selector = form.getAttribute('data-table-filter-count-target');
    var target = selector ? document.querySelector(selector) : null;
    if (target) target.textContent = String(count);

    var labelSelector = form.getAttribute('data-table-filter-count-label-target');
    var label = labelSelector ? document.querySelector(labelSelector) : null;
    if (label) {
      label.textContent = count === 1
        ? (label.getAttribute('data-singular') || 'item')
        : (label.getAttribute('data-plural') || 'items');
    }
  }

  function setClearState(form, active) {
    form.querySelectorAll('[data-table-filter-clear]').forEach(function(control) {
      control.hidden = !active;
    });
  }

  function apply(form) {
    var table = tableFor(form);
    if (!(table instanceof HTMLTableElement)) return;

    var filters = controls(form).map(function(control) {
      return { name: control.getAttribute('name') || '', value: filterValue(control) };
    }).filter(function(filter) {
      return filter.name !== '';
    });
    var active = filters.some(function(filter) {
      return normalize(filter.value) !== '';
    });
    var visible = 0;

    table.querySelectorAll('tbody tr[data-table-filter-row]').forEach(function(row) {
      var matched = rowMatches(row, filters);
      row.hidden = !matched;
      if (matched) visible += 1;
    });

    table.querySelectorAll('tbody tr[data-table-filter-empty]').forEach(function(row) {
      row.hidden = visible !== 0;
    });
    table.setAttribute('data-table-filter-active', active ? '1' : '0');
    setCount(form, visible);
    setClearState(form, active);
  }

  function clear(form) {
    controls(form).forEach(function(control) {
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        control.checked = false;
      } else {
        control.value = '';
      }
    });
    apply(form);
  }

  function formFromEvent(event) {
    return event.target instanceof Element ? event.target.closest('form[data-table-filter-form]') : null;
  }

  function scan(root) {
    (root || document).querySelectorAll('form[data-table-filter-form]').forEach(function(form) {
      apply(form);
    });
  }

  document.addEventListener('input', function(event) {
    var form = formFromEvent(event);
    if (form) apply(form);
  });

  document.addEventListener('change', function(event) {
    var form = formFromEvent(event);
    if (form) apply(form);
  });

  document.addEventListener('submit', function(event) {
    var form = formFromEvent(event);
    if (!form) return;
    event.preventDefault();
    apply(form);
  });

  document.addEventListener('click', function(event) {
    var control = event.target instanceof Element ? event.target.closest('[data-table-filter-clear]') : null;
    if (!control) return;
    var form = control.closest('form[data-table-filter-form]');
    if (!form) return;
    event.preventDefault();
    clear(form);
  });

  var queued = false;
  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function() {
      queued = false;
      scan(document);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scan(document); });
  } else {
    scan(document);
  }

  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
  window.WorkerCmsTableFilter = { scan: scan, apply: apply };
})();
