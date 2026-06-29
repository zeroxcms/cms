(function() {
  'use strict';

  if (window.WorkerCmsPrivacyTable) {
    window.WorkerCmsPrivacyTable.scan();
    return;
  }

  var STORAGE_KEY = 'worker-cms-privacy-revealed';
  var MASK = '***';

  function storedRevealed() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function persistRevealed(revealed) {
    try {
      window.localStorage.setItem(STORAGE_KEY, revealed ? '1' : '0');
    } catch (error) {
      /* ignore */
    }
  }

  function normalizedHeader(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isPrivateHeader(value) {
    var label = normalizedHeader(value);
    return label === 'name'
      || label === 'email'
      || label === 'phone'
      || label === 'name / email'
      || label === 'name / contact';
  }

  function privateColumnIndexes(table) {
    var headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    if (!headRow) return [];
    return Array.from(headRow.cells).reduce(function(indexes, cell, index) {
      if (isPrivateHeader(cell.textContent)) indexes.push(index);
      return indexes;
    }, []);
  }

  function explicitTargets(table) {
    return Array.from(table.querySelectorAll('[data-private-field]'));
  }

  function fallbackTargets(table) {
    var indexes = privateColumnIndexes(table);
    if (!indexes.length || explicitTargets(table).length) return [];

    return Array.from(table.tBodies).flatMap(function(tbody) {
      return Array.from(tbody.rows).flatMap(function(row) {
        if (row.hasAttribute('data-table-filter-empty')) return [];
        return indexes
          .map(function(index) { return row.cells[index]; })
          .filter(function(cell) { return cell; });
      });
    });
  }

  function privateTargets(table) {
    return explicitTargets(table).concat(fallbackTargets(table));
  }

  function ensureOriginal(target) {
    if (target.hasAttribute('data-private-original-html')) return;
    target.setAttribute('data-private-original-html', target.innerHTML);
  }

  function setMasked(target, masked) {
    if (masked) {
      ensureOriginal(target);
      if (target.getAttribute('data-private-masked') === '1' && target.innerHTML === MASK) return;
      target.innerHTML = MASK;
      target.setAttribute('data-private-masked', '1');
      return;
    }
    if (target.getAttribute('data-private-masked') !== '1') return;
    target.innerHTML = target.getAttribute('data-private-original-html') || '';
    target.removeAttribute('data-private-masked');
  }

  function controlFor(table) {
    if (!table.parentElement) return null;
    var existing = Array.from(table.parentElement.children).find(function(child) {
      return child.hasAttribute('data-privacy-control');
    });
    if (existing) return existing.querySelector('[data-privacy-toggle]');

    var row = document.createElement('div');
    row.setAttribute('data-privacy-control', '');
    row.className = 'flex justify-end px-4 py-3';

    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-privacy-toggle', '');
    button.className = 'inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50';
    button.innerHTML = '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#eye-off"></use></svg><span data-privacy-toggle-label></span>';
    row.appendChild(button);

    table.parentElement.insertBefore(row, table);
    return button;
  }

  function renderControls() {
    var revealed = storedRevealed();
    document.querySelectorAll('[data-privacy-toggle]').forEach(function(button) {
      button.setAttribute('aria-pressed', revealed ? 'true' : 'false');
      button.setAttribute('aria-label', revealed ? 'Hide private fields' : 'Reveal private fields');
      button.setAttribute('title', revealed ? 'Hide private fields' : 'Reveal private fields');
      var label = button.querySelector('[data-privacy-toggle-label]');
      if (label) label.textContent = revealed ? 'Hide' : 'Reveal';
    });
  }

  function apply(table) {
    var targets = privateTargets(table);
    if (!targets.length) return;
    controlFor(table);
    var masked = !storedRevealed();
    targets.forEach(function(target) {
      setMasked(target, masked);
    });
  }

  function scan(root) {
    (root || document).querySelectorAll('table[data-privacy-table]').forEach(function(table) {
      apply(table);
    });
    renderControls();
  }

  document.addEventListener('click', function(event) {
    var button = event.target instanceof Element ? event.target.closest('[data-privacy-toggle]') : null;
    if (!button) return;
    event.preventDefault();
    persistRevealed(!storedRevealed());
    scan(document);
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
  window.WorkerCmsPrivacyTable = { scan: scan };
})();
