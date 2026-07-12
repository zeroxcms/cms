// Wires page-reference comboboxes ([data-page-ref], see
// snippets/pagefield/page/basic.liquid): searches /admin/api/pages/<type>?q=…
// and writes the chosen page id into the hidden pointer input. Loaded as a
// core admin asset so it also runs where inline scripts don't: the client
// renderer re-executes nonce'd layout scripts after replacing the DOM, and
// plugin-rendered views have all inline scripts stripped by sanitizePluginHtml.
// Re-executions call scan() again, so newly rendered fields get wired.
(function () {
  if (window.WorkerCmsPageRef) {
    window.WorkerCmsPageRef.scan(document);
    return;
  }

  function stripLabel(value) {
    return (value || '').replace(/\s*\(#\d+\)\s*$/, '').replace(/^#/, '').trim();
  }

  function bind(root) {
    if (root.dataset.bound) return;
    root.dataset.bound = '1';
    var type = root.getAttribute('data-page-ref-type') || '';
    var base = '/admin/api/pages/' + encodeURIComponent(type);
    var hidden = root.querySelector('[data-page-ref-id]');
    var search = root.querySelector('[data-page-ref-search]');
    var results = root.querySelector('[data-page-ref-results]');
    var clearBtn = root.querySelector('[data-page-ref-clear]');
    var timer;

    function close() { results.classList.add('hidden'); search.setAttribute('aria-expanded', 'false'); }
    function open() { results.classList.remove('hidden'); search.setAttribute('aria-expanded', 'true'); }

    function toggleClear() {
      if (!clearBtn) return;
      if (hidden.value) { clearBtn.classList.remove('hidden'); clearBtn.classList.add('inline-flex'); }
      else { clearBtn.classList.add('hidden'); clearBtn.classList.remove('inline-flex'); }
    }

    function clearRef() {
      hidden.value = '';
      search.value = '';
      toggleClear();
      close();
    }

    function choose(item) {
      hidden.value = item.id;
      search.value = item.name ? (item.name + ' (#' + item.id + ')') : ('#' + item.id);
      toggleClear();
      close();
    }

    function render(items) {
      results.textContent = '';
      if (!items.length) {
        var empty = document.createElement('p');
        empty.className = 'px-3 py-2 text-xs text-gray-400';
        empty.textContent = 'No matching pages';
        results.appendChild(empty);
      } else {
        items.forEach(function (item) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50';
          var name = document.createElement('span');
          name.className = 'block font-medium';
          name.textContent = item.name || ('#' + item.id);
          var meta = document.createElement('span');
          meta.className = 'block text-xs text-gray-400';
          meta.textContent = '/' + (item.slug || '') + ' · #' + item.id;
          btn.appendChild(name);
          btn.appendChild(meta);
          // mousedown (not click) fires before the input blur that would close the list.
          btn.addEventListener('mousedown', function (event) { event.preventDefault(); choose(item); });
          results.appendChild(btn);
        });
      }
      open();
    }

    function fetchPages(query) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        fetch(base + '?q=' + encodeURIComponent(query), { headers: { accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : []; })
          .then(function (data) { render(Array.isArray(data) ? data : []); })
          .catch(function () {});
      }, 180);
    }

    search.addEventListener('focus', function () { fetchPages(stripLabel(search.value)); });
    search.addEventListener('input', function () {
      var value = stripLabel(search.value);
      // Allow typing a raw page id directly.
      if (/^\d+$/.test(value)) hidden.value = value;
      if (!value) { hidden.value = ''; toggleClear(); }
      fetchPages(value);
    });
    search.addEventListener('blur', function () {
      setTimeout(function () {
        if (!stripLabel(search.value)) { hidden.value = ''; search.value = ''; toggleClear(); }
        else if (hidden.value && !search.value) { search.value = '#' + hidden.value; toggleClear(); }
      }, 200);
    });
    if (clearBtn) clearBtn.addEventListener('click', function (event) { event.preventDefault(); clearRef(); });
    document.addEventListener('click', function (event) { if (!root.contains(event.target)) close(); });

    // Label the current selection with its page name.
    toggleClear();
    if (hidden.value) {
      fetch(base + '?id=' + encodeURIComponent(hidden.value), { headers: { accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : []; })
        .then(function (data) {
          if (data && data[0] && data[0].name) search.value = data[0].name + ' (#' + data[0].id + ')';
        })
        .catch(function () {});
    }
  }

  function scan(scope) {
    scope.querySelectorAll('[data-page-ref]').forEach(bind);
  }

  window.WorkerCmsPageRef = { scan: scan };
  scan(document);
})();
