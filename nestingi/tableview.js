/*
 * Sortowanie i filtrowanie list po kliknięciu nagłówka kolumny.
 * Działa na każdej tabeli .grid leżącej bezpośrednio w .table-wrap – zmienia tylko widok
 * (kolejność i widoczność wierszy), nie dane. Ustawienia trzymane są osobno dla każdej listy.
 */
(function () {
  'use strict';
  const views = {};                       // id listy → { sort: {col, dir} | null, filters: {col: tekst} }
  const view = id => views[id] || (views[id] = { sort: null, filters: {} });
  const FUNNEL = '<svg viewBox="0 0 10 10" width="9" height="9"><path d="M0 1h10L6 5.2V9L4 8V5.2z" fill="currentColor"/></svg>';

  function cellVal(td) {
    if (!td) return '';
    const i = td.querySelector('input');
    if (i) return i.type === 'checkbox' ? (i.checked ? 'tak' : 'nie') : i.value.trim();
    const t = td.textContent.replace(/\s+/g, ' ').trim();
    return t === '—' ? '' : t;
  }
  function toNum(s) {
    const t = String(s).replace(/[\s  ]/g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }
  /** Filtr: „tekst” = zawiera; dla liczb także >, <, >=, <=, =, <> (np. >1000). */
  function match(val, f) {
    f = f.trim();
    if (!f) return true;
    const m = f.match(/^(<=|>=|<>|<|>|=)\s*(.+)$/);
    if (m) {
      const a = toNum(val), b = toNum(m[2]);
      if (!isNaN(b)) {
        if (isNaN(a)) return m[1] === '<>';
        return { '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b, '=': a === b, '<>': a !== b }[m[1]];
      }
      if (m[1] === '=') return val.toLowerCase() === m[2].trim().toLowerCase();
      if (m[1] === '<>') return val.toLowerCase() !== m[2].trim().toLowerCase();
    }
    return val.toLowerCase().includes(f.toLowerCase());
  }
  function compare(a, b) {
    if (a === b) return 0;
    const na = toNum(a), nb = toNum(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b, 'pl', { numeric: true, sensitivity: 'base' });
  }

  function apply(wrap) {
    const old = wrap.querySelector(':scope > .viewnote'); if (old) old.remove();
    const table = wrap.querySelector(':scope > table.grid');
    if (table && table.tBodies[0] && table.tHead) {
      const v = view(wrap.id), body = table.tBodies[0], rows = Array.from(body.rows);
      rows.forEach((tr, i) => { if (tr._ord === undefined) tr._ord = i; });
      const fcols = Object.keys(v.filters).filter(c => v.filters[c].trim());
      let shown = 0;
      rows.forEach(tr => {
        const ok = fcols.every(c => match(cellVal(tr.cells[c]), v.filters[c]));
        tr.classList.toggle('vhide', !ok); if (ok) shown++;
      });
      const sorted = rows.slice().sort((x, y) => {
        if (v.sort) {
          const a = cellVal(x.cells[v.sort.col]), b = cellVal(y.cells[v.sort.col]);
          if (!a !== !b) return a ? -1 : 1;                 // puste zawsze na końcu
          const c = compare(a, b) * v.sort.dir;
          if (c) return c;
        }
        return x._ord - y._ord;
      });
      if (sorted.some((tr, i) => tr !== rows[i])) sorted.forEach(tr => body.appendChild(tr));
      Array.from(table.tHead.rows[0].cells).forEach((th, i) => {
        const ind = th.querySelector('.ind'); if (ind) ind.remove();
        const f = fcols.includes(String(i)), s = v.sort && v.sort.col === i;
        th.classList.toggle('filtered', f);
        if (f || s) th.insertAdjacentHTML('beforeend', `<span class="ind">${s ? (v.sort.dir > 0 ? '▲' : '▼') : ''}${f ? FUNNEL : ''}</span>`);
      });
      if (shown < rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="viewnote">Filtr: pokazano ${shown} z ${rows.length} wierszy <button data-viewclear="1">Wyczyść filtry</button></div>`);
    }
    observer.takeRecords();               // własne zmiany nie uruchamiają ponownego przeliczenia
  }

  // każda przebudowa listy (innerHTML) → ponowne nałożenie sortowania i filtrów
  const observer = new MutationObserver(recs => new Set(recs.map(r => r.target)).forEach(apply));
  document.querySelectorAll('.table-wrap').forEach(w => observer.observe(w, { childList: true }));

  // ---------- menu nagłówka ----------
  let menu = null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(th) {
    closeMenu();
    const wrap = th.closest('.table-wrap'), col = th.cellIndex, v = view(wrap.id);
    const title = th.textContent.replace(/[▲▼]/g, '').trim();
    const vals = Array.from(new Set(Array.from(wrap.querySelectorAll(':scope > table > tbody > tr')).map(tr => cellVal(tr.cells[col])).filter(Boolean))).sort(compare).slice(0, 300);
    const dir = v.sort && v.sort.col === col ? v.sort.dir : 0;
    menu = document.createElement('div');
    menu.className = 'colmenu';
    menu.innerHTML = `<div class="cm-title">${esc(title)}</div>
      <button data-s="1" class="${dir > 0 ? 'on' : ''}">▲ Sortuj rosnąco</button>
      <button data-s="-1" class="${dir < 0 ? 'on' : ''}">▼ Sortuj malejąco</button>
      <button data-s="0" ${v.sort ? '' : 'disabled'}>Bez sortowania</button>
      <label>Filtr</label>
      <input id="colmenuFilter" list="colmenuList" placeholder="zawiera…  albo  >1000, <=5, =S355" value="${esc(v.filters[col] || '')}">
      <datalist id="colmenuList">${vals.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="cm-row"><button data-c="col" ${v.filters[col] ? '' : 'disabled'}>Wyczyść filtr</button><button data-c="all">Wyczyść wszystko</button></div>`;
    menu._wrap = wrap; menu._col = col;
    document.body.appendChild(menu);
    const r = th.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + 'px';
    menu.style.top = Math.min(r.bottom + 2, window.innerHeight - menu.offsetHeight - 6) + 'px';
    const inp = menu.querySelector('input');
    inp.addEventListener('input', () => { v.filters[col] = inp.value; apply(wrap); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') closeMenu(); });
    inp.focus(); inp.select();
  }

  document.addEventListener('click', e => {
    if (menu && menu.contains(e.target)) {
      const b = e.target.closest('button'); if (!b) return;
      const wrap = menu._wrap, col = menu._col, v = view(wrap.id);
      if (b.dataset.s !== undefined) v.sort = Number(b.dataset.s) ? { col, dir: Number(b.dataset.s) } : null;
      if (b.dataset.c === 'col') delete v.filters[col];
      if (b.dataset.c === 'all') { v.filters = {}; v.sort = null; }
      apply(wrap); closeMenu();
      return;
    }
    const clear = e.target.closest('[data-viewclear]');
    if (clear) { const wrap = clear.closest('.table-wrap'); view(wrap.id).filters = {}; apply(wrap); closeMenu(); return; }
    const th = e.target.closest('.table-wrap > table.grid > thead th');
    if (th && th.textContent.trim()) { openMenu(th); return; }
    closeMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);

  window.NEST = window.NEST || {};
  window.NEST.tableView = {
    /** Zdejmuje sortowanie i filtry z jednej listy (np. przed dodaniem nowego wiersza). */
    reset(id) { delete views[id]; const w = document.getElementById(id); if (w) apply(w); },
    resetAll() { Object.keys(views).forEach(id => this.reset(id)); },
  };
})();
