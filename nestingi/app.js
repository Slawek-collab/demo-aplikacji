/* Okno aplikacji: stan projektu, tabele, edytor końców, uruchamianie nestingu, raport. */
(function () {
  'use strict';
  const { geometry: geo, nesting, catalog, draw, report } = window.NEST;
  const { esc, fmt } = draw;
  const tv = window.NEST.tableView;
  const $ = s => document.querySelector(s);
  const api = window.api;
  const APP = 'Nesting profili';

  // ---------- stan ----------
  // db = widok roboczy: katalog profili (wspólny plik programu) + stan magazynu z bieżącego projektu
  let db = catalog.emptyDb(), dbPath = '', dbMtime = 0;
  let legacyStock = null;   // magazyn z plików sprzed wersji z magazynem w projekcie
  const emptyStock = () => ({ bars: [], remnants: [], history: [], seq: { bar: 1, remnant: 1, job: 1 } });
  function bindStock() {
    const st = project.stock;
    db.bars = st.bars; db.remnants = st.remnants; db.history = st.history; db.seq = st.seq;
  }
  let project = newProject();
  let projectPath = null, dirty = false, selectedId = null, availability = null, keep = {};
  let uid = 1;

  function newProject() {
    return { app: 'nesting-profili', version: 1, meta: { name: '', number: '', author: '' }, parts: [], cart: [], nestings: [], stock: emptyStock(), seq: { nesting: 1 }, options: Object.assign({}, nesting.DEFAULTS), result: null,
      revisionOf: null };   // { baseNo, revision, from } – koszyk z cofniętego nestingu, zatwierdzany jako jego zmiana
  }
  const newId = () => 'd' + Date.now().toString(36) + (uid++);
  const colorOf = id => draw.colorFor(project.parts.findIndex(p => p.id === id));
  const selected = () => project.parts.find(p => p.id === selectedId) || null;
  const partById = id => project.parts.find(p => p.id === id) || null;
  /** Sztuki detalu zużyte we wszystkich zatwierdzonych nestingach projektu. */
  const usedOf = id => project.nestings.reduce((s, n) => s + ((n.used || {})[id] || 0), 0);
  const cartQty = id => { const c = project.cart.find(x => x.partId === id); return c ? c.qty : 0; };
  const remainingOf = p => (Number(p.qty) || 0) - usedOf(p.id) - cartQty(p.id);
  const cartParts = () => project.cart.map(c => { const p = partById(c.partId); return p && c.qty > 0 ? Object.assign({}, p, { qty: c.qty }) : null; }).filter(Boolean);
  let reportNestingId = null, archiveSel = null, archPick = null;   // archPick: zaznaczony detal w bazie nestingów { key, no, i }
  const dimsOf = p => { const pr = catalog.profileMap(db)[String(p.profile || '').trim().toUpperCase()]; return { h: pr ? pr.h : 0, b: pr ? pr.b : 0, known: !!pr, shape: pr ? pr.shape : '' }; };
  const num = v => { const n = Number(String(v).replace(',', '.').replace(/\s/g, '')); return isFinite(n) ? n : 0; };
  const m1 = mm => (mm / 1000).toFixed(2).replace('.', ',');
  const pct = v => (v * 100).toFixed(1).replace('.', ',') + '%';

  function setDirty(v) {
    if (typeof updateToolbar === 'function') try { updateToolbar(); } catch (e) { /* przed startem */ }
    dirty = v; api.setDirty(v);
    const name = projectPath ? projectPath.split(/[\\/]/).pop() : 'nowy projekt';
    api.setTitle(`${dirty ? '● ' : ''}${name} – ${APP}`);
    $('#statusLeft').textContent = `Projekt: ${projectPath || 'niezapisany'}${dirty ? ' (zmieniony)' : ''}`;
  }
  /** Zmiana danych wejściowych unieważnia wynik nestingu. */
  function changed(invalidate) {
    if (invalidate && project.result) { project.result = null; keep = {}; renderResult(); renderReport(); }
    if (invalidate) { availability = null; renderAvailability(); }
    setDirty(true);
  }

  // ---------- okna dialogowe ----------
  function modal(title, bodyHtml, buttons) {
    return new Promise(resolve => {
      $('#modalTitle').textContent = title;
      $('#modalBody').innerHTML = bodyHtml;
      const box = $('#modalActions'); box.innerHTML = '';
      buttons.forEach(b => {
        const el = document.createElement('button');
        el.textContent = b.label; if (b.primary) el.className = 'primary';
        el.onclick = () => { $('#modal').classList.add('hidden'); resolve(b.value); };
        box.appendChild(el);
      });
      $('#modalBody').onclick = e => { const b = e.target.closest('[data-pick]'); if (b) { $('#modal').classList.add('hidden'); resolve({ pick: b.dataset.pick }); } };
      $('#modal').classList.remove('hidden');
      const f = $('#modalBody textarea, #modalBody input'); if (f) f.focus();
    });
  }
  const info = (title, html) => modal(title, html, [{ label: 'OK', value: true, primary: true }]);
  const confirmBox = (title, html, yes) => modal(title, html, [{ label: 'Anuluj', value: false }, { label: yes || 'Tak', value: true, primary: true }]);
  async function confirmDiscard() {
    return !dirty || confirmBox('Niezapisane zmiany', 'Projekt ma niezapisane zmiany. Kontynuować bez zapisywania?', 'Kontynuuj bez zapisu');
  }

  // ---------- baza ----------
  async function loadDb() {
    const r = await api.dbLoad();
    const file = catalog.normalizeDb(r.db);
    legacyStock = { bars: file.bars, remnants: file.remnants, history: file.history, seq: file.seq };
    db = { version: 1, profiles: file.profiles }; dbPath = r.path; dbMtime = r.mtime || 0;
    bindStock();
    if (!r.db) await saveDb();
    renderStock(); renderLists();
  }
  let saveTimer = null;
  function saveDbSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDb, 400); }
  /** Zapisuje katalog profili (plik programu). Stan magazynu zapisuje się razem z projektem. */
  async function saveDb() {
    clearTimeout(saveTimer);
    const r = await api.dbSave(Object.assign({}, legacyStock, { version: 1, profiles: db.profiles }), dbMtime);
    if (r && r.conflict) {
      await loadDb();
      await info('Katalog zmieniony na dysku', 'Plik katalogu profili został w międzyczasie zmieniony (np. przez innego użytkownika). Wczytałem aktualną wersję – powtórz ostatnią zmianę.');
      return false;
    }
    if (r && r.mtime) dbMtime = r.mtime;
    return true;
  }

  // ---------- pasek narzędzi ----------
  const ICONS = {
    new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    open: '<path d="M3 7h6l2 2h10v10H3z"/>',
    recent: '<path d="M3 7h6l2 2h10v10H3z"/><circle cx="15.5" cy="14.5" r="3.3"/><path d="M15.5 12.8v1.9l1.3.8"/>',
    save: '<path d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
    saveas: '<path d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3"/><path d="M12 13v6M9 16h6"/>',
    check: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7"/><path d="M9 14l2 2 4-4"/>',
    nest: '<path d="M2 8h20v8H2z"/><path d="M8 8l3 8M15 8l3 8"/>',
    pdf: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
    commit: '<path d="M4 4h16v6H4zM4 14h16v6H4z"/><path d="M8 17l2 2 5-4"/>',
    ident: '<path d="M3 6h11l7 6-7 6H3z"/><path d="M6.5 9.5v5M9 9.5v5M11.5 9.5v5"/><circle cx="15.5" cy="12" r="1"/>',
  };
  const TOOLBAR = [['new', 'Nowy'], ['open', 'Otwórz'], ['recent', 'Otwórz ostatnie'], ['save', 'Zapisz'], ['saveas', 'Zapisz jako'], null,
    ['check', 'Sprawdź materiał'], ['nest', 'Nesting', 'hl'], null, ['pdf', 'Raport PDF'], ['commit', 'Zatwierdź nesting'], null, ['ident', 'Identyfikacja materiałowa']];
  $('#toolbarButtons').innerHTML = TOOLBAR.map(t => t
    ? `<button class="tb-btn ${t[2] || ''}" data-act="${t[0]}" data-label="${t[1]}" title="${t[1]}"><svg viewBox="0 0 24 24">${ICONS[t[0]]}</svg>${t[1]}</button>`
    : '<div class="tb-sep"></div>').join('');

  // ---------- zakładki ----------
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'parts') refreshCounts();
    if (name === 'cart') renderCart();
    if (name === 'archive') renderArchive();
    if (name === 'stock') renderStock();
    if (name === 'report') renderReport();
  }
  $('#tabs').addEventListener('click', e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

  function renderLists() {
    $('#profileList').innerHTML = db.profiles.map(p => `<option value="${esc(p.name)}">`).join('');
    $('#gradeList').innerHTML = catalog.GRADES.map(g => `<option value="${g}">`).join('');
  }

  // ---------- detale ----------
  /** Krótki opis końca do tabeli (pełny w podpowiedzi): „skos 45° (środnik, cięta góra)” → „45° środnik, góra”. */
  const shortEnd = d => d.replace(/^skos /, '').replace(/[()]/g, '').replace(/cięta /g, '').replace(/\s+,/g, ',').trim();
  function endCell(e, shape) {
    const d = geo.describeEnd(e, shape);
    return `<span class="${d === 'prosto' ? '' : 'cut'}" title="${esc(d)}">${esc(shortEnd(d))}</span>`;
  }
  const CART_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 4h2.6l2.3 11h10.8l2.3-8H6.3"/><circle cx="9.5" cy="19.5" r="1.6"/><circle cx="17" cy="19.5" r="1.6"/></svg>';
  function renderParts() {
    const wrap = $('#partsWrap');
    if (!project.parts.length) {
      wrap.innerHTML = '<div class="empty">Lista jest pusta. Kliknij „+ Dodaj detal” albo wklej listę skopiowaną z Excela.</div>';
      renderEditor(); updateTabBadges(); return;
    }
    wrap.innerHTML = `<table class="grid" id="partsTable"><thead><tr><th class="n" style="width:50px">Lp.</th><th class="pname">Nazwa</th><th style="width:130px">Profil</th><th style="width:88px">Gatunek</th><th style="width:92px" title="Kod materiału (article no) – detal z kodem jest cięty tylko z materiału z tym samym kodem">Kod mat.</th>
      <th class="n" style="width:88px">Długość</th><th class="n" style="width:66px">Ilość</th><th class="n" style="width:70px" title="Sztuki w zatwierdzonych nestingach">Użyto</th><th class="n" style="width:78px" title="Sztuki w bieżącym koszyku">Koszyk</th><th class="n" style="width:82px" title="Sztuki jeszcze nieprzydzielone">Zostało</th>
      <th style="width:124px">Początek</th><th style="width:124px">Koniec</th><th class="acts"></th></tr></thead><tbody>` +
      project.parts.map((p, i) => `<tr data-id="${p.id}" class="${p.id === selectedId ? 'sel' : ''}">
        <td class="n t"><span class="sw" style="background:${colorOf(p.id)}"></span> ${i + 1}</td>
        <td><input data-f="name" value="${esc(p.name)}" title="${esc(p.name)}"></td>
        <td><input data-f="profile" list="profileList" value="${esc(p.profile)}" class="${p.profile && !dimsOf(p).known ? 'bad' : ''}" title="${p.profile && !dimsOf(p).known ? 'Profilu nie ma w katalogu – dodaj go w zakładce Magazyn' : ''}"></td>
        <td><input data-f="grade" list="gradeList" value="${esc(p.grade)}"></td>
        <td><input data-f="code" list="codeList" placeholder="—" value="${esc(p.code || '')}"></td>
        <td><input data-f="length" type="number" min="1" step="1" value="${p.length || ''}"></td>
        <td><input data-f="qty" type="number" min="1" step="1" value="${p.qty || ''}"></td>
        <td class="n t" data-c="used"></td><td class="n t" data-c="cart"></td><td class="n t" data-c="left"></td>
        <td class="endsum" data-end="1">${endCell(p.end1, dimsOf(p).shape)}</td><td class="endsum" data-end="2">${endCell(p.end2, dimsOf(p).shape)}</td>
        <td class="acts"><button data-act="part-tocart" class="tocart" title="Przenieś pozostałe sztuki tego detalu do koszyka" aria-label="Do koszyka">→ ${CART_ICON}</button><button class="x" data-act="part-del" title="Usuń detal">✕</button></td></tr>`).join('') + '</tbody></table>';
    refreshCounts(); renderEditor(); markCodeConflicts();
  }
  /** Kolumny Użyto / Koszyk / Zostało – odświeżane bez przebudowy tabeli (nie gubi fokusu). */
  function refreshCounts() {
    document.querySelectorAll('#partsTable tr[data-id]').forEach(tr => {
      const p = partById(tr.dataset.id); if (!p) return;
      const u = usedOf(p.id), c = cartQty(p.id), l = remainingOf(p);
      tr.querySelector('[data-c=used]').textContent = u || '—';
      tr.querySelector('[data-c=cart]').textContent = c || '—';
      tr.querySelector('[data-c=left]').innerHTML = l < 0 ? `<b style="color:#b02a1a" title="Ilość jest mniejsza niż liczba sztuk już użytych">${l}</b>` : l === 0 ? '<span class="chip ok">0</span>' : `<b>${l}</b>`;
      tr.querySelector('[data-act=part-tocart]').disabled = l <= 0;
      tr.classList.toggle('done', l <= 0 && c === 0);
    });
    updateTabBadges();
  }
  /** Przyciski paska nieaktywne, gdy nie ma czego zrobić (z podpowiedzią, czego brakuje). */
  function updateToolbar() {
    const set = (act, ok, why) => { const b = document.querySelector(`.toolbar [data-act="${act}"]`); if (!b) return;
      b.disabled = !ok; b.title = ok ? b.dataset.label : `${b.dataset.label} – ${why}`; };
    const cart = project.cart.length > 0;
    set('check', cart, 'koszyk jest pusty');
    set('nest', cart, 'koszyk jest pusty');
    set('commit', !!project.result, 'najpierw uruchom nesting dla koszyka');
    set('pdf', !!project.result || project.nestings.some(n => n.id === reportNestingId), 'brak wyniku nestingu – uruchom nesting albo wybierz zatwierdzony nesting w zakładce Raport');
    set('ident', project.nestings.length > 0, 'brak zatwierdzonych nestingów');
  }
  function updateTabBadges() {
    updateToolbar();
    const inCart = project.cart.reduce((s, c) => s + c.qty, 0);
    $('#tabs [data-tab="cart"]').innerHTML = '2. Koszyk' + (inCart ? ` <span class="cnt">(${inCart} szt.)</span>` : '');
    $('#tabs [data-tab="archive"]').innerHTML = '6. Baza nestingów' + (project.nestings.length ? ` <span class="cnt">(${project.nestings.length})</span>` : '');
    const total = project.parts.reduce((s, p) => s + (Number(p.qty) || 0), 0), used = project.parts.reduce((s, p) => s + usedOf(p.id), 0);
    $('#statusRight').textContent = `Detale: ${used} z ${total} szt. w zatwierdzonych nestingach · w koszyku ${inCart} · Katalog profili: ${dbPath}`;
  }
  /** Przenosi sztuki do koszyka (domyślnie wszystkie pozostałe); zwraca liczbę przeniesionych. */
  function addToCart(id, n) {
    const p = partById(id); if (!p) return 0;
    const left = remainingOf(p);
    n = Math.min(n == null ? left : n, left);
    if (!(n > 0)) return 0;
    const c = project.cart.find(x => x.partId === id);
    if (c) c.qty += n; else project.cart.push({ partId: id, qty: n });
    return n;
  }
  function clampCart(p) {
    const c = project.cart.find(x => x.partId === p.id); if (!c) return;
    c.qty = Math.max(0, Math.min(c.qty, (Number(p.qty) || 0) - usedOf(p.id)));
    if (!c.qty) project.cart = project.cart.filter(x => x !== c);
  }
  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    document.querySelectorAll('#partsTable tr[data-id]').forEach(tr => tr.classList.toggle('sel', tr.dataset.id === id));
    renderEditor();
  }
  function addPart(src) {
    tv.reset('partsWrap');   // nowy wiersz ma być widoczny na końcu listy
    const last = project.parts[project.parts.length - 1];
    const p = Object.assign({
      id: newId(), name: 'Detal ' + (project.parts.length + 1), profile: '', grade: last ? last.grade : 'S355',
      length: 1000, qty: 1, end1: geo.squareEnd(), end2: geo.squareEnd(), fixed: false,
    }, src || {});
    p.id = newId();
    project.parts.push(p); selectedId = p.id;
    changed(false); renderParts();
    return p;
  }
  $('#partsWrap').addEventListener('focusin', e => { const tr = e.target.closest('tr[data-id]'); if (tr) select(tr.dataset.id); });
  $('#partsWrap').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.closest('[data-act="part-tocart"]')) {
      if (addToCart(id)) { changed(true); refreshCounts(); }
      return;
    }
    if (e.target.closest('[data-act="part-del"]')) {
      if (usedOf(id) > 0) { info('Nie można usunąć', 'Ten detal jest już w zatwierdzonych nestingach (baza nestingów), więc musi zostać na liście projektu.'); return; }
      const wasInCart = cartQty(id) > 0;
      project.parts = project.parts.filter(p => p.id !== id);
      project.cart = project.cart.filter(c => c.partId !== id);
      if (selectedId === id) selectedId = project.parts.length ? project.parts[0].id : null;
      changed(wasInCart); renderParts(); return;
    }
    select(id);
  });
  $('#partsWrap').addEventListener('input', e => {
    const tr = e.target.closest('tr[data-id]'), f = e.target.dataset.f; if (!tr || !f) return;
    const p = project.parts.find(x => x.id === tr.dataset.id);
    p[f] = (f === 'length' || f === 'qty') ? Math.max(0, Math.round(num(e.target.value))) : e.target.value.trim();
    if (f === 'profile') { const bad = p.profile && !dimsOf(p).known; e.target.classList.toggle('bad', !!bad); }
    const inCart = cartQty(p.id) > 0;
    if (f === 'qty') clampCart(p);
    changed(inCart);
    if (f === 'qty') refreshCounts();
    if (f === 'profile' || f === 'length' || f === 'name') updatePreview();
    if (f === 'code' || f === 'profile' || f === 'grade') markCodeConflicts();
  });

  // ---------- kod materiału – spójność ----------
  /** Kody użyte w projekcie z różnymi profilami/gatunkami → mapa kod → opis (ostrzeżenie, bez blokady). */
  function codeConflictMap() {
    const list = nesting.codeConflicts([].concat(
      project.parts.map(p => Object.assign({ where: 'detale' }, p)),
      db.bars.map(b => Object.assign({ where: 'sztangi' }, b)),
      db.remnants.map(r => Object.assign({ where: 'odpady' }, r))));
    const m = new Map(); for (const c of list) m.set(c.code, c.text); return m;
  }
  function markCodeConflicts() {
    const m = codeConflictMap();
    const mark = (inp, obj) => {
      const t = obj && m.get(nesting.normCode(obj.code));
      inp.classList.toggle('warn', !!t); inp.title = t || '';
    };
    document.querySelectorAll('#partsTable tr[data-id] input[data-f=code]').forEach(inp => mark(inp, partById(inp.closest('tr').dataset.id)));
    document.querySelectorAll('#tab-stock table[data-kind] input[data-f=code]').forEach(inp => {
      const kind = inp.closest('table').dataset.kind; mark(inp, db[kind][Number(inp.closest('tr').dataset.i)]);
    });
    const n = m.size;
    document.querySelectorAll('.codewarn').forEach(el => { el.classList.toggle('hidden', !n); el.innerHTML = n ? '⚠ ' + Array.from(m.values()).map(esc).join('<br>⚠ ') : ''; });
  }
  /**
   * Podpowiedzi kodów dla pola kodu: tylko kody materiału z magazynu (sztangi i odpady) o tym samym profilu i gatunku
   * co wiersz, w którym jest pole. Wpisać można dowolny kod – lista tylko podpowiada.
   */
  function renderCodeList(inp) {
    const tr = inp && inp.closest('tr');
    const val = f => { const el = tr && tr.querySelector(`input[data-f="${f}"], input[data-edf="${f}"]`); return el ? el.value : ''; };
    const key = tr ? nesting.groupKey(val('profile'), val('grade')) : null;
    const cs = new Map();
    for (const x of [].concat(db.bars, db.remnants)) {
      const c = String(x.code || '').trim(); if (!c) continue;
      if (key && nesting.groupKey(x.profile, x.grade) !== key) continue;
      const k = nesting.normCode(c);
      const e = cs.get(k) || { c, bars: 0, rems: 0 };
      if (db.bars.includes(x)) e.bars += Number(x.qty) || 0; else e.rems++;
      cs.set(k, e);
    }
    $('#codeList').innerHTML = Array.from(cs.values()).sort((a, b) => a.c.localeCompare(b.c))
      .map(e => `<option value="${esc(e.c)}" label="${esc([e.bars ? e.bars + ' szt. sztang' : '', e.rems ? e.rems + ' odp.' : ''].filter(Boolean).join(', '))}">`).join('');
  }
  // lista podpowiedzi budowana przy wejściu w pole kodu – zależy od profilu i gatunku w tym samym wierszu
  document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('input[list="codeList"]')) renderCodeList(e.target); });
  /** Podpowiedzi Nr mag.: partie o profilu i gatunku z wiersza (dla zgłoszenia cięcia – zgodne ze sztangą i ze stanem). */
  function renderLotList(inp) {
    const tr = inp.closest('tr'), d = tr ? tr.dataset : {};
    let list;
    if (d.lotProfile != null) list = db.bars.filter(l => lotFitsBar(l, { profile: d.lotProfile, grade: d.lotGrade, length: Number(d.lotLen), code: d.lotCode, purchase: d.lotKind === 'purchase' }) && Number(l.qty) > 0);
    else {
      const val = f => { const el = tr && tr.querySelector(`input[data-f="${f}"]`); return el ? el.value : ''; };
      const key = nesting.groupKey(val('profile'), val('grade'));
      list = db.bars.filter(l => l.lot && nesting.groupKey(l.profile, l.grade) === key);
    }
    $('#lotList').innerHTML = list.filter(l => l.lot).map(l => `<option value="${esc(l.lot)}" label="${esc(`${l.profile} ${l.grade} · ${fmt(l.length)} mm · stan ${l.qty}${l.heat ? ' · wytop ' + l.heat : ''}`)}">`).join('');
  }
  document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('input[list="lotList"]')) renderLotList(e.target); });

  // ---------- edytor końców ----------
  /** Zdanie o tym, jak wolno ułożyć detal z danego profilu (reguła wynika z symetrii przekroju). */
  function movesHint(d) {
    if (!d.known) return 'Profilu nie ma w katalogu – program zakłada przekrój symetryczny i dopuszcza obrót końcami oraz przewrócenie.';
    switch (d.shape) {
      case 'L': return 'Kątownika nie wolno obracać – detal leży w sztandze tak jak na rysunku. Końce zazębią się tylko wtedy, gdy detal jest równoległobokiem.';
      case 'C': return 'Ceownik wolno przewrócić wyłącznie razem z obrotem końcami – środnik musi zostać po tej samej stronie sztangi.';
      case 'box': case 'O': case 'rod':
        return (d.shape === 'O' || Math.abs(d.h - d.b) < 1e-6)
          ? 'Ten profil wolno obracać końcami, przewracać i obracać o 90°, więc cięcia w obu płaszczyznach mogą się zazębiać.'
          : 'Ten profil wolno obracać końcami i przewracać.';
      default: return 'Ten profil wolno obracać końcami i przewracać.';
    }
  }
  const sideLabels = plane => plane === 'h'
    ? [['top', 'ścięta krawędź górna'], ['bottom', 'ścięta krawędź dolna']]
    : [['top', 'ścięta krawędź tylna (góra rzutu)'], ['bottom', 'ścięta krawędź przednia (dół rzutu)']];
  function endForm(p, n) {
    const e = geo.normalizeEnd(p['end' + n]), sh = dimsOf(p).shape;
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
    const sq = e.type === 'square', needSide = e.type === 'miter' || e.type === 'partial';
    return `<fieldset data-end="${n}"><legend>${n === 1 ? 'Początek detalu (lewy koniec)' : 'Koniec detalu (prawy koniec)'}</legend><div class="form">
      <label>Obróbka</label><select data-e="type">${opt(geo.END_TYPES.map(t => [t.id, t.label]), e.type)}</select>
      ${sq ? '' : `<label>Kąt od cięcia prostego</label><div class="unit"><input data-e="angle" type="number" min="1" max="${geo.MAX_ANGLE}" step="0.5" value="${e.angle}"><span>° (0 = prosto)</span></div>
      <label>Płaszczyzna cięcia</label><select data-e="plane">${opt([['h', geo.planeLabel('h', sh) + ' – widok z boku (wysokość h)'], ['b', geo.planeLabel('b', sh) + ' – widok z góry (szerokość b)']], e.plane)}</select>`}
      ${needSide ? `<label>Strona</label><select data-e="side">${opt(sideLabels(e.plane), e.side)}</select>` : ''}
      ${e.type === 'partial' ? `<label>Wysokość zacięcia</label><div class="unit"><input data-e="depth" type="number" min="1" step="1" value="${e.depth || ''}"><span>mm</span></div>` : ''}
    </div></fieldset>`;
  }
  function renderEditor() {
    const el = $('#partEditor'), p = selected();
    if (!p) { el.innerHTML = '<div class="pane-head"><h2>Obróbka końców</h2></div><div class="empty">Zaznacz detal na liście, aby ustawić obróbkę jego końców.</div>'; return; }
    el.innerHTML = `<div class="edsticky"><div class="pane-head"><h2>Obróbka końców – <span id="edName">${esc(p.name)}</span></h2></div>
      <div class="preview" id="partPreview"></div></div><div class="hint" id="previewHint"></div>
      <div class="presets"><button data-preset="square">Proste końce</button><button data-preset="trapez">Trapez 45°</button><button data-preset="para">Równoległobok 45°</button><button data-preset="swap">Zamień końce</button></div>
      ${endForm(p, 1)}${endForm(p, 2)}
      <fieldset><legend>Ułożenie w nestingu</legend>
        <div class="hint" style="margin-top:0">${esc(movesHint(dimsOf(p)))}</div>
        <label class="check"><input type="checkbox" data-flag="fixed" ${p.fixed ? 'checked' : ''}> detal kierunkowy – nie obracać (znakowanie, obróbki spoza programu)</label>
      </fieldset>`;
    updatePreview();
  }
  function updatePreview() {
    const p = selected(), box = $('#partPreview'); if (!p || !box) return;
    const d = dimsOf(p);
    box.innerHTML = draw.partSvg(p, d, colorOf(p.id), d.shape);
    const name = $('#edName'); if (name) name.textContent = p.name;
    const ends = geo.orientedEnds(p, false, false), dd = { h: geo.planeSize(d, 'h'), b: geo.planeSize(d, 'b') };
    const sb = geo.maxSetback(ends.left, dd) + geo.maxSetback(ends.right, dd);
    let hint = d.known ? `${draw.shapeIcon(d.shape, 16)} Profil ${esc(p.profile)} (${draw.SHAPE_LABEL[d.shape] || ''}): h = ${d.h} mm, b = ${d.b} mm. Długość to wymiar gabarytowy (do skrajnych punktów). Linie ciągłe – krawędzie widoczne, przerywane – ukryte (schematycznie).`
      : '<b style="color:#b02a1a">Profilu nie ma w katalogu</b> – skosy liczone dla wysokości 100 mm. Dodaj profil w zakładce Magazyn.';
    if (sb > 0 && sb >= p.length) hint += ' <b style="color:#b02a1a">Skosy są dłuższe niż detal – sprawdź kąty i długość.</b>';
    hint += `<br>${esc(movesHint(d))}`;
    hint += `<br>Sztuk: <b>${p.qty}</b> · użyto <b>${usedOf(p.id)}</b> · w koszyku <b>${cartQty(p.id)}</b> · zostało <b>${remainingOf(p)}</b>.`;
    $('#previewHint').innerHTML = hint;
  }
  function refreshRowEnds(p) {
    const tr = document.querySelector(`#partsTable tr[data-id="${p.id}"]`); if (!tr) return;
    const sh = dimsOf(p).shape;
    tr.querySelector('[data-end="1"]').innerHTML = endCell(p.end1, sh);
    tr.querySelector('[data-end="2"]').innerHTML = endCell(p.end2, sh);
  }
  $('#partEditor').addEventListener('input', e => {
    const p = selected(); if (!p) return;
    const fs = e.target.closest('fieldset[data-end]'), key = e.target.dataset.e;
    if (fs && key) {
      const k = 'end' + fs.dataset.end;
      const cur = Object.assign(geo.squareEnd(), p[k]);
      cur[key] = (key === 'angle' || key === 'depth') ? num(e.target.value) : e.target.value;
      if (key === 'type' && cur.type !== 'square' && !cur.angle) cur.angle = 45;
      if (key === 'type' && cur.type === 'partial' && !cur.depth) cur.depth = Math.round(geo.planeSize(dimsOf(p), cur.plane) / 2);
      p[k] = cur;
      changed(cartQty(p.id) > 0); refreshRowEnds(p);
      if (e.target.tagName === 'SELECT') renderEditor(); else updatePreview();
    } else if (e.target.dataset.flag) {
      p[e.target.dataset.flag] = e.target.checked; changed(cartQty(p.id) > 0);
    }
  });
  $('#partEditor').addEventListener('click', e => {
    const preset = e.target.dataset.preset, p = selected(); if (!preset || !p) return;
    const m = side => ({ type: 'miter', angle: 45, plane: 'h', side, depth: 0 });
    if (preset === 'square') { p.end1 = geo.squareEnd(); p.end2 = geo.squareEnd(); }
    if (preset === 'trapez') { p.end1 = m('top'); p.end2 = m('top'); }
    if (preset === 'para') { p.end1 = m('top'); p.end2 = m('bottom'); }
    if (preset === 'swap') { [p.end1, p.end2] = [p.end2, p.end1]; }
    changed(cartQty(p.id) > 0); refreshRowEnds(p); renderEditor();
  });

  // ---------- import z Excela ----------
  const IM = window.NEST.importmap;
  let imp = null;   // stan okna importu
  /** kind: 'parts' – detale projektu, 'lots' – przyjęcia magazynowe (partie z Nr mag.). */
  const impFields = () => (imp && imp.kind === 'lots' ? IM.LOT_FIELDS : IM.FIELDS);
  function openImport(kind) {
    imp = { kind: kind === 'lots' ? 'lots' : 'parts', sheets: null, src: '', sheet: 0, headerRow: -1, map: {}, defaultGrade: 'S355', qtyDefault1: true, sum: true, mode: 'add', toCart: false,
      addProfiles: false, show: 'all', over: {}, skip: new Set() };
    $('#importDlg h3').textContent = imp.kind === 'lots' ? 'Import przyjęć magazynowych z Excela' : 'Import detali z Excela';
    $('#importDlg').classList.remove('hidden');
    renderImport();
  }
  function closeImport() { $('#importDlg').classList.add('hidden'); imp = null; }
  function loadSheets(sheets, src) {
    imp.sheets = sheets; imp.src = src;
    // arkusz z największą liczbą rozpoznanych nagłówków
    let best = 0, bestScore = -1;
    sheets.forEach((sh, i) => { const h = IM.detectHeaderRow(sh.rows, impFields()); const sc = h >= 0 ? 10 : 0; if (sc + Math.min(sh.rows.length, 9) / 10 > bestScore) { bestScore = sc + Math.min(sh.rows.length, 9) / 10; best = i; } });
    selectSheet(best);
  }
  function selectSheet(i) {
    imp.sheet = i; imp.over = {}; imp.skip = new Set();
    const rows = imp.sheets[i].rows;
    imp.headerRow = IM.detectHeaderRow(rows, impFields());
    imp.map = IM.autoMap(rows, imp.headerRow, impFields());
    tv.reset('impPrev');
    renderImport();
  }
  async function importFile(file) {
    if (!file) return;
    $('#importBody').innerHTML = `<div class="empty">Wczytuję ${esc(file.name)}…</div>`;
    try { const r = await window.NEST.xlsx.readFile(file); loadSheets(r.sheets, file.name); }
    catch (err) { imp.sheets = null; renderImport(); info('Nie udało się wczytać pliku', esc(err.message)); }
  }
  function importItems() {
    const rows = imp.sheets[imp.sheet].rows;
    const items = IM.buildItems(rows, { headerRow: imp.headerRow, map: imp.map, defaultGrade: imp.defaultGrade, qtyDefault1: imp.qtyDefault1,
      catalogNames: db.profiles.map(p => p.name), overrides: imp.over, skip: imp.skip });
    const out = imp.sum ? IM.aggregate(items) : items.map(it => Object.assign({ rows: [it.row] }, it));
    // kod materiału użyty z innym profilem/gatunkiem niż w arkuszu lub projekcie – ostrzeżenie, bez blokady
    const conf = new Map();
    for (const c of nesting.codeConflicts([].concat(
      out.filter(it => !it.errors.length).map(it => Object.assign({ where: 'arkusz' }, it)),
      project.parts.map(p => Object.assign({ where: 'detale' }, p)),
      db.bars.map(b => Object.assign({ where: 'sztangi' }, b)),
      db.remnants.map(r => Object.assign({ where: 'odpady' }, r))))) conf.set(c.code, c);
    for (const it of out) {
      const c = conf.get(nesting.normCode(it.code));
      if (c) it.warnings = it.warnings.concat(`kod ${c.code} występuje też jako: ${c.variants.filter(v => v !== `${String(it.profile).toUpperCase()} ${String(it.grade).toUpperCase()}`.trim()).join(', ')}`);
    }
    return out;
  }
  /** Profile z importu, których nie ma w katalogu (bez wierszy z błędami). */
  function missingProfiles(items) {
    const out = {};
    for (const it of items) if (!it.errors.length && it.warnings.some(w => /nie ma w katalogu/.test(w))) out[it.profile] = (out[it.profile] || 0) + it.qty;
    return out;
  }
  const angleVal = e => (!e || e.type === 'square' || !e.angle ? '' : String(e.side === 'top' ? e.angle : -e.angle));
  const plural = (n, a, b, c) => (n === 1 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? b : c));
  function renderImport() {
    const body = $('#importBody'), prev = $('#impPrev'), go = $('#impGo');
    if (!imp.sheets) {
      prev.classList.add('hidden'); go.disabled = true; $('#impFoot').textContent = '';
      body.innerHTML = `<div class="imp-src">
        <div class="imp-drop" id="impDrop"><button data-imp="file" class="primary">Wybierz plik Excel (.xlsx) lub CSV…</button>
          <div class="hint">albo przeciągnij plik tutaj. Program sam znajdzie wiersz nagłówka i dopasuje kolumny – w następnym kroku można to poprawić.</div>
          <input type="file" id="impFile" accept=".xlsx,.xlsm,.csv,.txt,.tsv" hidden></div>
        <div class="hint" style="margin:0">…albo wklej komórki skopiowane z Excela (najlepiej razem z wierszem nagłówka):</div>
        <textarea id="impPaste" placeholder="${imp.kind === 'lots' ? 'Nr mag.&#9;Profil&#9;Gatunek&#9;Długość&#9;Ilość&#9;Wytop&#9;Certyfikat&#9;Producent&#9;Data' : 'Poz.&#9;Profil&#9;Gatunek&#9;Długość&#9;Ilość&#9;Kąt 1&#9;Kąt 2'}"></textarea>
        <div><button data-imp="paste">Dalej z wklejonymi danymi</button></div></div>`;
      return;
    }
    const sh = imp.sheets[imp.sheet], rows = sh.rows;
    const width = Math.max(1, ...rows.slice(0, 200).map(r => r.length));
    const head = imp.headerRow >= 0 ? rows[imp.headerRow] || [] : [];
    const sample = c => { for (let r = imp.headerRow + 1; r < Math.min(rows.length, imp.headerRow + 40); r++) { const v = (rows[r] || [])[c]; if (v !== '' && v != null) return String(v); } return ''; };
    const colOpt = c => `${IM.colName(c)}${head[c] !== undefined && String(head[c]).trim() ? ': ' + String(head[c]).trim() : ''}${sample(c) ? ' (np. ' + sample(c).slice(0, 16) + ')' : ''}`;
    const rowLabel = r => `${r + 1}: ${(rows[r] || []).filter(v => String(v).trim()).slice(0, 5).map(v => String(v).slice(0, 14)).join(' | ')}`.slice(0, 90);
    if (imp.kind === 'lots') { renderLotImport({ body, prev, go, sh, rows, width, colOpt, rowLabel }); return; }
    const items = importItems();
    const okItems = items.filter(it => !it.errors.length), errItems = items.filter(it => it.errors.length);
    const warnN = okItems.filter(it => it.warnings.length).length;
    const unknown = missingProfiles(items);
    const plan = IM.planMerge(items, project.parts, imp.mode, usedOf);
    const pcs = okItems.reduce((t, it) => t + it.qty, 0);
    const editedN = Object.keys(imp.over).length;
    const missingReq = IM.FIELDS.filter(f => f.req && f.id !== 'name' && !(imp.map[f.id] >= 0));
    body.innerHTML = `<div class="imp-top">
        <span><b>Źródło:</b> ${esc(imp.src)}</span>
        ${imp.sheets.length > 1 ? `<label>Arkusz <select data-imp-set="sheet">${imp.sheets.map((x, i) => `<option value="${i}" ${i === imp.sheet ? 'selected' : ''}>${esc(x.name)} (${x.rows.length} wierszy)</option>`).join('')}</select></label>` : ''}
        <label>Wiersz nagłówka <select data-imp-set="headerRow"><option value="-1" ${imp.headerRow < 0 ? 'selected' : ''}>brak – dane od pierwszego wiersza</option>
          ${rows.slice(0, 30).map((r, i) => `<option value="${i}" ${i === imp.headerRow ? 'selected' : ''}>${esc(rowLabel(i))}</option>`).join('')}</select></label>
        <button data-imp="back">Inny plik…</button></div>
      <div class="imp-grid">
        <fieldset><legend>Kolumny arkusza</legend><div class="imp-cols">${IM.FIELDS.map(f => `<label class="${f.req && f.id !== 'name' ? 'req' : ''}">${f.label}</label>
          <select data-imp-map="${f.id}"><option value="-1">— nie importuj —</option>${Array.from({ length: width }, (_, c) => `<option value="${c}" ${imp.map[f.id] === c ? 'selected' : ''}>${esc(colOpt(c))}</option>`).join('')}</select>`).join('')}</div>
          <div class="hint" title="Płaszczyzna: „h” / „środnik” albo „b” / „półka” (domyślnie środnik). Inne obróbki końców ustawisz po imporcie w oknie detalu.">Kąty: dodatni = ścięta krawędź górna, ujemny = dolna, 0 lub puste = cięcie proste.</div></fieldset>
        <fieldset><legend>Opcje</legend>
          <div class="imp-map"><label>Domyślny gatunek</label><input type="text" data-imp-set="defaultGrade" list="gradeList" value="${esc(imp.defaultGrade)}">
          <label>Detale już w projekcie</label><select data-imp-set="mode">${IM.MODES.map(m => `<option value="${m.id}" ${m.id === imp.mode ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
          <div class="imp-checks">
          <label class="check"><input type="checkbox" data-imp-set="qtyDefault1" ${imp.qtyDefault1 ? 'checked' : ''}> pusta ilość = 1 szt.</label>
          <label class="check"><input type="checkbox" data-imp-set="sum" ${imp.sum ? 'checked' : ''}> sumuj powtarzające się pozycje</label>
          <label class="check"><input type="checkbox" data-imp-set="addProfiles" ${imp.addProfiles ? 'checked' : ''}> dopisz brakujące profile do katalogu</label>
          <label class="check"><input type="checkbox" data-imp-set="toCart" ${imp.toCart ? 'checked' : ''}> dodaj detale od razu do koszyka</label></div>
        </fieldset></div>
      <div class="imp-sum">
        <span class="chip ok">${okItems.length} detali · ${pcs} szt.</span>
        ${plan.add.length !== okItems.length ? `<span class="chip info">${plan.add.length} nowych · ${plan.update.length} aktualizacji istniejących${plan.skip.length ? ' · ' + plan.skip.length + ' pominiętych' : ''}</span>` : ''}
        ${errItems.length ? `<span class="chip short">${errItems.length} ${plural(errItems.length, 'wiersz', 'wiersze', 'wierszy')} z błędami – nie zostaną zaimportowane</span>` : ''}
        ${warnN ? `<span class="chip tight">${warnN} z ostrzeżeniami</span>` : ''}
        ${editedN ? `<span class="chip info">poprawiono ${editedN} ${plural(editedN, 'wiersz', 'wiersze', 'wierszy')}</span>` : ''}
        ${imp.skip.size ? `<span class="chip info">${imp.skip.size} ${plural(imp.skip.size, 'wiersz pominięty', 'wiersze pominięte', 'wierszy pominiętych')}</span><button data-imp="unskip" class="mini">przywróć</button>` : ''}
        ${editedN || imp.skip.size ? '<button data-imp="reset" class="mini">cofnij wszystkie poprawki</button>' : ''}
        ${Object.keys(unknown).length ? `<span class="hint" style="margin:0">Profile spoza katalogu${imp.addProfiles ? ' – <b>zostaną dopisane do katalogu</b>' : ''}: <b>${esc(Object.keys(unknown).map(k => k + ' (' + unknown[k] + ' szt.)').join(', '))}</b></span>` : ''}
        ${missingReq.length ? `<span class="chip tight" title="Bez tej kolumny wartości trzeba wpisać w podglądzie – pozycje bez nich mają błąd">brak kolumny: ${missingReq.map(f => f.label).join(', ')}</span>` : ''}
        <label style="margin-left:auto">Podgląd <select data-imp-set="show"><option value="all" ${imp.show === 'all' ? 'selected' : ''}>wszystkie</option><option value="err" ${imp.show === 'err' ? 'selected' : ''}>z błędami</option><option value="warn" ${imp.show === 'warn' ? 'selected' : ''}>z ostrzeżeniami</option><option value="edit" ${imp.show === 'edit' ? 'selected' : ''}>poprawione</option></select></label>
      </div>`;
    const shown = items.filter(it => imp.show === 'all' || (imp.show === 'err' ? it.errors.length : imp.show === 'edit' ? it.edited : it.warnings.length && !it.errors.length));
    const LIMIT = 500;
    const warnTxt = x => (imp.addProfiles && /nie ma w katalogu/.test(x) ? x.replace('nie ma w katalogu', 'zostanie dopisany do katalogu') : x);
    const msg = it => it.errors.map(x => `<span class="e">${esc(x)}</span>`).concat(it.warnings.map(x => `<span class="w">${esc(warnTxt(x))}</span>`), it.note ? [`<span class="n">${esc(it.note)}</span>`] : []).join(' · ');
    const inp = (it, f, val, attrs) => `<input data-edf="${f}" data-er="${(it.rows || [it.row]).map(r => r - 1).join(',')}" data-r0="${(it.rows || [it.row])[0] - 1}" value="${esc(val)}" ${attrs || ''}>`;
    prev.classList.remove('hidden');
    prev.innerHTML = shown.length ? `<table class="grid imp-edit"><thead><tr><th class="n">Wiersz</th><th style="width:20%">Nazwa</th><th style="width:12%">Profil</th><th style="width:7%">Gatunek</th><th style="width:8%">Kod mat.</th><th class="n" style="width:8%">Długość</th><th class="n" style="width:6%">Ilość</th><th class="n" style="width:6%" title="Dodatni = ścięta krawędź górna, ujemny = dolna">Kąt pocz.</th><th class="n" style="width:6%">Kąt końca</th><th>Uwagi</th><th></th></tr></thead><tbody>` +
      shown.slice(0, LIMIT).map(it => `<tr class="${it.errors.length ? 'err' : it.warnings.length ? 'warn' : ''}${it.edited ? ' edited' : ''}"><td class="n t">${esc((it.rows || [it.row]).slice(0, 3).join(', '))}${(it.rows || []).length > 3 ? '…' : ''}</td>
        <td>${inp(it, 'name', it.name)}</td><td>${inp(it, 'profile', it.profile, 'list="profileList"')}</td><td>${inp(it, 'grade', it.grade, 'list="gradeList"')}</td><td>${inp(it, 'code', it.code || '', 'list="codeList"')}</td>
        <td>${inp(it, 'length', it.length ? String(it.length).replace('.', ',') : '', 'class="num"')}</td><td>${inp(it, 'qty', it.qty || '', 'class="num"')}</td>
        <td>${inp(it, 'angle1', angleVal(it.end1), 'class="num"')}</td><td>${inp(it, 'angle2', angleVal(it.end2), 'class="num"')}</td>
        <td class="t imp-msg">${msg(it)}</td><td><button class="x" data-imp-del="${(it.rows || [it.row]).map(r => r - 1).join(',')}" title="Pomiń tę pozycję przy imporcie">✕</button></td></tr>`).join('') +
      `</tbody></table>${shown.length > LIMIT ? `<div class="empty">… i ${shown.length - LIMIT} kolejnych pozycji (podgląd pokazuje pierwsze ${LIMIT}; zaimportowane zostaną wszystkie – do poprawek użyj filtra „z błędami”)</div>` : ''}`
      : '<div class="empty">Brak pozycji do pokazania.</div>';
    const n = plan.add.length + plan.update.length;
    go.disabled = !n;   // brak kolumny nie blokuje – wartości wpisane w podglądzie wystarczą (pozycje bez nich mają błąd)
    go.textContent = n ? `Importuj ${n} ${plural(n, 'detal', 'detale', 'detali')}` : 'Importuj';
    $('#impFoot').textContent = `${sh.rows.length} wierszy w arkuszu · pola w podglądzie można poprawiać`;
  }
  /** Przerysowanie po poprawce w podglądzie – z zachowaniem przewinięcia i miejsca, do którego przeszedł kursor. */
  function rerenderImport() {
    setTimeout(() => {
      if (!imp) return;
      const a = document.activeElement, key = a && a.dataset && a.dataset.edf ? [a.dataset.r0, a.dataset.edf] : null;
      const top = $('#impPrev').scrollTop;
      renderImport();
      $('#impPrev').scrollTop = top;
      if (key) { const el = document.querySelector(`#impPrev input[data-r0="${key[0]}"][data-edf="${key[1]}"]`); if (el) { el.focus(); el.select(); } }
    }, 0);
  }
  function doImport() {
    const items = importItems();
    const plan = IM.planMerge(items, project.parts, imp.mode, usedOf);
    const touched = [], notes = [];
    tv.reset('partsWrap');
    for (const it of plan.add) {
      const p = { id: newId(), name: it.name, profile: it.profile, grade: it.grade, code: it.code || '', length: it.length, qty: it.qty, end1: it.end1, end2: it.end2, fixed: false };
      project.parts.push(p); touched.push(p.id);
    }
    let invalidate = false;
    for (const u of plan.update) {
      const p = partById(u.id); if (!p) continue;
      if (cartQty(p.id) > 0) invalidate = true;
      Object.assign(p, u.set); clampCart(p); touched.push(p.id);
      if (u.note) notes.push(`${p.name}: ${u.note}`);
    }
    const errN = items.filter(it => it.errors.length).length, toCart = imp.toCart;
    const added = [];
    if (imp.addProfiles) {
      // do katalogu trafia sama nazwa (typ przekroju odgadnięty z nazwy); wymiary i masę uzupełnia się w katalogu
      const have = new Set(db.profiles.map(p => String(p.name).trim().toUpperCase()));
      for (const name of Object.keys(missingProfiles(items))) {
        if (!name || have.has(name.toUpperCase())) continue;
        db.profiles.push({ name, type: '', shape: catalog.guessShape(name), h: '', b: '', kgm: '' });
        have.add(name.toUpperCase()); added.push(name);
      }
      if (added.length) { saveDbSoon(); renderLists(); renderStock(); }
    }
    closeImport();
    if (toCart) { for (const id of touched) addToCart(id); invalidate = true; }
    if (plan.add.length) selectedId = plan.add.length ? project.parts[project.parts.length - plan.add.length].id : selectedId;
    changed(invalidate);
    renderParts(); renderCart();
    info('Import zakończony', `<ul><li>nowych detali: <b>${plan.add.length}</b></li><li>zaktualizowanych: <b>${plan.update.length}</b></li>
      ${plan.skip.length ? `<li>pominiętych (już w projekcie): <b>${plan.skip.length}</b></li>` : ''}
      ${errN ? `<li style="color:#b02a1a">wierszy z błędami, niezaimportowanych: <b>${errN}</b></li>` : ''}
      ${toCart ? '<li>zaimportowane detale dodano do koszyka</li>' : ''}
      ${added.length ? `<li>dopisano do katalogu profili: <b>${esc(added.join(', '))}</b> – uzupełnij ich wymiary i masę w zakładce „3. Magazyn” (podświetlone na żółto)</li>` : ''}</ul>
      ${notes.length ? '<div class="hint">' + notes.slice(0, 12).map(esc).join('<br>') + (notes.length > 12 ? `<br>… i ${notes.length - 12} kolejnych` : '') + '</div>' : ''}`);
  }
  // ---------- import przyjęć magazynowych ----------
  function lotImportItems() {
    return IM.aggregateLots(IM.buildLotItems(imp.sheets[imp.sheet].rows, { headerRow: imp.headerRow, map: imp.map, defaultGrade: imp.defaultGrade,
      catalogNames: db.profiles.map(p => p.name), overrides: imp.over, skip: imp.skip }));
  }
  function renderLotImport({ body, prev, go, sh, rows, width, colOpt, rowLabel }) {
    const items = lotImportItems(), plan = IM.planLots(items, db.bars);
    const st = new Map();
    plan.add.forEach(it => st.set(it, { k: 'new' }));
    plan.same.forEach(x => st.set(x.item, { k: 'same' }));
    plan.diff.forEach(x => st.set(x.item, { k: 'diff', changes: x.changes }));
    const errItems = items.filter(it => it.errors.length), unknown = missingProfiles(items);
    const pcs = plan.add.reduce((t, it) => t + it.qty, 0), editedN = Object.keys(imp.over).length;
    const missingReq = IM.LOT_FIELDS.filter(f => f.req && !(imp.map[f.id] >= 0));
    body.innerHTML = `<div class="imp-top">
        <span><b>Źródło:</b> ${esc(imp.src)}</span>
        ${imp.sheets.length > 1 ? `<label>Arkusz <select data-imp-set="sheet">${imp.sheets.map((x, i) => `<option value="${i}" ${i === imp.sheet ? 'selected' : ''}>${esc(x.name)} (${x.rows.length} wierszy)</option>`).join('')}</select></label>` : ''}
        <label>Wiersz nagłówka <select data-imp-set="headerRow"><option value="-1" ${imp.headerRow < 0 ? 'selected' : ''}>brak – dane od pierwszego wiersza</option>
          ${rows.slice(0, 30).map((r, i) => `<option value="${i}" ${i === imp.headerRow ? 'selected' : ''}>${esc(rowLabel(i))}</option>`).join('')}</select></label>
        <button data-imp="back">Inny plik…</button></div>
      <div class="imp-grid">
        <fieldset><legend>Kolumny arkusza</legend><div class="imp-cols">${IM.LOT_FIELDS.map(f => `<label class="${f.req ? 'req' : ''}">${f.label}</label>
          <select data-imp-map="${f.id}"><option value="-1">— nie importuj —</option>${Array.from({ length: width }, (_, c) => `<option value="${c}" ${imp.map[f.id] === c ? 'selected' : ''}>${esc(colOpt(c))}</option>`).join('')}</select>`).join('')}</div>
          <div class="hint">Ten sam Nr mag. w kilku wierszach o tych samych cechach = sztangi jednej dostawy (ilości są sumowane).</div></fieldset>
        <fieldset><legend>Opcje</legend>
          <div class="imp-map"><label>Domyślny gatunek</label><input type="text" data-imp-set="defaultGrade" list="gradeList" value="${esc(imp.defaultGrade)}"></div>
          <div class="imp-checks"><label class="check"><input type="checkbox" data-imp-set="addProfiles" ${imp.addProfiles ? 'checked' : ''}> dopisz brakujące profile do katalogu</label></div>
          <div class="hint">Partie, które już są w magazynie z tymi samymi danymi, są pomijane – listę przyjęć można importować wielokrotnie. Przy różnicach program zapyta o każdą partię.</div>
        </fieldset></div>
      <div class="imp-sum">
        <span class="chip ok">${plan.add.length} ${plural(plan.add.length, 'nowa partia', 'nowe partie', 'nowych partii')} · ${pcs} szt.</span>
        ${plan.same.length ? `<span class="chip info">${plan.same.length} już w magazynie – bez zmian (pominięte)</span>` : ''}
        ${plan.diff.length ? `<span class="chip tight">${plan.diff.length} ${plural(plan.diff.length, 'partia różni się', 'partie różnią się', 'partii różni się')} od magazynu – zapytam przy imporcie</span>` : ''}
        ${errItems.length ? `<span class="chip short">${errItems.length} ${plural(errItems.length, 'pozycja', 'pozycje', 'pozycji')} z błędami – nie zostaną zaimportowane</span>` : ''}
        ${editedN ? `<span class="chip info">poprawiono ${editedN} ${plural(editedN, 'wiersz', 'wiersze', 'wierszy')}</span>` : ''}
        ${imp.skip.size ? `<span class="chip info">${imp.skip.size} ${plural(imp.skip.size, 'wiersz pominięty', 'wiersze pominięte', 'wierszy pominiętych')}</span><button data-imp="unskip" class="mini">przywróć</button>` : ''}
        ${editedN || imp.skip.size ? '<button data-imp="reset" class="mini">cofnij wszystkie poprawki</button>' : ''}
        ${Object.keys(unknown).length ? `<span class="hint" style="margin:0">Profile spoza katalogu${imp.addProfiles ? ' – <b>zostaną dopisane do katalogu</b>' : ''}: <b>${esc(Object.keys(unknown).join(', '))}</b></span>` : ''}
        ${missingReq.length ? `<span class="chip tight" title="Bez tej kolumny wartości trzeba wpisać w podglądzie – pozycje bez nich mają błąd">brak kolumny: ${missingReq.map(f => f.label).join(', ')}</span>` : ''}
        <label style="margin-left:auto">Podgląd <select data-imp-set="show">${[['all', 'wszystkie'], ['new', 'nowe'], ['diff', 'różniące się'], ['same', 'bez zmian'], ['err', 'z błędami']].map(([v, l]) => `<option value="${v}" ${imp.show === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>`;
    const kindOf = it => (it.errors.length ? 'err' : (st.get(it) || {}).k);
    const shown = items.filter(it => imp.show === 'all' || imp.show === kindOf(it));
    const status = it => {
      const k = kindOf(it), x = st.get(it) || {};
      const msgs = it.errors.map(m => `<span class="e">${esc(m)}</span>`).concat(it.warnings.map(m => `<span class="w">${esc(m)}</span>`), it.note ? [`<span class="n">${esc(it.note)}</span>`] : [],
        it.summed ? [`<span class="n">zsumowano ${it.summed} wiersze</span>`] : []);
      const head = k === 'new' ? '<span class="chip ok">nowa</span>' : k === 'same' ? '<span class="chip info">bez zmian</span>'
        : k === 'diff' ? `<span class="chip tight">różni się</span> ${x.changes.map(c => `${esc(c.label)}: <s>${esc(String(c.old) || '—')}</s> → <b>${esc(String(c.val) || '—')}</b>`).join('; ')}` : '';
      return [head].concat(msgs).filter(Boolean).join(' · ');
    };
    const inp = (it, f, val, attrs) => `<input data-edf="${f}" data-er="${(it.rows || [it.row]).map(r => r - 1).join(',')}" data-r0="${(it.rows || [it.row])[0] - 1}" value="${esc(val == null ? '' : val)}" ${attrs || ''}>`;
    const LIMIT = 500;
    prev.classList.remove('hidden');
    prev.innerHTML = shown.length ? `<table class="grid imp-edit"><thead><tr><th class="n">Wiersz</th><th style="width:9%">Nr mag.</th><th style="width:9%">Profil</th><th style="width:6%">Gatunek</th><th style="width:6%">Kod mat.</th><th class="n" style="width:6%">Długość</th><th class="n" style="width:4%">Ilość</th><th style="width:7%">Wytop</th><th style="width:7%">Certyfikat</th><th style="width:7%">Producent</th><th style="width:9%">Data</th><th style="width:6%">Lokalizacja</th><th>Status / uwagi</th><th></th></tr></thead><tbody>` +
      shown.slice(0, LIMIT).map(it => `<tr class="${it.errors.length ? 'err' : kindOf(it) === 'diff' ? 'warn' : kindOf(it) === 'same' ? 'done' : ''}${it.edited ? ' edited' : ''}"><td class="n t">${esc((it.rows || [it.row]).slice(0, 3).join(', '))}${(it.rows || []).length > 3 ? '…' : ''}</td>
        <td>${inp(it, 'lot', it.lot)}</td><td>${inp(it, 'profile', it.profile, 'list="profileList"')}</td><td>${inp(it, 'grade', it.grade, 'list="gradeList"')}</td><td>${inp(it, 'code', it.code)}</td>
        <td>${inp(it, 'length', it.length || '', 'class="num"')}</td><td>${inp(it, 'qty', it.qty || '', 'class="num"')}</td>
        <td>${inp(it, 'heat', it.heat)}</td><td>${inp(it, 'cert', it.cert)}</td><td>${inp(it, 'maker', it.maker)}</td><td>${inp(it, 'date', it.date)}</td><td>${inp(it, 'location', it.location)}</td>
        <td class="t imp-msg">${status(it)}</td><td><button class="x" data-imp-del="${(it.rows || [it.row]).map(r => r - 1).join(',')}" title="Pomiń tę pozycję przy imporcie">✕</button></td></tr>`).join('') +
      `</tbody></table>${shown.length > LIMIT ? `<div class="empty">… i ${shown.length - LIMIT} kolejnych pozycji</div>` : ''}`
      : '<div class="empty">Brak pozycji do pokazania.</div>';
    const n = plan.add.length + plan.diff.length;
    go.disabled = !n;   // brak kolumny nie blokuje – wartości wpisane w podglądzie wystarczą (pozycje bez nich mają błąd)
    const chk = plan.diff.length ? `sprawdź ${plan.diff.length} ${plural(plan.diff.length, 'zmianę', 'zmiany', 'zmian')}` : '';
    go.textContent = !n ? 'Nic nowego do importu' : plan.add.length
      ? `Importuj ${plan.add.length} ${plural(plan.add.length, 'nową partię', 'nowe partie', 'nowych partii')}${chk ? ' i ' + chk : ''}` : chk.charAt(0).toUpperCase() + chk.slice(1);
    $('#impFoot').textContent = `${sh.rows.length} wierszy w arkuszu · pola w podglądzie można poprawiać`;
  }
  /** Okno decyzji dla partii, która różni się od magazynu. */
  function askLotChange(d, left) {
    const why = lotInUse(d.lot);
    const risky = why && d.changes.some(c => ['profile', 'grade', 'code', 'length'].includes(c.f));
    return modal(`Partia ${d.lot.lot} różni się od listy przyjęć`, `
      <p>Nr mag. <b>${esc(d.lot.lot)}</b> jest już w magazynie (${esc(d.lot.profile)} ${esc(d.lot.grade)}, ${fmt(d.lot.length)} mm). Arkusz (wiersz ${esc((d.item.rows || [d.item.row]).join(', '))}) podaje inne dane:</p>
      <table class="grid"><thead><tr><th>Pole</th><th>W magazynie</th><th>W arkuszu</th></tr></thead><tbody>${d.changes.map(c => `<tr><td class="t">${esc(c.label)}</td><td class="t">${esc(String(c.old) || '—')}</td><td class="t"><b>${esc(String(c.val) || '—')}</b></td></tr>`).join('')}</tbody></table>
      ${d.changes.some(c => c.f === 'qtyIn') ? '<p class="hint">Zmiana ilości przyjętej zmienia Stan o różnicę (nie poniżej sztuk już wydanych).</p>' : ''}
      ${risky ? `<p class="warnbox">⚠ Partia ma już historię (${esc(why)}) – zmiana profilu, gatunku, kodu lub długości wpłynie na zgłoszone cięcia i raport identyfikacji.</p>` : ''}
      ${left ? `<p class="hint">Pozostało jeszcze ${left} ${plural(left, 'partia', 'partie', 'partii')} z różnicami.</p>` : ''}`,
      [{ label: 'Pomiń', value: 'skip' }].concat(left ? [{ label: 'Pomiń wszystkie pozostałe', value: 'skipAll' }, { label: 'Aktualizuj wszystkie pozostałe', value: 'updAll' }] : [])
        .concat([{ label: 'Aktualizuj', value: 'upd', primary: true }]));
  }
  async function doLotImport() {
    const items = lotImportItems(), plan = IM.planLots(items, db.bars);
    const errN = items.filter(it => it.errors.length).length, addProfiles = imp.addProfiles;
    closeImport();
    tv.reset('barsWrap');
    for (const it of plan.add) {
      db.bars.push({ id: catalog.newBarId(db), lot: it.lot, profile: it.profile, grade: it.grade, code: it.code, length: it.length, qtyIn: it.qty, qty: it.qty,
        heat: it.heat, cert: it.cert, maker: it.maker, date: it.date || new Date().toLocaleDateString('sv-SE'), location: it.location });
    }
    let upd = 0, skip = 0, all = null; const notes = [];
    for (let i = 0; i < plan.diff.length; i++) {
      const d = plan.diff[i];
      const v = all || await askLotChange(d, plan.diff.length - i - 1);
      if (v === 'skipAll' || v === 'updAll') all = v;
      if (v === 'upd' || v === 'updAll') { notes.push(...IM.applyLotChanges(d.lot, d.changes).map(n => `${d.lot.lot}: ${n}`)); upd++; } else skip++;
    }
    const added = [];
    if (addProfiles) {
      const have = new Set(db.profiles.map(p => String(p.name).trim().toUpperCase()));
      for (const name of Object.keys(missingProfiles(items))) {
        if (!name || have.has(name.toUpperCase())) continue;
        db.profiles.push({ name, type: '', shape: catalog.guessShape(name), h: '', b: '', kgm: '' });
        have.add(name.toUpperCase()); added.push(name);
      }
      if (added.length) { saveDbSoon(); renderLists(); }
    }
    if (plan.add.length || upd) changed(true);
    showStockSub('bars'); renderStock();
    info('Import przyjęć zakończony', `<ul><li>nowych partii: <b>${plan.add.length}</b> (${plan.add.reduce((t, it) => t + it.qty, 0)} szt.)</li>
      <li>już w magazynie bez zmian (pominięte): <b>${plan.same.length}</b></li>
      ${plan.diff.length ? `<li>partie z różnicami: zaktualizowane <b>${upd}</b>, pominięte <b>${skip}</b></li>` : ''}
      ${errN ? `<li style="color:#b02a1a">pozycji z błędami, niezaimportowanych: <b>${errN}</b></li>` : ''}
      ${added.length ? `<li>dopisano do katalogu profili: <b>${esc(added.join(', '))}</b> – uzupełnij wymiary i masę</li>` : ''}</ul>
      ${notes.length ? '<div class="hint">' + notes.map(esc).join('<br>') + '</div>' : ''}`);
  }
  $('#importDlg').addEventListener('click', e => {
    if (!imp) return;
    const del = e.target.closest('[data-imp-del]');
    if (del) { for (const r of del.dataset.impDel.split(',')) imp.skip.add(Number(r)); rerenderImport(); return; }
    const a = e.target.closest('[data-imp]'); if (!a) return;
    const act = a.dataset.imp;
    if (act === 'cancel') closeImport();
    if (act === 'file') $('#impFile').click();
    if (act === 'back') { imp.sheets = null; renderImport(); }
    if (act === 'go') { if (imp.kind === 'lots') doLotImport(); else doImport(); }
    if (act === 'unskip') { imp.skip.clear(); renderImport(); }
    if (act === 'reset') { imp.over = {}; imp.skip.clear(); renderImport(); }
    if (act === 'paste') {
      const rows = IM.parseDelimited($('#impPaste').value);
      if (!rows.length) { info('Brak danych', 'Wklej komórki skopiowane z Excela.'); return; }
      loadSheets([{ name: 'wklejone dane', rows }], 'wklejone dane');
    }
  });
  $('#importDlg').addEventListener('change', e => {
    if (!imp) return;
    if (e.target.id === 'impFile') { importFile(e.target.files[0]); return; }
    if (e.target.dataset.edf) {
      // poprawka zapisywana dla wierszy arkusza tej pozycji; ilość pozycji zsumowanej trafia do pierwszego wiersza
      const f = e.target.dataset.edf, rs = e.target.dataset.er.split(',').map(Number), v = e.target.value;
      const set = (r, val) => { (imp.over[r] = imp.over[r] || {})[f] = val; };
      if (f === 'qty') { set(rs[0], v); rs.slice(1).forEach(r => imp.skip.add(r)); } else rs.forEach(r => set(r, v));
      rerenderImport();
      return;
    }
    const k = e.target.dataset.impSet, f = e.target.dataset.impMap;
    if (f) { imp.map[f] = Number(e.target.value); renderImport(); return; }
    if (!k) return;
    if (k === 'sheet') { selectSheet(Number(e.target.value)); return; }
    if (k === 'headerRow') { imp.headerRow = Number(e.target.value); imp.map = IM.autoMap(imp.sheets[imp.sheet].rows, imp.headerRow, impFields()); renderImport(); return; }
    imp[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    renderImport();
  });
  $('#importDlg').addEventListener('dragover', e => { if (imp && !imp.sheets) { e.preventDefault(); const d = $('#impDrop'); if (d) d.classList.add('over'); } });
  $('#importDlg').addEventListener('dragleave', () => { const d = $('#impDrop'); if (d) d.classList.remove('over'); });
  $('#importDlg').addEventListener('drop', e => { if (!imp || imp.sheets) return; e.preventDefault(); importFile(e.dataTransfer.files[0]); });

  // ---------- dostępność materiału ----------
  /** Pule materiału (partie o tych samych cechach) z odjętymi rezerwacjami zatwierdzonych, niezgłoszonych nestingów. */
  const stockPools = () => catalog.pools(db.bars, project.nestings);
  const poolBars = () => stockPools().filter(p => p.qty > 0)
    .map(p => ({ id: p.id, profile: p.profile, grade: p.grade, code: p.code, length: p.length, qty: p.qty, location: p.location }));
  const nestInput = () => ({ parts: cartParts(), profiles: catalog.profileMap(db), bars: poolBars(), remnants: db.remnants, options: project.options });
  function validParts() {
    const parts = cartParts();
    if (!parts.length) { info('Koszyk jest pusty', 'Przenieś detale do koszyka w zakładce „1. Detale” (przycisk „→ koszyk”).'); return false; }
    const bad = parts.filter(p => !p.profile || !(p.length > 0));
    if (bad.length) { info('Niepełne dane', `Uzupełnij profil i długość w detalach: <b>${bad.map(p => esc(p.name || '?')).join(', ')}</b>.`); return false; }
    return true;
  }

  // ---------- koszyk ----------
  function renderCart() {
    project.cart = project.cart.filter(c => partById(c.partId) && c.qty > 0);
    const wrap = $('#cartWrap');
    if (!project.cart.length) {
      wrap.innerHTML = '<div class="empty">Koszyk jest pusty. W zakładce „1. Detale” kliknij „→ koszyk” przy detalu albo „Wszystkie pozostałe → koszyk”.</div>';
    } else {
      wrap.innerHTML = `<table class="grid" id="cartTable"><thead><tr><th class="n">Lp.</th><th>Nazwa</th><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Długość [mm]</th><th>Początek</th><th>Koniec</th>
        <th class="n" style="width:110px">W koszyku [szt.]</th><th class="n" title="Ilość w projekcie minus sztuki z zatwierdzonych nestingów">Dostępne</th><th class="n">Razem [m]</th><th></th></tr></thead><tbody>` +
        project.cart.map((c, i) => { const p = partById(c.partId); const max = p.qty - usedOf(p.id); return `<tr data-id="${p.id}">
          <td class="n t"><span class="sw" style="background:${colorOf(p.id)}"></span> ${i + 1}</td><td class="t"><b>${esc(p.name)}</b></td><td class="t">${esc(p.profile)}</td><td class="t">${esc(p.grade)}</td><td class="t">${esc(p.code || '')}</td><td class="n t">${fmt(p.length)}</td>
          <td class="t">${esc(geo.describeEnd(p.end1, dimsOf(p).shape))}</td><td class="t">${esc(geo.describeEnd(p.end2, dimsOf(p).shape))}</td>
          <td><input type="number" data-cart="qty" min="1" max="${max}" step="1" value="${c.qty}"></td><td class="n t">${max}</td><td class="n t" data-c="len">${m1(c.qty * p.length)}</td>
          <td><button class="x" data-cart="del" title="Usuń z koszyka (detal zostaje w projekcie)">✕</button></td></tr>`; }).join('') + '</tbody></table>';
    }
    renderAvailability(); updateTabBadges();
  }
  $('#cartWrap').addEventListener('input', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr || e.target.dataset.cart !== 'qty') return;
    const p = partById(tr.dataset.id), c = project.cart.find(x => x.partId === p.id);
    c.qty = Math.max(0, Math.min(Math.round(num(e.target.value)), p.qty - usedOf(p.id)));
    tr.querySelector('[data-c=len]').textContent = m1(c.qty * p.length);
    changed(true); updateTabBadges();
  });
  $('#cartWrap').addEventListener('change', () => renderCart());
  $('#cartWrap').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr || !e.target.closest('[data-cart="del"]')) return;
    project.cart = project.cart.filter(c => c.partId !== tr.dataset.id);
    if (!project.cart.length) project.revisionOf = null;
    changed(true); renderCart();
  });

  async function checkMaterial() {
    if (!validParts()) return;
    await loadDb();
    availability = nesting.checkAvailability(nestInput());
    showTab('cart');
  }
  function renderAvailability() {
    const el = $('#availability');
    if (!availability) { el.innerHTML = '<div class="empty">Kliknij „Sprawdź materiał w bazie”, aby porównać potrzebny materiał ze stanem magazynu i odpadów użytkowych.</div>'; return; }
    const lab = { ok: 'dostępny', tight: 'na styk', short: 'za mało', none: 'brak' };
    el.innerHTML = `<table class="grid"><thead><tr><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Detali</th><th class="n">Potrzeba [m]</th><th class="n">Sztangi w magazynie</th><th class="n">Odpady użytkowe</th><th class="n">Razem dostępne [m]</th><th>Stan</th><th>Uwagi</th></tr></thead><tbody>` +
      availability.map(a => `<tr><td class="t"><b>${esc(a.profile)}</b></td><td class="t">${esc(a.grade)}</td><td class="t">${a.code ? esc(a.code) : '<span class="muted">bez kodu</span>'}</td><td class="n t">${a.count}</td><td class="n t">${m1(a.required)}</td>
        <td class="n t">${a.stockCount} szt. / ${m1(a.stockLen)} m</td><td class="n t">${a.remCount} szt. / ${m1(a.remLen)} m</td><td class="n t">${m1(a.avail)}</td>
        <td class="t"><span class="chip ${a.status}">${lab[a.status]}</span></td><td class="t">${esc(a.note)}${a.known ? '' : ' · profil spoza katalogu'}</td></tr>`).join('') + '</tbody></table>';
  }

  // ---------- magazyn ----------
  function gridTable(cols, rows, kind, rowClass) {
    if (!rows.length) return '<div class="empty">Brak pozycji.</div>';
    return `<table class="grid" data-kind="${kind}"><thead><tr>${cols.map(c => `<th class="${c.num ? 'n' : ''}" style="${c.w ? 'width:' + c.w : ''}">${c.label}</th>`).join('')}<th></th></tr></thead><tbody>` +
      rows.map(({ row, i }) => `<tr data-i="${i}" class="${rowClass ? rowClass(row) : ''}">${cols.map(c => c.cell ? c.cell(row)
        : c.icon
        ? `<td class="t"><button class="shape" data-shape="1" title="${draw.SHAPE_LABEL[row[c.f]] || ''} – kliknij, aby zmienić typ">${draw.shapeIcon(row[c.f])}</button></td>`
        : c.ro
        ? `<td class="t ${c.num ? 'n' : ''}">${esc(c.fmt ? c.fmt(row) : (row[c.f] == null ? '' : row[c.f]))}</td>`
        : `<td><input data-f="${c.f}" ${c.num ? 'type="number" step="any" min="0"' : ''} ${c.list ? `list="${c.list}"` : ''} ${c.ph ? `placeholder="${c.ph}"` : ''} value="${esc(row[c.f] == null ? '' : row[c.f])}"></td>`).join('')}
        <td><button class="x" data-act="row-del" title="Usuń">✕</button></td></tr>`).join('') + '</tbody></table>';
  }
  const COLS = {
    bars: [{ f: 'lot', label: 'Nr mag.', w: '9%', ph: 'uzupełnij' }, { f: 'profile', label: 'Profil', list: 'profileList', w: '9%' }, { f: 'grade', label: 'Gatunek', list: 'gradeList', w: '6%' },
      { f: 'code', label: 'Kod mat.', w: '7%', list: 'codeList', ph: '—' }, { f: 'length', label: 'Długość [mm]', num: 1, w: '7%' },
      { f: 'qtyIn', label: 'Przyjęto', num: 1, w: '5%' }, { f: 'qty', label: 'Stan', num: 1, w: '5%' },
      { f: '_rem', label: 'Odpady z partii', ro: 1, fmt: r => remnantsOfLot(r) },
      { f: 'heat', label: 'Wytop (Heat No.)', w: '9%' }, { f: 'cert', label: 'Nr certyfikatu', w: '9%' }, { f: 'maker', label: 'Producent', w: '9%' },
      { f: 'date', label: 'Data przyjęcia', w: '7%', ph: 'rrrr-mm-dd' }, { f: 'location', label: 'Lokalizacja', w: '8%' }],
    remnants: [{ f: 'id', label: 'Nr', ro: 1 }, { f: 'lotNo', label: 'Nr mag.', cell: r => remnantLotCell(r) }, { f: 'profile', label: 'Profil', list: 'profileList' }, { f: 'grade', label: 'Gatunek', list: 'gradeList', w: '10%' }, { f: 'code', label: 'Kod mat.', w: '10%', list: 'codeList', ph: '—' }, { f: 'length', label: 'Długość [mm]', num: 1, w: '11%' },
      { f: 'end1', label: 'Początek', ro: 1, fmt: r => geo.describeEnd(r.end1, dimsOf(r).shape) }, { f: 'end2', label: 'Koniec', ro: 1, fmt: r => geo.describeEnd(r.end2, dimsOf(r).shape) },
      { f: 'location', label: 'Lokalizacja', w: '12%' }, { f: 'source', label: 'Pochodzenie', w: '13%' }, { f: 'date', label: 'Data', ro: 1 }],
    profiles: [{ f: 'shape', label: 'Typ', icon: 1 }, { f: 'name', label: 'Nazwa' }, { f: 'h', label: 'h [mm]', num: 1, w: '20%', ph: 'uzupełnij' }, { f: 'b', label: 'b [mm]', num: 1, w: '20%', ph: 'uzupełnij' }, { f: 'kgm', label: 'kg/m', num: 1, w: '20%', ph: 'uzupełnij' }],
  };
  // ---------- partie (Nr mag.) ----------
  const resolver = () => catalog.lotResolver(project.stock, project.nestings);
  /** Profil grupy, w której leży sztanga (numery sztang liczone są w obrębie profilu). */
  const barGroupOf = (n, b) => { const g = n.result.groups.find(x => x.bars.includes(b)); return g ? g.profile : ''; };
  const lotLabel = id => { const l = id && db.bars.find(x => x.id === id); return l ? (l.lot || '(partia bez numeru)') : ''; };
  const lotDup = r => !!String(r.lot || '').trim() && db.bars.some(x => x !== r && String(x.lot || '').trim().toUpperCase() === String(r.lot).trim().toUpperCase());
  /** Odpady w magazynie pochodzące z partii: „2 szt. / 3,40 m”. */
  function remnantsOfLot(lot) {
    const R = resolver(), list = db.remnants.filter(r => R.remnantLotId(r.id, r) === lot.id);
    return list.length ? `${list.length} szt. / ${m1(list.reduce((t, r) => t + Number(r.length || 0), 0))} m` : '—';
  }
  /** Komórka Nr mag. odpadu: dziedziczony z partii sztangi albo wpisany ręcznie (odpady spoza nestingu). */
  function remnantLotCell(r) {
    const R = resolver();
    if (r.lotId) return `<td><input data-f="lotNo" list="lotList" value="${esc(lotLabel(r.lotId))}" title="Wpisany ręcznie"></td>`;
    const id = R.remnantLotId(r.id, r);
    if (id) return `<td class="t" title="Dziedziczony po sztandze, z której powstał odpad">${esc(lotLabel(id))}</td>`;
    const o = R.origin(r.id);
    if (o) return `<td class="t muted" title="Nr mag. pojawi się po zgłoszeniu cięcia sztangi, z której powstał odpad">czeka: ${esc(o.n.no)} ${esc(barGroupOf(o.n, o.b))} #${o.b.no}</td>`;
    return `<td><input data-f="lotNo" list="lotList" placeholder="—" value=""></td>`;
  }
  function renderPoolInfo() {
    const res = stockPools().filter(p => p.reserved > 0);
    $('#poolInfo').innerHTML = res.length ? '<b>Zarezerwowane w zatwierdzonych nestingach (cięcie niezgłoszone):</b> ' +
      res.map(p => `${esc(p.profile)} ${esc(p.grade)}${p.code ? ' · ' + esc(p.code) : ''} · ${fmt(p.length)} mm – <b>${p.reserved}</b> szt. (stan ${p.stock}, wolne ${p.qty < 0 ? `<b style="color:#b02a1a">${p.qty}</b>` : p.qty})`).join('; ') : '';
    $('#poolInfo').classList.toggle('hidden', !res.length);
  }
  /** Okno przyjęcia dostawy: nowa partia z numerem magazynowym nadanym przez magazyn. */
  async function receiveLot(prev, err) {
    const v = Object.assign({ lot: '', profile: '', grade: 'S355', code: '', length: 12000, qty: 1, heat: '', cert: '', maker: '', date: new Date().toLocaleDateString('sv-SE'), location: '' }, prev || {});
    const fld = (k, label, attrs) => `<label>${label}</label><input data-rcv="${k}" value="${esc(v[k])}" ${attrs || ''}>`;
    const ok = await modal('Przyjęcie materiału', `${err ? `<div class="warnbox">⚠ ${err}</div>` : ''}
      <div class="form rcv">${fld('lot', 'Nr mag. (Code no.) *', 'placeholder="nadany przez magazyn"')}${fld('profile', 'Profil *', 'list="profileList"')}${fld('grade', 'Gatunek', 'list="gradeList"')}
      ${fld('code', 'Kod mat. (article no)', 'placeholder="—"')}${fld('length', 'Długość [mm] *', 'type="number" min="1" step="1"')}${fld('qty', 'Ilość sztang *', 'type="number" min="1" step="1"')}
      ${fld('heat', 'Wytop (Heat No.)')}${fld('cert', 'Nr certyfikatu')}${fld('maker', 'Producent')}${fld('date', 'Data przyjęcia', 'placeholder="rrrr-mm-dd"')}${fld('location', 'Lokalizacja')}</div>
      <div class="hint">Jeden Nr mag. = jedna dostawa sztang o tym samym profilu, gatunku, producencie, certyfikacie, wytopie i długości.</div>`,
      [{ label: 'Anuluj', value: false }, { label: 'Przyjmij', value: true, primary: true }]);
    document.querySelectorAll('#modalBody [data-rcv]').forEach(i => { v[i.dataset.rcv] = i.value.trim(); });
    if (!ok) return;
    v.length = Math.round(num(v.length)); v.qty = Math.round(num(v.qty));
    const errs = [];
    if (!v.lot) errs.push('podaj Nr mag.');
    else if (catalog.lotByNo(db.bars, v.lot)) errs.push(`Nr mag. „${esc(v.lot)}” już jest w magazynie projektu – nowa dostawa dostaje nowy numer`);
    if (!v.profile) errs.push('podaj profil');
    if (!(v.length > 0)) errs.push('podaj długość');
    if (!(v.qty > 0)) errs.push('podaj ilość sztang');
    if (errs.length) return receiveLot(v, errs.join('; ') + '.');
    tv.reset('barsWrap');
    db.bars.push({ id: catalog.newBarId(db), lot: v.lot, profile: v.profile, grade: v.grade, code: v.code, length: v.length, qtyIn: v.qty, qty: v.qty,
      heat: v.heat, cert: v.cert, maker: v.maker, date: v.date, location: v.location });
    changed(true); showStockSub('bars'); renderStock(); renderLists();
  }
  /** Partia ma historię (zgłoszenia cięcia, odpady, wydane sztuki) – nie wolno jej usunąć. */
  function lotInUse(lot) {
    if (Number(lot.qty) !== Number(lot.qtyIn)) return 'stan różni się od ilości przyjętej (sztangi wydano)';
    for (const n of project.nestings) for (const g of n.result.groups) for (const b of g.bars) if (b.report && b.report.lotId === lot.id) return `zgłoszono z niej cięcie w ${n.no}`;
    if (db.remnants.some(r => r.lotId === lot.id)) return 'odpady użytkowe mają ten Nr mag.';
    return '';
  }

  function renderStock() {
    const idx = arr => arr.map((row, i) => ({ row, i }));
    const showEmpty = $('#lotEmpty').checked;
    $('#barsWrap').innerHTML = gridTable(COLS.bars, idx(db.bars).filter(x => showEmpty || Number(x.row.qty) > 0 || Number(x.row.qtyIn) === 0), 'bars',
      r => (Number(r.qty) > 0 ? '' : 'done') + (lotDup(r) ? ' dup' : ''));
    renderPoolInfo();
    $('#remWrap').innerHTML = gridTable(COLS.remnants, idx(db.remnants), 'remnants');
    const f = $('#profFilter').value.trim().toUpperCase();
    $('#profWrap').innerHTML = gridTable(COLS.profiles, idx(db.profiles).filter(x => !f || x.row.name.toUpperCase().includes(f)), 'profiles',
      r => (Number(r.h) > 0 && Number(r.b) > 0 && Number(r.kgm) > 0 ? '' : 'incomplete'));
    markCodeConflicts();
    $('#cntBars').textContent = db.bars.filter(b => Number(b.qty) > 0).length;
    $('#cntRem').textContent = db.remnants.length;
    $('#cntProf').textContent = db.profiles.length;
  }
  $('#profFilter').addEventListener('input', renderStock);
  $('#lotEmpty').addEventListener('change', renderStock);
  let stockSub = 'bars';
  function showStockSub(sub) {
    stockSub = sub;
    document.querySelectorAll('#stockTabs [data-sub]').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
    document.querySelectorAll('#tab-stock .subpane').forEach(p => p.classList.toggle('active', p.dataset.sub === sub));
  }
  $('#stockTabs').addEventListener('click', e => { const b = e.target.closest('[data-sub]'); if (b) showStockSub(b.dataset.sub); });
  async function catalogInfo() {
    const v = await modal('Plik katalogu profili',
      `<p>Katalog profili (wspólny dla projektów):</p><p><code class="path">${esc(dbPath)}</code></p>`,
      (api.desktop ? [{ label: 'Wskaż inny plik katalogu…', value: 'choose' }, { label: 'Pokaż w folderze', value: 'reveal' }] : [])
        .concat([{ label: 'Zamknij', value: null, primary: true }]));
    if (v === 'choose') { if (await api.dbChoose('open')) await loadDb(); }
    else if (v === 'reveal') api.dbReveal();
  }
  $('#tab-stock').addEventListener('input', e => {
    const table = e.target.closest('table[data-kind]'), tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f;
    if (!table || !tr || !f || f === 'lotNo') return;
    const row = db[table.dataset.kind][Number(tr.dataset.i)];
    const col = COLS[table.dataset.kind].find(c => c.f === f);
    row[f] = col.num ? Math.max(0, num(e.target.value)) : e.target.value.trim();
    if (f === 'qty' || f === 'qtyIn') row[f] = Math.round(row[f]);
    if (table.dataset.kind === 'profiles') { renderLists(); saveDbSoon(); } else changed(true);
    if (f === 'code' || f === 'profile' || f === 'grade') markCodeConflicts();
    if (f === 'lot') document.querySelectorAll('#barsWrap tr[data-i]').forEach(t => { const r = db.bars[Number(t.dataset.i)]; const inp = t.querySelector('input[data-f=lot]');
      if (inp) { inp.classList.toggle('bad', lotDup(r)); inp.title = lotDup(r) ? 'Ten Nr mag. jest już w innej partii' : ''; } });
    if (table.dataset.kind === 'bars' && (f === 'qty' || f === 'length' || f === 'profile' || f === 'grade' || f === 'code')) renderPoolInfo();
  });
  // Nr mag. odpadu wpisany ręcznie – zatwierdzany po wyjściu z pola
  $('#tab-stock').addEventListener('change', e => {
    if (e.target.dataset.f !== 'lotNo') return;
    const rec = db.remnants[Number(e.target.closest('tr[data-i]').dataset.i)], v = e.target.value.trim();
    if (!v) { delete rec.lotId; changed(true); renderStock(); return; }
    const lot = catalog.lotByNo(db.bars, v);
    if (!lot) { e.target.classList.add('bad'); e.target.title = `Nie ma partii z Nr mag. „${v}” – najpierw przyjmij materiał`; return; }
    if (nesting.groupKey(lot.profile, lot.grade) !== nesting.groupKey(rec.profile, rec.grade)) {
      e.target.classList.add('bad'); e.target.title = `Partia ${lot.lot} to ${lot.profile} ${lot.grade}, a odpad ${rec.profile} ${rec.grade}`; return;
    }
    rec.lotId = lot.id; changed(true); renderStock();
  });
  $('#tab-stock').addEventListener('click', e => {
    const sh = e.target.closest('[data-shape]');
    if (sh) {   // kolejny typ przekroju
      const pr = db.profiles[Number(sh.closest('tr[data-i]').dataset.i)], ids = catalog.SHAPES.map(x => x.id);
      pr.shape = ids[(ids.indexOf(pr.shape) + 1) % ids.length];
      saveDbSoon(); renderStock(); updatePreview();
      return;
    }
    const del = e.target.closest('[data-act="row-del"]'); if (!del) return;
    const table = del.closest('table[data-kind]'), tr = del.closest('tr[data-i]');
    if (table.dataset.kind === 'bars') {
      const why = lotInUse(db.bars[Number(tr.dataset.i)]);
      if (why) { info('Nie można usunąć partii', `Ta partia ma historię: ${esc(why)}. Partie zostają w magazynie także po wyczerpaniu – żeby ją ukryć, wyłącz „pokaż wyczerpane”.`); return; }
    }
    db[table.dataset.kind].splice(Number(tr.dataset.i), 1);
    if (table.dataset.kind === 'profiles') saveDbSoon(); else changed(true);
    renderStock(); renderLists();
  });

  // ---------- nesting ----------
  const OPTS = [
    ['kerf', 'Szerokość rzazu', 'mm'], ['trimStart', 'Obcięcie czoła sztangi', 'mm'], ['trimEnd', 'Nieużywany koniec sztangi', 'mm'],
    ['minRemnant', 'Min. długość odpadu użytkowego', 'mm'], ['purchaseLength', 'Długość handlowa do zakupu', 'mm'],
  ];
  function renderOptions() {
    const o = project.options;
    $('#optionsPane').innerHTML = `<div class="pane-head"><h2>Parametry nestingu</h2></div>
      ${OPTS.map(([k, l, u]) => `<div style="margin-bottom:8px"><label class="hint" style="margin:0 0 2px;display:block">${l}</label><div class="form" style="grid-template-columns:1fr"><div class="unit"><input data-o="${k}" type="number" min="0" step="any" value="${o[k]}"><span>${u}</span></div></div></div>`).join('')}
      <label class="check"><input type="checkbox" data-o="preferRemnants" ${o.preferRemnants ? 'checked' : ''}> najpierw zużywaj odpady użytkowe</label>
      <label class="check"><input type="checkbox" data-o="allowPurchase" ${o.allowPurchase ? 'checked' : ''}> brakujący materiał dobierz jako zakup</label>
      <label class="check"><input type="checkbox" data-o="squareRemnants" ${o.squareRemnants ? 'checked' : ''}> odpady ze skośnym końcem obcinaj na prosto</label>
      <div class="hint">Gdy zakup jest wyłączony, detale bez materiału zostaną wykazane jako nierozmieszczone.</div>
      <button class="primary big" data-act="nest">Uruchom nesting</button>
      <div class="hint" style="margin-top:12px">Skośne końce w tej samej płaszczyźnie są zazębiane – program sam obraca i przewraca detale, jeśli na to pozwolono w ich ustawieniach. Rzaz przy cięciu pod kątem jest liczony wzdłuż osi profilu.</div>`;
  }
  $('#optionsPane').addEventListener('input', e => {
    const k = e.target.dataset.o; if (!k) return;
    project.options[k] = e.target.type === 'checkbox' ? e.target.checked : Math.max(0, num(e.target.value));
    if (k === 'squareRemnants') {
      // nie zmienia ułożenia detali – stosowane od razu do bieżącego wyniku, bez ponownego nestingu
      if (project.result) {
        project.result.options.squareRemnants = e.target.checked;
        for (const g of project.result.groups) for (const b of g.bars) if (draw.hasShape(b.remnantShape)) b.squareRemnant = e.target.checked;
        renderResult(); renderReport();
      }
      setDirty(true);
      return;
    }
    changed(true);
  });

  async function runNesting() {
    if (!validParts()) return;
    if (project.result && project.result.edited && !(await confirmBox('Nadpisać zmiany ręczne?',
      'Plan był poprawiany ręcznie. Ponowne uruchomienie nestingu ułoży wszystko od nowa i te zmiany przepadną.', 'Uruchom od nowa'))) return;
    await loadDb();
    showTab('nest');
    $('#busy').classList.remove('hidden');
    await new Promise(r => setTimeout(r, 30));
    try {
      project.result = nesting.nest(nestInput());
      if (project.revisionOf) project.result.reopenedFrom = project.revisionOf.from;
      keep = {}; reportNestingId = null; sel = null;
      syncResult();
      availability = nesting.checkAvailability(nestInput());
      renderAvailability();
      setDirty(true);
    } catch (err) {
      console.error(err);
      info('Błąd nestingu', esc(err.message));
    }
    $('#busy').classList.add('hidden');
    renderResult(); renderReport();
  }

  /** Długość odpadu pokazywana użytkownikowi – gabarytowa, taka jak zapisana w magazynie. */
  const remLen = b => { const o = draw.remnantOut(b); return o ? o.length : 0; };

  /** Uzupełnia typ przekroju w wynikach zapisanych przed wprowadzeniem typów profili. */
  function ensureShapes(r) {
    const map = catalog.profileMap(db);
    for (const g of r.groups) if (!g.shape) {
      const pr = map[String(g.profile).trim().toUpperCase()];
      g.shape = pr ? pr.shape : catalog.guessShape(g.profile);
    }
    return r;
  }

  /** Kafelki podsumowania i plan cięcia – wspólne dla wyniku roboczego i bazy nestingów. */
  function planHtml(r, editable, arch) {
    ensureShapes(r);
    const s = r.summary, o = r.options;
    const loose = s.loose != null ? s.loose : (s.unplaced || 0);
    let h = `<div class="tiles">
      <div class="tile"><b>${s.parts}</b><span>detali rozmieszczonych</span></div>
      <div class="tile"><b>${s.bars}</b><span>sztang i odpadów użytych</span></div>
      <div class="tile"><b>${m1(s.material)} m</b><span>materiał pobrany</span></div>
      <div class="tile good"><b>${m1(s.remnant)} m</b><span>odpad użytkowy (wraca)</span></div>
      <div class="tile"><b>${m1(s.scrap)} m</b><span>złom · ${s.massScrap.toFixed(0)} kg</span></div>
      <div class="tile good"><b>${m1(s.saving)} m</b><span>zysk z zazębienia końców</span></div>
      ${s.toPurchase ? `<div class="tile bad"><b>${s.toPurchase} szt.</b><span>sztang do zakupu</span></div>` : ''}
      ${loose ? `<div class="tile bad"><b>${loose}</b><span>detali poza planem</span></div>` : ''}
      ${s.over ? `<div class="tile bad"><b>${fmt(s.over)} mm</b><span>przekroczona długość sztang</span></div>` : ''}</div>`;
    h += r.warnings.map(w => `<div class="warnbox">⚠ ${esc(w)}</div>`).join('');
    for (const g of r.groups) {
      const t = g.stats;
      h += `<div class="group-title" data-g="${esc(g.key)}"><h3>${esc(g.profile)} ${esc(g.grade)}</h3><span>${t.parts} ${plural(t.parts, 'detal', 'detale', 'detali')} · ${t.fromRemnants} z odpadów · ${t.fromStock} z magazynu${t.toPurchase ? ` · <b style="color:#b02a1a">${t.toPurchase} do zakupu</b>` : ''} · ${t.over ? '<b style="color:#b02a1a">przepełnienie</b>' : 'wykorzystanie ' + pct(t.util)} · złom ${m1(t.scrap)} m` +
        `${editable ? ' <button data-op="addbar" title="Dodaj pustą sztangę tego profilu">+ pusta sztanga</button>' : ''}</span></div>`;
      if (editable && g.loose && g.loose.length) {
        h += `<div class="loosebox" data-g="${esc(g.key)}"><b>Poza planem (${g.loose.length}):</b> ` + g.loose.map((id, i) => {
          const p = partById(id) || { name: '?', length: 0 };
          return `<span class="loosechip ${sel && sel.key === g.key && (sel.list ? sel.list.some(r => r.loose === i) : sel.loose === i) ? 'sel' : ''}" data-loose="${i}"><span class="sw" style="background:${colorOf(id)}"></span>${esc(p.name)} · ${fmt(p.length)}</span>`;
        }).join('') + `<span class="hint" style="margin:0 0 0 6px">kliknij detal i wybierz sztangę</span></div>`;
      }
      for (const b of g.bars) {
        const src = { remnant: 'odpad ' + esc(b.source.id), stock: 'magazyn', purchase: 'do zakupu' }[b.source.kind];
        const selHere = !editable || !sel || sel.key !== g.key ? null
          : sel.list ? sel.list.filter(r => r.loose == null && r.uid === b.uid).map(r => r.i)
          : (sel.loose == null && sel.uid === b.uid ? sel.i : null);
        h += `<div class="barcard ${b.over ? 'over' : ''}" ${editable ? `data-g="${esc(g.key)}" data-uid="${b.uid}"` : arch ? `data-ag="${esc(g.key)}" data-ano="${b.no}"` : ''}><div class="head"><b>#${b.no} · ${fmt(b.source.length)} mm<span class="src ${b.source.kind}">${src}</span>${arch && arch.lotOf && arch.lotOf(b) ? ` <span class="chip lot" title="Nr mag. (Code no.)">${esc(arch.lotOf(b))}</span>` : ''}${b.source.code ? ` <span class="chip code" title="Kod materiału">${esc(b.source.code)}</span>` : ''}${b.source.location ? ` <span>${esc(b.source.location)}</span>` : ''}${draw.sourceEnds(b.source, g.shape) ? ` <span title="Kształt końców odpadu na tej sztandze">· ${esc(draw.sourceEnds(b.source, g.shape))}</span>` : ''}</b>
          <span>${b.placements.length} ${plural(b.placements.length, 'detal', 'detale', 'detali')} · ${b.over ? '<b style="color:#b02a1a">przepełniona</b>' : 'wykorzystanie ' + pct(b.util)} · odpad użytkowy ${b.remnant ? fmt(remLen(b)) + ' mm' + (draw.remnantOut(b).squared ? ' (obcięty na prosto)' : '') : '—'} · złom ${fmt(b.scrap)} mm${b.saving > 0 ? ` · zazębienie ${fmt(b.saving)} mm` : ''}</span></div>`;
        if (editable) h += `<div class="barops">${materialSelect(g, b)}<button data-op="opt" title="Ułóż kolejność i obroty w tej sztandze od nowa">Ułóż ponownie</button>` +
          `${b.placements.length ? '' : '<button data-op="delbar">Usuń sztangę</button>'}${b.over ? `<span class="overmsg">⚠ brakuje ${fmt(b.over)} mm – przenieś detal albo zmień materiał</span>` : ''}</div>`;
        const archHere = arch && arch.sel && arch.sel.key === g.key && arch.sel.no === b.no ? arch.sel.i : null;
        h += draw.barSvg(b, g, colorOf, { trimEnd: o.trimEnd, pick: !!editable || !!arch, sel: editable ? selHere : archHere }) + '</div>';
      }
    }
    return h;
  }
  function renderResult() {
    const el = $('#resultPane'), r = project.result, top = el.scrollTop;
    const runBtn = $('#optionsPane [data-act="nest"]');
    if (runBtn) { runBtn.classList.toggle('primary', !r); runBtn.textContent = r ? 'Uruchom ponownie' : 'Uruchom nesting'; }
    updateToolbar();
    if (!r) {
      el.innerHTML = `<div class="pane-head"><h2>Wynik nestingu</h2></div><div class="empty">${project.cart.length ? 'Brak aktualnego wyniku dla koszyka – kliknij „Uruchom nesting”.' : 'Koszyk jest pusty – przenieś detale z zakładki „1. Detale” do koszyka.'}</div>`;
      return;
    }
    const blocked = r.summary.over > 0;
    let h = `<div class="pane-head"><h2>Wynik nestingu koszyka <span class="chip info">wariant roboczy</span>${project.revisionOf ? ` <span class="chip tight" title="Zatwierdzenie ${esc(project.revisionOf.from)} cofnięte – po zatwierdzeniu nesting zachowa numer z kolejnym numerem zmiany">zmiana ${esc(project.revisionOf.from)} → ${esc(nextNo())}</span>` : ''}${r.edited ? ' <span class="chip tight">zmieniony ręcznie</span>' : ''}</h2>
      <div class="actions"><button data-act="pdf">Raport PDF…</button><button data-act="commit" class="primary" ${blocked ? 'disabled title="Najpierw popraw przepełnione sztangi"' : ''}>Zatwierdź nesting</button></div></div>`;
    h += editBarHtml();
    h += planHtml(r, true);
    const rem = [];
    for (const g of r.groups) for (const b of g.bars) if (b.remnant > 0) rem.push({ g, b, k: g.key + '#' + b.uid });
    h += `<div class="keepbox"><h3>Zatwierdzenie nestingu</h3>
      <div class="hint">Po zatwierdzeniu: zużyte sztangi i odpady schodzą z magazynu, zaznaczone niżej odpady użytkowe trafiają do magazynu projektu, nesting przechodzi do bazy nestingów, a koszyk zostaje opróżniony.</div>`;
    if (rem.length) h += `<table class="grid"><thead><tr><th style="width:70px">Zapisz</th><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Długość [mm]</th><th>Końce odpadu</th>` +
        `<th title="Dodatkowe cięcie proste – do magazynu trafia prosty odcinek, skośne trójkąty idą na złom">Obciąć na prosto</th><th>Ze sztangi</th><th style="width:22%">Lokalizacja</th></tr></thead><tbody>` +
        rem.map(({ g, b, k }) => { const out = draw.remnantOut(b); return `<tr data-k="${esc(k)}"><td class="t"><input type="checkbox" data-keep="on" style="width:auto" ${keep[k] && keep[k].on ? 'checked' : ''}></td>
          <td class="t"><b>${esc(g.profile)}</b></td><td class="t">${esc(g.grade)}</td><td class="t">${esc(b.source.code || '')}</td><td class="n t">${fmt(out.length)}</td>
          <td class="t">${esc(geo.describeEnd(out.end1, g.shape))} / ${esc(geo.describeEnd(out.end2, g.shape))}</td>
          <td class="t">${draw.hasShape(b.remnantShape) ? `<label class="check" style="margin:0"><input type="checkbox" data-keep="square" style="width:auto" ${b.squareRemnant ? 'checked' : ''}> ${b.squareRemnant ? `tak (z ${fmt(b.remnantShape.length)} mm)` : 'nie'}</label>` : '—'}</td>
          <td class="t">#${b.no} (${fmt(b.source.length)} mm)</td>
          <td><input data-keep="location" value="${esc(keep[k] ? keep[k].location : '')}" placeholder="np. regał 3"></td></tr>`; }).join('') + '</tbody></table>';
    h += `<div class="row"><button class="primary" data-act="commit" ${blocked ? 'disabled' : ''}>Zatwierdź nesting</button><span class="hint" style="margin:0">${blocked
      ? '<b style="color:#b02a1a">Zatwierdzenie zablokowane – co najmniej jedna sztanga jest za krótka na swoją zawartość.</b>'
      : 'Do czasu zatwierdzenia magazyn i liczniki detali nie są zmieniane.'}</span></div></div>`;
    el.innerHTML = h;
    el.scrollTop = top;
  }

  // ---------- ręczna korekta planu ----------
  // zaznaczenie: { key, uid, i } – detal na sztandze, { key, loose } – na półce, { key, list: [...] } – kilka (Ctrl+klik)
  let sel = null;
  const refKey = r => r.loose != null ? 'l:' + r.loose : 'b:' + r.uid + ':' + r.i;
  const selRefs = () => !sel ? [] : sel.list ? sel.list.slice() : [sel.loose != null ? { loose: sel.loose } : { uid: sel.uid, i: sel.i }];
  /** Zaznacza detal; z Ctrl dodaje go do zaznaczenia albo odejmuje (tylko w obrębie jednego profilu i gatunku). */
  function pick(key, ref, add) {
    if (!add || !sel || sel.key !== key) { sel = Object.assign({ key }, ref); return; }
    const list = selRefs(), k = refKey(ref), j = list.findIndex(r => refKey(r) === k);
    if (j >= 0) list.splice(j, 1); else list.push(ref);
    sel = !list.length ? null : list.length === 1 ? Object.assign({ key }, list[0]) : { key, list };
  }
  const E = nesting.edit;
  const ropt = () => project.result.options;
  const rgroup = key => project.result && project.result.groups.find(g => g.key === key);
  const rbar = (g, uid) => g && g.bars.find(b => b.uid === uid);
  const ectx = g => E.editContext(g, project.parts);
  const optKey = o => `${o.kind}|${o.id || ''}|${o.length}|${o.code || ''}`;
  // ---------- kod materiału ----------
  const codeOf = id => nesting.normCode((partById(id) || {}).code);
  /** Kod, którego wymagają detale (wszystkie z kodem muszą mieć ten sam); null = konflikt kilku kodów. */
  function requiredCode(ids) {
    const cs = new Set(ids.map(codeOf).filter(Boolean));
    return cs.size > 1 ? null : cs.size ? Array.from(cs)[0] : '';
  }
  /**
   * Czy detale ids mogą trafić na sztangę b. Zakup bez detali z kodem przyjmuje kod przenoszonych detali.
   * Zwraca komunikat blokady albo '' (gdy wolno).
   */
  function codeBlock(b, ids) {
    const all = ids.concat(b.placements.map(p => p.partId));
    const need = requiredCode(all);
    if (need === null) return `Na jednej sztandze nie mogą się znaleźć detale z różnymi kodami materiału (${Array.from(new Set(all.map(codeOf).filter(Boolean))).join(', ')}).`;
    const have = nesting.normCode(b.source.code);
    if (!need || need === have) return '';
    if (b.source.kind === 'purchase' && !requiredCode(b.placements.map(p => p.partId))) return '';
    return `Detal z kodem materiału <b>${esc(need)}</b> może być wycięty tylko z materiału z tym kodem – sztanga #${b.no} ` +
      (have ? `ma kod <b>${esc(have)}</b>.` : 'jest bez kodu.') + ' Zmień najpierw materiał sztangi albo wybierz inną.';
  }
  /** Zakup pod detale z kodem dostaje ich kod (i traci go, gdy takich detali już nie ma). */
  function syncPurchaseCode(b) {
    if (b && b.source.kind === 'purchase') b.source.code = requiredCode(b.placements.map(p => p.partId)) || '';
  }

  /** Stałe identyfikatory sztang, półka „poza planem”, domyślny zapis nowych odpadów użytkowych. */
  function syncResult() {
    const r = project.result; if (!r) return;
    for (const g of r.groups) {
      if (!Array.isArray(g.loose)) { g.loose = []; for (const u of g.unplaced || []) for (let i = 0; i < u.count; i++) g.loose.push(u.partId); }
      for (const b of g.bars) {
        if (!b.uid) b.uid = newId();
        const k = g.key + '#' + b.uid;
        if (b.remnant > 0 && !keep[k]) keep[k] = { on: true, location: b.source.location || '' };
        if (b.squareRemnant === undefined) b.squareRemnant = !!r.options.squareRemnants && draw.hasShape(b.remnantShape);
      }
    }
  }
  function afterEdit() {
    project.result.edited = true;
    E.recompute(project.result);
    syncResult();
    setDirty(true);
    renderResult(); renderReport();
  }
  function selPlacement() {
    if (!sel || sel.list || sel.loose != null) return null;
    const g = rgroup(sel.key), b = rbar(g, sel.uid);
    return b && b.placements[sel.i] ? { g, b, p: b.placements[sel.i] } : null;
  }

  /** Materiał, na który można przełożyć sztangę: wolne odpady, wolne sztangi z magazynu, zakup. */
  function materialOptions(g, bar, wantCode) {
    const need = wantCode != null ? wantCode : bar ? (requiredCode(bar.placements.map(p => p.partId)) || '') : '';
    const fits = c => !need || nesting.normCode(c) === need;
    const usedStock = {}, usedRem = new Set();
    for (const gg of project.result.groups) for (const b of gg.bars) {
      if (b === bar) continue;
      if (b.source.kind === 'stock') usedStock[b.source.id] = (usedStock[b.source.id] || 0) + 1;
      if (b.source.kind === 'remnant') usedRem.add(b.source.id);
    }
    const out = [];
    for (const r of db.remnants) if (nesting.groupKey(r.profile, r.grade) === g.key && !usedRem.has(r.id) && fits(r.code))
      out.push({ kind: 'remnant', id: r.id, label: 'Odpad ' + r.id, length: Number(r.length), location: r.location || '', code: nesting.normCode(r.code), rec: r });
    for (const st of poolBars()) if (nesting.groupKey(st.profile, st.grade) === g.key && fits(st.code)) {
      const free = Number(st.qty) - (usedStock[st.id] || 0);
      if (free > 0) out.push({ kind: 'stock', id: st.id, label: 'Magazyn', length: Number(st.length), location: st.location || '', code: nesting.normCode(st.code), free });
    }
    if (ropt().allowPurchase && ropt().purchaseLength > 0) out.push({ kind: 'purchase', id: null, label: 'Do zakupu', length: Number(ropt().purchaseLength), code: need });
    return out;
  }
  function materialSelect(g, b) {
    const list = materialOptions(g, b), cur = optKey(b.source);
    if (!list.some(o => optKey(o) === cur)) list.unshift(b.source);
    const need = b.placements.length ? b.usedTo + ropt().trimEnd : 0;   // ostatni rzaz nie musi się zmieścić (jak w silniku)
    const lab = o => ({ remnant: `odpad ${o.id}`, stock: 'magazyn', purchase: 'do zakupu' }[o.kind]) + ` · ${fmt(o.length)} mm` +
      (o.rec && (o.rec.end1 || o.rec.end2) ? ' · skośny koniec' : '') +
      (o.code ? ` · kod ${o.code}` : '') + (o.location ? ` · ${o.location}` : '') + (o.free ? ` (wolne: ${o.free})` : '') + (o.length < need ? ' – za krótki' : '');
    const grp = (kind, title) => { const xs = list.filter(o => o.kind === kind); return xs.length ? `<optgroup label="${title}">` + xs.map(o =>
      `<option value="${esc(optKey(o))}" ${optKey(o) === cur ? 'selected' : ''}>${esc(lab(o))}</option>`).join('') + '</optgroup>' : ''; };
    return `<label class="matlabel">Materiał <select data-mat title="Zmień materiał bazowy tej sztangi">${grp('remnant', 'Odpady użytkowe')}${grp('stock', 'Magazyn')}${grp('purchase', 'Zakup')}</select></label>`;
  }

  /** Pozycja z listy materiału → źródło sztangi (odpad ze skosem ułożony licem do pierwszego detalu). */
  function sourceFrom(o, g, b) {
    if (o.kind === 'remnant' && o.rec) return E.orientRemnant(o.rec, ectx(g), b && b.placements[0], ropt());
    const c = Object.assign({}, o); delete c.rec; delete c.free;
    return Object.assign(c, { left: null, right: null, move: null });
  }

  function placeInto(g, b, partId) {
    const part = partById(partId), ctx = ectx(g), last = b.placements[b.placements.length - 1];
    const mv = E.bestMove(part, ctx, ropt(), last ? last.right : null, null);
    b.placements.push({ partId, rev: mv.rev, flip: mv.flip, rot: mv.rot });
    E.relayoutBar(b, ctx, ropt());
    return b.placements.length - 1;
  }
  function addBar(g, code) {
    const list = materialOptions(g, null, code || '');
    // pusta sztanga dla detali bez kodu: najpierw materiał bez kodu
    const pref = code ? list : list.filter(o => !o.code).concat(list.filter(o => o.code));
    const pick = pref.find(o => o.kind === 'stock') || pref.find(o => o.kind === 'purchase') || pref[0];
    const src = pick && sourceFrom(pick, g, null);
    if (!src) { info('Brak materiału', `Dla ${esc(g.profile)} ${esc(g.grade)}${code ? ` z kodem ${esc(code)}` : ''} nie ma wolnych sztang ani odpadów, a zakup jest wyłączony w parametrach nestingu.`); return null; }
    const b = { uid: newId(), source: src, placements: [], net: 0, remnant: 0, scrap: src.length, util: 0, saving: 0, over: 0, usedTo: 0 };
    g.bars.push(b);
    E.relayoutBar(b, ectx(g), ropt());
    return b;
  }
  function shiftSel(dir) {
    const s = selPlacement(); if (!s) return;
    const a = s.b.placements, j = sel.i + dir;
    if (j < 0 || j >= a.length) return;
    [a[sel.i], a[j]] = [a[j], a[sel.i]];
    sel.i = j;
    E.relayoutBar(s.b, ectx(s.g), ropt());
    afterEdit();
  }
  function rotateSel() {
    const s = selPlacement(); if (!s) return;
    const ms = E.movesFor(partById(s.p.partId), ectx(s.g));
    if (ms.length < 2) { info('Obrót niemożliwy', 'Ten detal ma tylko jedno dozwolone ułożenie – przekrój bez potrzebnej symetrii (np. kątownik) albo detal kierunkowy.'); return; }
    const cur = ms.findIndex(m => m.rev === !!s.p.rev && m.flip === !!s.p.flip && m.rot === !!s.p.rot);
    const nx = ms[(cur + 1) % ms.length];
    Object.assign(s.p, { rev: nx.rev, flip: nx.flip, rot: nx.rot });
    E.relayoutBar(s.b, ectx(s.g), ropt());
    afterEdit();
  }
  /** target: 'b:<uid>' – inna sztanga, 'new' – nowa sztanga, 'loose' – poza plan, 'cart' – usunięcie z nestingu. */
  function moveSel(target) {
    if (sel && sel.list) return moveMany(target);
    const g = sel && rgroup(sel.key); if (!g) return;
    {
      const id0 = sel.loose != null ? g.loose[sel.loose] : (selPlacement() || { p: {} }).p.partId;
      const tb = target && target.startsWith('b:') ? rbar(g, target.slice(2)) : null;
      const msg = tb && id0 && !(sel.loose == null && sel.uid === tb.uid) ? codeBlock(tb, [id0]) : '';
      if (msg) { info('Niezgodny kod materiału', msg); return; }
    }
    let partId;
    if (sel.loose != null) {
      if (target === 'loose') return;
      partId = g.loose[sel.loose];
      g.loose.splice(sel.loose, 1);
    } else {
      const s = selPlacement(); if (!s) return;
      partId = s.p.partId;
      s.b.placements.splice(sel.i, 1);
      E.relayoutBar(s.b, ectx(g), ropt());
    }
    if (target === 'loose') { g.loose.push(partId); sel = { key: g.key, loose: g.loose.length - 1 }; }
    else if (target === 'cart') {
      // detal wypada z tego nestingu: koszyk maleje, sztuka wraca do puli pozostałych
      const c = project.cart.find(x => x.partId === partId);
      if (c) { c.qty -= 1; if (c.qty <= 0) project.cart = project.cart.filter(x => x !== c); }
      sel = null; renderCart(); refreshCounts();
    } else {
      const b = target === 'new' ? addBar(g, codeOf(partId)) : rbar(g, target.slice(2));
      if (!b) { g.loose.push(partId); sel = { key: g.key, loose: g.loose.length - 1 }; afterEdit(); return; }
      sel = { key: g.key, uid: b.uid, i: placeInto(g, b, partId) };
      syncPurchaseCode(b);
    }
    for (const b of g.bars) syncPurchaseCode(b);
    afterEdit();
  }

  /** Przenosi wszystkie zaznaczone detale; zachowują kolejność z planu i trafiają na koniec sztangi docelowej. */
  function moveMany(target) {
    const g = rgroup(sel.key); if (!g) return;
    const refs = sel.list.slice();
    const pos = r => r.loose != null ? [1e9, r.loose] : [g.bars.findIndex(b => b.uid === r.uid), r.i];
    refs.sort((a, b) => { const x = pos(a), y = pos(b); return x[0] - y[0] || x[1] - y[1]; });
    const ids = refs.map(r => r.loose != null ? g.loose[r.loose] : rbar(g, r.uid).placements[r.i].partId);
    if (target === 'cart' && refs.some(r => r.loose == null)) return;
    if (target !== 'loose' && target !== 'cart') {
      const tb = target === 'new' ? null : rbar(g, target.slice(2));
      const moving = tb ? ids.filter((id, n) => refs[n].uid !== tb.uid) : ids;
      const rest = tb ? { no: tb.no, source: tb.source, placements: tb.placements } : null;
      const msg = tb ? codeBlock(rest, moving) : requiredCode(ids) === null
        ? `Zaznaczone detale mają różne kody materiału (${Array.from(new Set(ids.map(codeOf).filter(Boolean))).join(', ')}) – nie mogą trafić na jedną sztangę.` : '';
      if (msg) { info('Niezgodny kod materiału', msg); return; }
    }
    // usuwanie od końca, żeby indeksy się nie przesuwały
    const byBar = {}, looseIdx = [];
    for (const r of refs) if (r.loose != null) looseIdx.push(r.loose); else (byBar[r.uid] = byBar[r.uid] || []).push(r.i);
    for (const uid of Object.keys(byBar)) {
      const b = rbar(g, uid);
      byBar[uid].sort((a, c) => c - a).forEach(i => b.placements.splice(i, 1));
      E.relayoutBar(b, ectx(g), ropt());
    }
    looseIdx.sort((a, c) => c - a).forEach(i => g.loose.splice(i, 1));
    const asSel = list => list.length > 1 ? { key: g.key, list } : list.length ? Object.assign({ key: g.key }, list[0]) : null;
    if (target === 'loose') {
      const start = g.loose.length; g.loose.push(...ids);
      sel = asSel(ids.map((_, n) => ({ loose: start + n })));
    } else if (target === 'cart') {
      for (const id of ids) { const c = project.cart.find(x => x.partId === id); if (c) { c.qty -= 1; if (c.qty <= 0) project.cart = project.cart.filter(x => x !== c); } }
      sel = null; renderCart(); refreshCounts();
    } else {
      const b = target === 'new' ? addBar(g, requiredCode(ids) || '') : rbar(g, target.slice(2));
      if (!b) { const start = g.loose.length; g.loose.push(...ids); sel = asSel(ids.map((_, n) => ({ loose: start + n }))); afterEdit(); return; }
      sel = asSel(ids.map(id => ({ uid: b.uid, i: placeInto(g, b, id) })));
    }
    for (const b of g.bars) syncPurchaseCode(b);
    afterEdit();
  }

  function editBarHtml() {
    if (!sel) return `<div class="editbar idle">Kliknij detal na planie, żeby zmienić jego miejsce albo ułożenie. ` +
      `Ctrl+klik zaznacza kilka detali naraz. Klawisze: ← → przesuwają w sztandze, R obraca, Delete odkłada poza plan, Esc odznacza.</div>`;
    if (sel.list) {
      const g = rgroup(sel.key);
      const ok = g && sel.list.every(r => r.loose != null ? g.loose[r.loose] != null : (rbar(g, r.uid) || { placements: [] }).placements[r.i]);
      if (!ok) { sel = null; return editBarHtml(); }
      const ids = sel.list.map(r => r.loose != null ? g.loose[r.loose] : rbar(g, r.uid).placements[r.i].partId);
      const total = ids.reduce((t, id) => t + (Number((partById(id) || {}).length) || 0), 0);
      const onBars = sel.list.some(r => r.loose == null), allLoose = !onBars;
      const n = sel.list.length, w = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'detale' : 'detali';
      return `<div class="editbar"><b>Zaznaczono ${n} ${w}</b>
        <span>${esc(g.profile)} ${esc(g.grade)} · razem ${fmt(total)} mm · Ctrl+klik dodaje lub odejmuje detal</span>
        <select data-ed="move"><option value="">przenieś wszystkie do…</option>${g.bars.map(b => `<option value="b:${b.uid}">sztanga #${b.no} · ${fmt(b.source.length)} mm${b.source.code ? ' · kod ' + esc(b.source.code) : ''}</option>`).join('')}
          <option value="new">nowa sztanga</option>${onBars ? '<option value="loose">poza plan</option>' : ''}</select>
        ${allLoose ? '<button data-ed="cart" title="Detale nie wejdą do tego nestingu – zostaną w puli pozostałych do wycięcia">Usuń z nestingu</button>' : ''}
        <button data-ed="unsel" class="x" title="Odznacz (Esc)">✕</button></div>`;
    }
    const g = rgroup(sel.key), sp = selPlacement();
    const partId = sel.loose != null ? (g && g.loose[sel.loose]) : (sp && sp.p.partId);
    const part = partId && partById(partId);
    if (!g || !part) { sel = null; return editBarHtml(); }
    const targets = g.bars.filter(b => !sp || b.uid !== sel.uid)
      .map(b => `<option value="b:${b.uid}">sztanga #${b.no} · ${fmt(b.source.length)} mm${b.source.code ? ' · kod ' + esc(b.source.code) : ''}</option>`).join('');
    const pos = sp ? `sztanga #${sp.b.no}, pozycja ${sel.i + 1} z ${sp.b.placements.length} · ${esc(geo.describeMove(sp.p))}` : 'poza planem';
    return `<div class="editbar"><span class="sw" style="background:${colorOf(partId)}"></span><b>${esc(part.name)}</b>
      <span>${fmt(part.length)} mm · ${esc(g.profile)} · ${pos} · Ctrl+klik – zaznacz więcej</span>
      ${sp ? `<button data-ed="left" title="Przesuń w lewo (←)" ${sel.i === 0 ? 'disabled' : ''}>◀</button><button data-ed="right" title="Przesuń w prawo (→)" ${sel.i === sp.b.placements.length - 1 ? 'disabled' : ''}>▶</button>
        <button data-ed="rot" title="Następne dozwolone ułożenie (R)">Obróć</button>` : ''}
      <select data-ed="move"><option value="">przenieś do…</option>${targets}<option value="new">nowa sztanga</option>${sp ? '<option value="loose">poza plan</option>' : ''}</select>
      ${sp ? '' : '<button data-ed="cart" title="Detal nie wejdzie do tego nestingu – zostanie w puli pozostałych do wycięcia">Usuń z nestingu</button>'}
      <button data-ed="unsel" class="x" title="Odznacz (Esc)">✕</button></div>`;
  }

  $('#resultPane').addEventListener('click', e => {
    if (!project.result) return;
    const card = e.target.closest('[data-g]');
    const poly = e.target.closest('polygon[data-pl]');
    const add = e.ctrlKey || e.metaKey;
    if (poly && card) { pick(card.dataset.g, { uid: card.dataset.uid, i: Number(poly.dataset.pl) }, add); renderResult(); return; }
    const chip = e.target.closest('[data-loose]');
    if (chip && card) { pick(card.dataset.g, { loose: Number(chip.dataset.loose) }, add); renderResult(); return; }
    const ed = e.target.closest('button[data-ed]');
    if (ed) {
      const a = { left: () => shiftSel(-1), right: () => shiftSel(1), rot: rotateSel, cart: () => moveSel('cart'), unsel: () => { sel = null; renderResult(); } }[ed.dataset.ed];
      if (a) a();
      return;
    }
    const op = e.target.closest('button[data-op]');
    if (op && card) {
      const g = rgroup(card.dataset.g), b = rbar(g, card.dataset.uid);
      if (op.dataset.op === 'addbar') { if (addBar(g)) afterEdit(); }
      if (op.dataset.op === 'delbar' && b) { g.bars = g.bars.filter(x => x !== b); afterEdit(); }
      if (op.dataset.op === 'opt' && b) { E.optimizeBar(b, g, project.parts, ropt()); sel = null; afterEdit(); }
    }
  });
  $('#resultPane').addEventListener('change', e => {
    if (!project.result) return;
    if (e.target.dataset.ed === 'move') { if (e.target.value) moveSel(e.target.value); return; }
    if (e.target.hasAttribute('data-mat')) {
      const card = e.target.closest('[data-g]'), g = rgroup(card.dataset.g), b = rbar(g, card.dataset.uid);
      const c = materialOptions(g, b).find(o => optKey(o) === e.target.value);
      if (c) { b.source = sourceFrom(c, g, b); E.relayoutBar(b, ectx(g), ropt()); afterEdit(); }
    }
  });
  document.addEventListener('keydown', e => {
    if (!sel || !project.result || !$('#tab-nest').classList.contains('active')) return;
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('#modal').classList.contains('hidden') || !$('#importDlg').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); shiftSel(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); shiftSel(1); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateSel(); }
    else if (e.key === 'Delete') { e.preventDefault(); if (sel.list ? sel.list.some(r => r.loose == null) : sel.loose == null) moveSel('loose'); }
    else if (e.key === 'Escape') { sel = null; renderResult(); }
  });
  $('#resultPane').addEventListener('input', e => {
    const tr = e.target.closest('tr[data-k]'), f = e.target.dataset.keep; if (!tr || !f) return;
    if (f === 'square') {
      const [key, uid] = tr.dataset.k.split('#'), b = rbar(rgroup(key), uid);
      if (b) { b.squareRemnant = e.target.checked; setDirty(true); renderResult(); renderReport(); }
      return;
    }
    const k = keep[tr.dataset.k] || (keep[tr.dataset.k] = { on: false, location: '' });
    if (f === 'on') k.on = e.target.checked; else k.location = e.target.value;
  });

  /** Dopisuje nesting do bazy nestingów projektu (z migawką detali i licznikiem użytych sztuk). */
  /** Numer, pod którym koszyk zostanie zatwierdzony: kolejny N-xxx albo zmiana cofniętego nestingu N-xxx_R.n. */
  function nextNo() {
    const rv = project.revisionOf;
    return rv ? `${rv.baseNo}_R.${rv.revision}` : 'N-' + String(project.seq.nesting).padStart(3, '0');
  }
  function archiveNesting(result, items, meta, remnantsAdded) {
    const used = {};
    for (const g of result.groups) for (const b of g.bars) for (const p of b.placements) used[p.partId] = (used[p.partId] || 0) + 1;
    const rv = project.revisionOf, no = nextNo();
    if (!rv) project.seq.nesting++;
    const n = { id: newId(), no, baseNo: rv ? rv.baseNo : no, revision: rv ? rv.revision : 0, date: new Date().toLocaleDateString('pl-PL'),
      meta: Object.assign({}, meta), used, items: JSON.parse(JSON.stringify(items)), result, remnantsAdded: remnantsAdded || 0 };
    project.nestings.push(n);
    return n;
  }
  async function commit() {
    const r = project.result;
    if (!r) { info('Brak wyniku', 'Najpierw uruchom nesting dla koszyka.'); return; }
    // kod materiału mógł zostać zmieniony w detalach po nestingu
    const bad = [];
    for (const g of r.groups) for (const b of g.bars) {
      const need = requiredCode(b.placements.map(p => p.partId));
      if (need === null || (need && need !== nesting.normCode(b.source.code))) bad.push(`${g.profile} ${g.grade} – sztanga #${b.no}`);
    }
    if (bad.length) { info('Niezgodny kod materiału', `Detale z kodem materiału leżą na materiale z innym kodem: <b>${bad.map(esc).join(', ')}</b>. Uruchom nesting ponownie albo popraw plan.`); return; }
    await loadDb();
    // stan magazynu mógł się zmienić od czasu nestingu
    const need = {}, missing = [];
    for (const g of r.groups) for (const b of g.bars) {
      if (b.source.kind === 'remnant' && !db.remnants.some(x => x.id === b.source.id)) missing.push('odpad ' + b.source.id);
      if (b.source.kind === 'stock') need[b.source.id] = (need[b.source.id] || 0) + 1;
    }
    const pl = stockPools();
    for (const id of Object.keys(need)) {
      const s = pl.find(x => x.id === id);
      if (!s || s.qty < need[id]) { const [, pr, gr, , L] = id.split('|'); missing.push(`sztangi ${pr} ${gr} ${fmt(Number(L))} mm (potrzeba ${need[id]}, wolne ${s ? Math.max(0, s.qty) : 0})`); }
    }
    if (missing.length) { info('Magazyn się zmienił', `Od czasu nestingu z bazy ubyło: <b>${esc(missing.join(', '))}</b>. ${r.edited ? 'Zmień materiał tych sztang w planie albo uruchom nesting ponownie.' : 'Uruchom nesting ponownie.'}`); return; }
    if (r.summary.over > 0) { info('Przepełniona sztanga', 'Co najmniej jedna sztanga jest za krótka na swoją zawartość. Przenieś detal albo zmień materiał, zanim zatwierdzisz nesting.'); return; }
    const list = [];
    for (const g of r.groups) for (const b of g.bars) {
      const k = keep[g.key + '#' + b.uid];
      if (b.remnant > 0 && k && k.on) list.push({ groupKey: g.key, barNo: b.no, location: k.location });
    }
    const s = r.summary, no = nextNo();
    const nSt = r.groups.reduce((a, g) => a + g.stats.fromStock, 0), nRm = r.groups.reduce((a, g) => a + g.stats.fromRemnants, 0);
    const loose = s.loose != null ? s.loose : (s.unplaced || 0);
    const ok = await confirmBox(`Zatwierdzić nesting ${no}?`,
      `<ul><li>sztangi z magazynu – zarezerwowane: <b>${nSt}</b> ${plural(nSt, 'sztanga', 'sztangi', 'sztang')} (stan partii zmniejszy się przy zgłoszeniu cięcia),</li>
       <li>odpady użytkowe zdjęte z magazynu: <b>${nRm}</b>,</li>
       <li>nowe odpady użytkowe dopisane do magazynu: <b>${list.length}</b>,</li>
       ${s.toPurchase ? `<li><b style="color:#b02a1a">do zakupu: ${s.toPurchase} ${plural(s.toPurchase, 'sztanga', 'sztangi', 'sztang')}</b> – nie ma ich w magazynie,</li>` : ''}
       ${loose ? `<li><b style="color:#b02a1a">poza planem: ${loose} ${plural(loose, 'detal', 'detale', 'detali')}</b> – nie wejdą do nestingu i wrócą na listę jako pozostałe,</li>` : ''}
       <li>nesting trafi do bazy nestingów jako <b>${no}</b>, a <b>${s.parts}</b> szt. detali zostanie oznaczonych jako użyte,</li>
       <li>koszyk zostanie opróżniony.</li></ul>Zatwierdzenie można później cofnąć w zakładce „6. Baza nestingów” (przycisk „Cofnij zatwierdzenie…”).`, 'Zatwierdź');
    if (!ok) return;
    // kopia zużytego materiału – potrzebna do cofnięcia zatwierdzenia
    const consumed = [], stockRows = {};
    for (const g of r.groups) for (const b of g.bars) {
      if (b.source.kind === 'remnant') { const rec = project.stock.remnants.find(x => x.id === b.source.id); if (rec) consumed.push(JSON.parse(JSON.stringify(rec))); }
      if (b.source.kind === 'stock' && !stockRows[b.source.id]) { const row = project.stock.bars.find(x => x.id === b.source.id); if (row) stockRows[b.source.id] = JSON.parse(JSON.stringify(row)); }
    }
    catalog.commitResult(project.stock, r, { name: [project.meta.name, no].filter(Boolean).join(' · '), number: project.meta.number, no, lotMode: true }, list);
    bindStock();
    const n = archiveNesting(r, cartParts(), project.meta, list.length);
    Object.assign(n, { consumed, stockRows, lotMode: true, historyId: project.stock.history[0] ? project.stock.history[0].id : null });
    project.cart = []; project.result = null; project.revisionOf = null; keep = {}; availability = null; sel = null;
    archiveSel = n.id; reportNestingId = n.id;
    setDirty(true);
    renderParts(); renderCart(); renderResult(); renderReport(); renderStock();
    showTab('archive');
    // magazyn i liczniki są w pliku projektu – zapis od razu po zatwierdzeniu
    await saveProject(false);
  }

  // ---------- baza nestingów ----------
  function renderArchive() {
    const list = $('#archiveList'), det = $('#archiveDetail');
    updateTabBadges();
    if (!project.nestings.length) {
      list.innerHTML = '<div class="empty">Brak zatwierdzonych nestingów.</div>';
      det.innerHTML = '<div class="pane-head"><h2>Nesting</h2></div><div class="empty">Tu trafia każdy zatwierdzony nesting: plan cięcia, lista detali i raport.</div>';
      return;
    }
    if (archiveSel === IDENT) { renderArchiveList(); renderIdent(); return; }
    if (!project.nestings.some(n => n.id === archiveSel)) archiveSel = project.nestings[project.nestings.length - 1].id;
    renderArchiveList();
    const n = project.nestings.find(x => x.id === archiveSel);
    const R = resolver(), lotOf = b => lotLabel(R.barLotId(n, b));
    const saved = [];
    for (const g of n.result.groups) for (const b of g.bars) if (b.savedRemnantId) saved.push(`${esc(b.savedRemnantId)} (${esc(g.profile)}, ${fmt(remLen(b))} mm)`);
    det.innerHTML = `<div class="pane-head"><h2>${esc(n.no)} · ${esc(n.date)}${n.meta.name ? ' · ' + esc(n.meta.name) : ''} <span class="chip ok">zatwierdzony</span>${n.result.edited ? ' <span class="chip tight">poprawiany ręcznie</span>' : ''}</h2>
      <div class="actions nowrap"><button data-arch="report" title="Pokaż raport w zakładce Raport">Raport</button><button data-arch="pdf" title="Zapisz raport nestingu do PDF">PDF…</button><button data-arch="csv" title="Lista cięć CSV">CSV…</button><button data-arch="revert" class="danger" title="Materiał wraca do magazynu, detale do puli pozostałych">Cofnij zatwierdzenie…</button></div></div>` +
      cutReportHtml(n) +
      archToolbar(n) + planHtml(n.result, false, { sel: archPick, lotOf }) +
      `<div class="group-title"><h3>Detale w tym nestingu</h3><span>${saved.length ? 'Zapisane odpady użytkowe: ' + saved.join(', ') : 'Bez nowych odpadów użytkowych'}</span></div>
      <table class="grid"><thead><tr><th>Nazwa</th><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Długość [mm]</th><th class="n">Użyto [szt.]</th><th class="n">Zezłomowano</th><th>Początek</th><th>Koniec</th></tr></thead><tbody>` +
      n.items.map(p => { const sc = scrappedIn(n).filter(x => x.partId === p.id).length; return `<tr><td class="t"><span class="sw" style="background:${colorOf(p.id)}"></span> <b>${esc(p.name)}</b></td><td class="t">${esc(p.profile)}</td><td class="t">${esc(p.grade)}</td><td class="t">${esc(p.code || '')}</td><td class="n t">${fmt(p.length)}</td>
        <td class="n t">${(n.used || {})[p.id] || 0}</td><td class="n t">${sc ? `<b style="color:#b02a1a">${sc}</b>` : '—'}</td><td class="t">${esc(geo.describeEnd(p.end1, dimsOf(p).shape))}</td><td class="t">${esc(geo.describeEnd(p.end2, dimsOf(p).shape))}</td></tr>`; }).join('') + '</tbody></table>';
    if (cutFocus != null) { const el = det.querySelectorAll('input[data-cut]')[cutFocus]; cutFocus = null; if (el) { el.focus(); el.select(); } }
  }
  function renderArchiveList() {
    const list = $('#archiveList');
    list.innerHTML = `<table class="grid"><thead><tr><th>Nr</th><th>Data</th><th class="n">Detali</th><th class="n">Sztang</th><th class="n">Materiał [m]</th><th class="n">Złom [m]</th><th class="n">Do zakupu</th><th class="n" title="Zezłomowane detale">Zezłom.</th></tr></thead><tbody>` +
      project.nestings.slice().reverse().map(n => { const s = n.result.summary, sc = scrappedIn(n).length; return `<tr data-n="${n.id}" class="${n.id === archiveSel ? 'sel' : ''}"><td class="t"><b>${esc(n.no)}</b></td><td class="t">${esc(n.date)}</td>
        <td class="n t">${s.parts}</td><td class="n t">${s.bars}</td><td class="n t">${m1(s.material)}</td><td class="n t">${m1(s.scrap)}</td><td class="n t">${s.toPurchase || '—'}</td><td class="n t">${sc ? `<b style="color:#b02a1a">${sc}</b>` : '—'}</td></tr>`; }).join('') + '</tbody></table>';
    const nn = project.nestings.length;
    // liczba niezgłoszonych sztang przy każdym nestingu
    list.querySelectorAll('tr[data-n]').forEach(tr => {
      const n = project.nestings.find(x => x.id === tr.dataset.n), c = cutCounts(n);
      tr.querySelector('td').insertAdjacentHTML('beforeend', c.todo ? ` <span class="chip tight" title="Sztangi bez zgłoszonego Nr mag.">${c.todo} do zgł.</span>` : (c.all ? ' <span class="chip ok" title="Cięcie zgłoszone">✓</span>' : ''));
    });
    return nn;
  }

  // ---------- zgłoszenie cięcia (Nr mag. sztang) ----------
  const IDENT = '__ident';
  let cutFocus = null, identFilter = { n: '', part: '', prof: '', okOnly: false };
  /** Czy partia pasuje do sztangi z planu: profil, gatunek, kod materiału detali, długość (zakup: wystarczająca). */
  function lotFitsBar(l, bar) {
    if (nesting.groupKey(l.profile, l.grade) !== nesting.groupKey(bar.profile, bar.grade)) return false;
    if (bar.code && nesting.normCode(l.code) !== nesting.normCode(bar.code)) return false;
    return bar.purchase ? Number(l.length) >= (bar.minLen || bar.length) : Number(l.length) === Number(bar.length);
  }
  const barNeed = (n, g, b) => ({ profile: g.profile, grade: g.grade, length: b.source.length, code: requiredCode(b.placements.map(p => p.partId)) || '',
    purchase: b.source.kind === 'purchase', minLen: Math.ceil(b.usedTo + ((n.result.options || {}).trimEnd || 0)) });
  function cutCounts(n) {
    const R = resolver(); let all = 0, todo = 0;
    for (const g of n.result.groups) for (const b of g.bars) { all++; if (!R.barLotId(n, b)) todo++; }
    return { all, todo };
  }
  /** Zgłoszenie Nr mag. dla sztangi; zwraca komunikat błędu albo ''. Stan partii zmienia się tylko w nestingach z partiami. */
  function setBarLot(n, g, b, text) {
    const stockSide = b.source.kind !== 'remnant' && n.lotMode;
    const old = b.report && b.report.lotId ? db.bars.find(x => x.id === b.report.lotId) : null;
    if (!text) { if (old && stockSide) old.qty = Number(old.qty) + 1; delete b.report; return ''; }
    const lot = catalog.lotByNo(db.bars, text);
    if (!lot) return `Nie ma partii z Nr mag. „${esc(text)}” – najpierw przyjmij materiał w zakładce Magazyn.`;
    if (old && old.id === lot.id) return '';
    const need = barNeed(n, g, b);
    if (nesting.groupKey(lot.profile, lot.grade) !== nesting.groupKey(g.profile, g.grade)) return `Partia ${esc(lot.lot)} to ${esc(lot.profile)} ${esc(lot.grade)}, a sztanga #${b.no} – ${esc(g.profile)} ${esc(g.grade)}.`;
    if (need.code && nesting.normCode(lot.code) !== need.code) return `Na sztandze #${b.no} są detale z kodem materiału ${esc(need.code)}, a partia ${esc(lot.lot)} ma ${lot.code ? 'kod ' + esc(lot.code) : 'brak kodu'}.`;
    if (b.source.kind === 'stock' && Number(lot.length) !== Number(b.source.length)) return `Partia ${esc(lot.lot)} ma długość ${fmt(lot.length)} mm, a sztanga #${b.no} – ${fmt(b.source.length)} mm.`;
    if (b.source.kind === 'purchase' && Number(lot.length) < need.minLen) return `Partia ${esc(lot.lot)} (${fmt(lot.length)} mm) jest za krótka – sztanga #${b.no} potrzebuje ${fmt(need.minLen)} mm.`;
    if (stockSide && Number(lot.qty) < 1) return `Partia ${esc(lot.lot)} ma stan 0 – wszystkie sztangi z tej partii są już zgłoszone.`;
    if (old && stockSide) old.qty = Number(old.qty) + 1;
    if (stockSide) lot.qty = Number(lot.qty) - 1;
    b.report = { lotId: lot.id, date: new Date().toLocaleDateString('pl-PL') };
    return '';
  }
  function cutReportHtml(n) {
    const R = resolver(), c = cutCounts(n);
    const SRC = { remnant: 'odpad', stock: 'magazyn', purchase: 'zakup' };
    let rows = '', i = 0;
    for (const g of n.result.groups) for (const b of g.bars) {
      const lotId = R.barLotId(n, b), lot = lotId ? db.bars.find(x => x.id === lotId) : null, need = barNeed(n, g, b);
      let cell;
      if (b.source.kind === 'remnant' && (lotId && !(b.report && b.report.lotId))) cell = `<span title="Dziedziczony po odpadzie ${esc(b.source.id)}">${esc(lotLabel(lotId))}</span>`;
      else if (b.source.kind === 'remnant' && !lotId && R.origin(b.source.id)) { const o = R.origin(b.source.id); cell = `<span class="muted" title="Odpad ${esc(b.source.id)} – Nr mag. pojawi się po zgłoszeniu sztangi, z której powstał">czeka: ${esc(o.n.no)} ${esc(barGroupOf(o.n, o.b))} #${o.b.no}</span>`; }
      else cell = `<input data-cut="${i++}" data-g="${esc(g.key)}" data-no="${b.no}" list="lotList" value="${esc(lotLabel(b.report && b.report.lotId))}" placeholder="wpisz Nr mag."><button class="mini" data-cutdown="${esc(g.key)}|${b.no}" title="Ten sam Nr mag. dla kolejnych niezgłoszonych sztang tego materiału (do wyczerpania stanu)">↓</button>`;
      rows += `<tr data-lot-profile="${esc(g.profile)}" data-lot-grade="${esc(g.grade)}" data-lot-len="${b.source.length}" data-lot-code="${esc(need.code)}" data-lot-kind="${b.source.kind}">
        <td class="t nowrap"><b>${esc(g.profile)} #${b.no}</b></td><td class="t">${esc(g.grade)}${need.code ? ` <span class="chip code">${esc(need.code)}</span>` : ''}</td>
        <td class="t">${SRC[b.source.kind]}${b.source.kind === 'remnant' ? ' ' + esc(b.source.id) : ''}</td><td class="n t">${fmt(b.source.length)}</td><td class="n t">${b.placements.length}</td>
        <td class="cutcell">${cell}</td><td class="t">${lot ? esc(lot.heat || '—') : ''}</td><td class="t">${lot ? esc(lot.cert || '—') : ''}</td>
        <td class="t">${b.report && b.report.date ? esc(b.report.date) : lotId ? 'z odpadu' : '<span class="muted">nie zgłoszono</span>'}</td></tr>`;
    }
    return `<details class="cutbox" ${c.todo ? 'open' : ''}><summary><b>Zgłoszenie cięcia</b> – zgłoszono ${c.all - c.todo} z ${c.all} sztang${c.todo ? ` · <span style="color:#b02a1a">${c.todo} bez Nr mag.</span>` : ' ✓'}</summary>
      <div class="hint" style="margin:4px 0 6px">Wpisz Nr mag. z zapisu operatora (Enter – następna sztanga). Stan partii zmniejsza się przy zgłoszeniu${n.lotMode ? '' : ' (ten nesting zatwierdzono przed wprowadzeniem partii – zgłoszenie nie zmienia stanu)'}; odpady z tej sztangi dziedziczą Nr mag.</div>
      <table class="grid cuttable"><thead><tr><th>Sztanga</th><th>Gatunek / kod</th><th>Źródło</th><th class="n">Długość</th><th class="n">Detali</th><th style="width:210px">Nr mag.</th><th>Wytop</th><th>Certyfikat</th><th>Zgłoszono</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }
  async function applyCut(n, inp) {
    const g = n.result.groups.find(x => x.key === inp.dataset.g), b = g && g.bars.find(x => x.no === Number(inp.dataset.no));
    if (!b) return;
    const err = setBarLot(n, g, b, inp.value.trim());
    if (err) { cutFocus = null; inp.classList.add('bad'); inp.title = err.replace(/<[^>]+>/g, ''); await info('Nie można zgłosić', err); inp.focus(); return false; }
    renderStock();
    await afterArchiveChange(n);
    return true;
  }
  function fillDown(n, key) {
    const [gk, no] = [key.slice(0, key.lastIndexOf('|')), Number(key.slice(key.lastIndexOf('|') + 1))];
    const g = n.result.groups.find(x => x.key === gk), b0 = g && g.bars.find(x => x.no === no);
    const lot = b0 && b0.report && db.bars.find(x => x.id === b0.report.lotId);
    if (!lot) { info('Brak Nr mag.', 'Najpierw zgłoś Nr mag. dla tej sztangi – zostanie powielony na kolejne.'); return; }
    let done = 0, after = false;
    for (const gg of n.result.groups) for (const b of gg.bars) {
      if (b === b0) { after = true; continue; }
      if (!after || b.source.kind === 'remnant' || (b.report && b.report.lotId)) continue;
      if (!lotFitsBar(lot, barNeed(n, gg, b))) continue;
      if (setBarLot(n, gg, b, lot.lot)) break;          // koniec stanu partii albo niezgodność
      done++;
    }
    renderStock();
    afterArchiveChange(n);
    if (!done) info('Nic nie zgłoszono', `Brak kolejnych niezgłoszonych sztang pasujących do partii ${esc(lot.lot)} albo partia nie ma już stanu.`);
  }
  $('#archiveDetail').addEventListener('change', e => {
    const n = project.nestings.find(x => x.id === archiveSel);
    if (e.target.dataset.cut != null && n) { applyCut(n, e.target); return; }
    if (e.target.dataset.idf === 'okOnly') { identFilter.okOnly = e.target.checked; renderIdentTable(); }
  });
  // filtry wpisywane z ręki (fragment tekstu, bez wielkości liter) – odświeżana tylko tabela, fokus zostaje w polu
  $('#archiveDetail').addEventListener('input', e => {
    const k = e.target.dataset.idf; if (!k || k === 'okOnly') return;
    identFilter[k] = e.target.value; renderIdentTable();
  });
  $('#archiveDetail').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.dataset.cut == null) return;
    e.preventDefault();
    cutFocus = Number(e.target.dataset.cut) + 1;
    e.target.blur();                                         // change → zapis i przerysowanie, fokus na następnej sztandze
    if (!e.target.isConnected) return;
    const next = $('#archiveDetail').querySelectorAll('input[data-cut]')[cutFocus];
    if (next) { cutFocus = null; next.focus(); next.select(); }
  });

  // ---------- raport identyfikacji materiałowej ----------
  /** Wiersze: detal × partia (Nr mag.) × status, z listą nestingów i sztang. */
  function identRows(f) {
    const R = resolver(), map = new Map();
    for (const n of project.nestings) {
      const has = (v, q) => !q || String(v || '').toUpperCase().includes(String(q).trim().toUpperCase());
      if (!has(n.no, f.n)) continue;
      for (const g of n.result.groups) for (const b of g.bars) {
        if (!has(g.profile, f.prof)) continue;
        const lotId = R.barLotId(n, b), lot = lotId ? db.bars.find(x => x.id === lotId) : null;
        for (const p of b.placements) {
          const st = p.scrapped ? 'scrap' : lotId ? 'ok' : 'todo';
          if (f.okOnly && st !== 'ok') continue;
          if (f.part && !has((partById(p.partId) || p).name, f.part)) continue;
          const k = [p.partId, lotId, st].join('|');
          if (!map.has(k)) {
            const part = partById(p.partId) || { name: p.name };
            map.set(k, { partId: p.partId, name: part.name || p.name, profile: g.profile, grade: g.grade, qty: 0, where: [], lot: lot ? lot.lot || '(bez numeru)' : '',
              heat: lot ? lot.heat : '', cert: lot ? lot.cert : '', maker: lot ? lot.maker : '', status: st });
          }
          const row = map.get(k); row.qty++;
          const w = `${n.no} ${g.profile} #${b.no}`; if (!row.where.includes(w)) row.where.push(w);
        }
      }
    }
    const order = { ok: 0, todo: 1, scrap: 2 };
    return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl', { numeric: true }) || order[a.status] - order[b.status] || a.lot.localeCompare(b.lot));
  }
  const ST_LABEL = { ok: 'zgłoszono', todo: 'nie zgłoszono', scrap: 'zezłomowany' };
  function renderIdent() {
    const det = $('#archiveDetail');
    const uniq = a => Array.from(new Set(a.filter(Boolean))).sort((x, y) => String(x).localeCompare(String(y), 'pl', { numeric: true }));
    const parts = uniq(project.nestings.flatMap(n => Object.keys(n.used || {})).map(id => (partById(id) || {}).name));
    const profs = uniq(project.nestings.flatMap(n => n.result.groups.map(g => g.profile)));
    const opts = (id, list) => `<datalist id="${id}">${list.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
    const f = identFilter;
    det.innerHTML = `<div class="pane-head"><h2>Identyfikacja materiałowa</h2><div class="actions"><button data-identx="pdf">PDF…</button><button data-identx="csv">CSV…</button></div></div>
      <div class="row identfilters">
        <label>Nesting <input data-idf="n" list="idfN" value="${esc(f.n)}" placeholder="wszystkie"></label>
        <label>Detal <input data-idf="part" list="idfP" value="${esc(f.part)}" placeholder="wszystkie"></label>
        <label>Profil <input data-idf="prof" list="idfR" value="${esc(f.prof)}" placeholder="wszystkie"></label>
        <label class="check" style="margin:0"><input type="checkbox" data-idf="okOnly" ${f.okOnly ? 'checked' : ''} style="width:auto"> tylko zgłoszone</label>
        <button data-idfclear="1" class="mini" title="Wyczyść filtry">✕ filtry</button>
        <span id="identInfo"></span>
        ${opts('idfN', project.nestings.map(n => n.no))}${opts('idfP', parts)}${opts('idfR', profs)}</div>
      <div id="identTable"></div>`;
    renderIdentTable();
  }
  function renderIdentTable() {
    const rows = identRows(identFilter);
    const todo = rows.filter(r => r.status === 'todo').reduce((t, r) => t + r.qty, 0);
    $('#identInfo').innerHTML = todo ? `<span class="chip tight">${todo} szt. bez zgłoszonego Nr mag.</span>` : '';
    $('#identTable').innerHTML = rows.length ? `<table class="grid"><thead><tr><th>Detal</th><th>Profil</th><th>Gatunek</th><th class="n">Szt.</th><th>Nesting / sztanga</th><th>Nr mag.</th><th>Wytop (Heat No.)</th><th>Nr certyfikatu</th><th>Producent</th><th>Status</th></tr></thead><tbody>` +
      rows.map(r => `<tr class="${r.status === 'ok' ? '' : r.status === 'scrap' ? 'done' : 'todo'}"><td class="t"><span class="sw" style="background:${colorOf(r.partId)}"></span> <b>${esc(r.name)}</b></td><td class="t">${esc(r.profile)}</td><td class="t">${esc(r.grade)}</td><td class="n t">${r.qty}</td>
        <td class="t">${esc(r.where.join(', '))}</td><td class="t"><b>${esc(r.lot || '—')}</b></td><td class="t">${esc(r.heat || '')}</td><td class="t">${esc(r.cert || '')}</td><td class="t">${esc(r.maker || '')}</td><td class="t">${ST_LABEL[r.status]}</td></tr>`).join('') + '</tbody></table>'
      : `<div class="empty">${project.nestings.length ? 'Brak pozycji dla wybranych filtrów.' : 'Brak zatwierdzonych nestingów do pokazania.'}</div>`;
  }
  function identTitle() {
    const f = identFilter;
    return [f.n && 'nesting: ' + f.n.trim(), f.part && 'detal: ' + f.part.trim(), f.prof && 'profil: ' + f.prof.trim(), f.okOnly && 'tylko zgłoszone'].filter(Boolean).join(' · ');
  }
  async function identExport(kind) {
    const rows = identRows(identFilter), base = [project.meta.number || project.meta.name || 'projekt', identTitle()].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, '-');
    if (kind === 'csv') {
      const out = [['Detal', 'Profil', 'Gatunek', 'Szt.', 'Nesting / sztanga', 'Nr mag.', 'Wytop', 'Nr certyfikatu', 'Producent', 'Status']]
        .concat(rows.map(r => [r.name, r.profile, r.grade, r.qty, r.where.join(', '), r.lot, r.heat, r.cert, r.maker, ST_LABEL[r.status]]));
      await api.exportText(out.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(';')).join('\r\n'), 'Identyfikacja materiałowa ' + base + '.csv', 'csv');
    } else {
      await api.exportPdf(report.buildIdentReport(project.meta, rows.map(r => Object.assign({}, r, { statusLabel: ST_LABEL[r.status] })), identTitle(), `Wygenerowano w programie ${APP}.`), 'Identyfikacja materiałowa ' + base);
    }
  }
  function openIdent() { archiveSel = IDENT; archPick = null; showTab('archive'); }
  $('#archiveDetail').addEventListener('click', e => {
    const x = e.target.closest('[data-identx]'); if (x) { identExport(x.dataset.identx); return; }
    if (e.target.closest('[data-idfclear]')) { identFilter = { n: '', part: '', prof: '', okOnly: false }; renderIdent(); return; }
    const d = e.target.closest('[data-cutdown]'); if (d) { const n = project.nestings.find(y => y.id === archiveSel); if (n) fillDown(n, d.dataset.cutdown); }
  });

  // ---------- złomowanie detalu i cofnięcie zatwierdzenia ----------
  const scrappedIn = n => { const out = []; for (const g of n.result.groups) for (const b of g.bars) for (const p of b.placements) if (p.scrapped) out.push(p); return out; };
  function archTarget(n) {
    if (!archPick) return {};
    const g = n.result.groups.find(x => x.key === archPick.key), b = g && g.bars.find(x => x.no === archPick.no);
    return { g, b, p: b && b.placements[archPick.i] };
  }
  function archToolbar(n) {
    const { g, b, p } = archTarget(n);
    if (!p) { archPick = null;
      return `<div class="editbar idle">Kliknij detal na planie, żeby go zezłomować. Zezłomowany detal wraca do puli pozostałych do wycięcia; zużyty materiał i odpad użytkowy się nie zmieniają.</div>`; }
    const sc = p.scrapped;
    return `<div class="editbar"><span class="sw" style="background:${colorOf(p.partId)}"></span><b>${esc(p.name)}</b>
      <span>${fmt(p.L)} mm · ${esc(g.profile)} · sztanga #${b.no}, pozycja ${archPick.i + 1}${sc ? ` · <b style="color:#b02a1a">zezłomowany ${esc(sc.date)}${sc.reason ? ' – ' + esc(sc.reason) : ''}</b>` : ''}</span>
      ${sc ? '<button data-arch="unscrap">Cofnij złomowanie</button>' : '<button data-arch="scrap" class="danger">Zezłomuj detal…</button>'}
      <button data-arch="unpick" class="x" title="Odznacz">✕</button></div>`;
  }
  async function afterArchiveChange(n) {
    setDirty(true);
    renderArchive(); renderParts(); renderCart();
    if (reportNestingId === n.id) renderReport();
    await saveProject(false);
  }
  async function scrapPiece(n) {
    const { b, p } = archTarget(n); if (!p || p.scrapped) return;
    const ok = await modal('Zezłomować detal?', `<p><b>${esc(p.name)}</b> (${fmt(p.L)} mm) – ${esc(n.no)}, sztanga #${b.no}, pozycja ${archPick.i + 1}.</p>
      <p>Detal wróci do puli pozostałych do wycięcia. Zużyty materiał i odpad użytkowy z tej sztangi się nie zmieniają.</p>
      <div class="form" style="grid-template-columns:130px 1fr"><label>Powód (opcjonalnie)</label><input id="scrapReason" placeholder="np. zły kąt cięcia"></div>`,
      [{ label: 'Anuluj', value: false }, { label: 'Zezłomuj', value: true, primary: true }]);
    if (!ok) return;
    p.scrapped = { date: new Date().toLocaleDateString('pl-PL'), reason: ($('#scrapReason').value || '').trim() };
    n.used[p.partId] = Math.max(0, (n.used[p.partId] || 0) - 1);
    await afterArchiveChange(n);
  }
  async function unscrapPiece(n) {
    const { p } = archTarget(n); if (!p || !p.scrapped) return;
    const part = partById(p.partId);
    if (!part || remainingOf(part) < 1) {
      info('Nie można cofnąć złomowania', `Sztuka „${esc(part ? part.name : p.name)}” jest już ponownie przydzielona – w koszyku albo w innym nestingu. Zmniejsz ilość w koszyku albo cofnij tamten nesting.`);
      return;
    }
    delete p.scrapped;
    n.used[p.partId] = (n.used[p.partId] || 0) + 1;
    await afterArchiveChange(n);
  }
  async function revertNesting(n) {
    const created = [];
    for (const g of n.result.groups) for (const b of g.bars) if (b.savedRemnantId) created.push(b.savedRemnantId);
    const missing = created.filter(id => !db.remnants.some(x => x.id === id));
    if (missing.length) {
      const why = missing.map(id => {
        const m = project.nestings.find(x => x !== n && x.result.groups.some(gg => gg.bars.some(bb => bb.source.kind === 'remnant' && bb.source.id === id)));
        return `${id} – ${m ? 'zużyty w ' + m.no : 'usunięty z magazynu'}`;
      });
      info('Nie można cofnąć zatwierdzenia', `Odpady użytkowe utworzone przez ${esc(n.no)} nie leżą już w magazynie:<br><b>${esc(why.join('; '))}</b>.<br>Najpierw cofnij nestingi, które je zużyły (albo przywróć odpady w magazynie).`);
      return;
    }
    const st = n.result.groups.reduce((t, g) => t + g.stats.fromStock, 0), rm = n.result.groups.reduce((t, g) => t + g.stats.fromRemnants, 0);
    const pcs = n.result.summary.parts, sc = scrappedIn(n).length;
    let rep = 0, repS = 0;
    for (const g of n.result.groups) for (const b of g.bars) if (b.report && b.report.lotId && b.source.kind !== 'remnant') { rep++; if (b.source.kind === 'stock') repS++; }
    const cartN = project.cart.reduce((t, c) => t + c.qty, 0);
    const ok = await confirmBox(`Cofnąć zatwierdzenie ${n.no}?`, `<ul>
      <li>${n.lotMode ? `${st - repS ? `rezerwacja <b>${st - repS}</b> sztang zostanie zwolniona` : ''}${st - repS && rep ? ', a ' : ''}${rep ? `<b>${rep}</b> sztang zgłoszonych jako wycięte wróci do swoich partii` : ''}${st || rep ? '' : 'sztangi: bez zmian'}` : `na magazyn wróci <b>${st}</b> sztang`} i <b>${rm}</b> odpadów użytkowych,</li>
      <li>z magazynu zostanie usuniętych <b>${created.length}</b> odpadów utworzonych przez ten nesting,</li>
      ${cartN ? `<li><b style="color:#b02a1a">bieżący koszyk (${cartN} szt.)${project.result ? ' i jego wynik roboczy' : ''} zostanie opróżniony bez zapisywania,</b></li>` : ''}
      <li>${esc(n.no)} otworzy się w zakładce „4. Nesting” jako wariant roboczy, a jego detale (<b>${pcs}</b> szt.) trafią do koszyka –
        można go poprawić i zatwierdzić ponownie (dostanie nowy numer),</li>
      <li>w historii magazynu ${esc(n.no)} zostanie oznaczony jako cofnięty.</li></ul>
      ${sc ? `<p><b style="color:#b02a1a">W tym nestingu jest ${sc} szt. zezłomowanych detali, więc cięcie się odbyło.</b> Cofnięcie zwróci cały materiał na magazyn, tak jakby nesting nie został wycięty; zezłomowane sztuki wrócą do planu jako zwykłe.</p>` : ''}`, 'Cofnij zatwierdzenie');
    if (!ok) return;
    // lokalizacje odpadów zapisanych przy zatwierdzeniu – wrócą jako ustawienia w otwartym nestingu
    const savedLoc = {};
    for (const g of n.result.groups) for (const b of g.bars) if (b.savedRemnantId) {
      const rec = db.remnants.find(x => x.id === b.savedRemnantId); savedLoc[b.savedRemnantId] = rec ? rec.location || '' : '';
    }
    const res = catalog.revertCommit(project.stock, n, geo.plainEnd, new Date().toLocaleDateString('sv-SE'));
    if (!res.ok) return;
    bindStock();
    project.nestings = project.nestings.filter(x => x !== n);
    if (reportNestingId === n.id) reportNestingId = null;
    archiveSel = null; archPick = null; availability = null;
    const dropped = reopenNesting(n, savedLoc);
    setDirty(true);
    renderParts(); renderCart(); renderStock(); renderArchive(); renderOptions(); renderResult(); renderReport();
    showTab('nest');
    if (dropped.length) await info('Część sztuk usunięto z planu', `Zezłomowane sztuki zostały w międzyczasie przydzielone do innych nestingów, więc nie wróciły do tego planu: <b>${esc(dropped.join(', '))}</b>.`);
    await saveProject(false);
  }

  /**
   * Otwiera cofnięty nesting jako wariant roboczy: plan jak przy zatwierdzeniu, detale w koszyku,
   * zezłomowane sztuki z powrotem jako zwykłe (o ile nie zostały już przydzielone gdzie indziej).
   */
  function reopenNesting(n, savedLoc) {
    const r = JSON.parse(JSON.stringify(n.result));
    project.cart = []; project.result = null; keep = {}; sel = null;
    const count = {};
    for (const g of r.groups) for (const b of g.bars) for (const p of b.placements) count[p.partId] = (count[p.partId] || 0) + 1;
    const dropped = [];
    for (const id of Object.keys(count)) {
      const part = partById(id), free = part ? Math.max(0, (Number(part.qty) || 0) - usedOf(id)) : 0;
      let extra = count[id] - free;
      // nadmiar usuwany z planu: najpierw sztuki zezłomowane, potem od końca
      for (const scrappedFirst of [true, false]) for (const g of r.groups) for (const b of g.bars.slice().reverse()) {
        for (let i = b.placements.length - 1; i >= 0 && extra > 0; i--) {
          const p = b.placements[i];
          if (p.partId !== id || !!p.scrapped !== scrappedFirst) continue;
          b.placements.splice(i, 1); extra--; count[id]--; dropped.push(p.name); b._touched = true;
        }
      }
    }
    for (const g of r.groups) {
      g.loose = []; g.unplaced = [];
      for (const b of g.bars) { for (const p of b.placements) delete p.scrapped; b._saved = b.savedRemnantId; delete b.savedRemnantId; delete b.report; }
      g.bars = g.bars.filter(b => b.placements.length || !b._touched);
    }
    r.warnings = (r.warnings || []).filter(w => !/nie rozmieszczono/.test(w));
    r.reopenedFrom = n.no;
    project.revisionOf = { baseNo: n.baseNo || n.no, revision: (n.revision || 0) + 1, from: n.no };
    if (dropped.length) r.edited = true;
    project.result = r;
    project.options = Object.assign({}, nesting.DEFAULTS, r.options);
    project.cart = Object.keys(count).filter(id => count[id] > 0).map(id => ({ partId: id, qty: count[id] }));
    for (const g of r.groups) for (const b of g.bars) if (b._touched) { delete b._touched; E.relayoutBar(b, ectx(g), r.options); }
    E.recompute(r);
    syncResult();
    // odpady użytkowe: zaznaczone i z lokalizacją tak jak przy zatwierdzeniu
    for (const g of r.groups) for (const b of g.bars) {
      if (b.remnant > 0) keep[g.key + '#' + b.uid] = { on: !!b._saved, location: b._saved ? savedLoc[b._saved] || '' : (b.source.location || '') };
      delete b._saved;
    }
    return dropped;
  }
  $('#tab-archive').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-n]');
    if (tr) { if (archiveSel !== tr.dataset.n) archPick = null; archiveSel = tr.dataset.n; renderArchive(); return; }
    const poly = e.target.closest('polygon[data-pl]'), card = e.target.closest('[data-ag]');
    if (poly && card) { archPick = { key: card.dataset.ag, no: Number(card.dataset.ano), i: Number(poly.dataset.pl) }; renderArchive(); return; }
    const b = e.target.closest('[data-arch]'); if (!b) return;
    const n = project.nestings.find(x => x.id === archiveSel);
    const own = { scrap: () => scrapPiece(n), unscrap: () => unscrapPiece(n), revert: () => revertNesting(n), unpick: () => { archPick = null; renderArchive(); } }[b.dataset.arch];
    if (own) { if (n) own(); return; }
    reportNestingId = archiveSel; renderReport();
    if (b.dataset.arch === 'report') showTab('report');
    if (b.dataset.arch === 'pdf') exportPdf();
    if (b.dataset.arch === 'csv') exportCsv();
  });

  // ---------- raport ----------
  /** Źródło raportu: wybrany zatwierdzony nesting albo wynik roboczy koszyka. */
  function reportData() {
    const n = reportNestingId && project.nestings.find(x => x.id === reportNestingId);
    if (n) {
      ensureShapes(n.result);
      // kopia z numerami magazynowymi sztang (zgłoszenie cięcia albo odpad) do nagłówków planu
      const R = resolver(), res = JSON.parse(JSON.stringify(n.result));
      res.groups.forEach((g, gi) => g.bars.forEach((b, bi) => { b.lotLabel = lotLabel(R.barLotId(n, n.result.groups[gi].bars[bi])); }));
      return { proj: { meta: Object.assign({}, n.meta), parts: n.items, committed: true, date: n.date, no: n.no }, result: res, label: n.no };
    }
    if (project.result) return ensureShapes(project.result) && { proj: { meta: project.meta, parts: cartParts(), committed: false, no: nextNo() + ' (wariant roboczy)' }, result: project.result, label: 'roboczy' };
    return null;
  }
  const reportHtml = d => report.buildReport(d.proj, d.result, colorOf, `Wygenerowano w programie ${APP}.`);
  function renderReport() {
    if (reportNestingId && !project.nestings.some(n => n.id === reportNestingId)) reportNestingId = null;
    updateToolbar();
    $('#reportPick').innerHTML = `<option value="">bieżący koszyk (wariant roboczy)</option>` +
      project.nestings.slice().reverse().map(n => `<option value="${n.id}" ${n.id === reportNestingId ? 'selected' : ''}>${esc(n.no)} · ${esc(n.date)} (zatwierdzony)</option>`).join('');
    const d = reportData();
    $('#reportFrame').srcdoc = d ? reportHtml(d) : '<body style="font-family:Segoe UI,Arial;color:#666;padding:40px;text-align:center">Raport pojawi się po uruchomieniu nestingu dla koszyka. Raporty zatwierdzonych nestingów wybierzesz z listy powyżej.</body>';
  }
  $('#reportPick').addEventListener('change', e => { reportNestingId = e.target.value || null; renderReport(); });
  const fileBase = d => [project.meta.number || project.meta.name || 'nesting', d && d.label !== 'roboczy' ? d.label : ''].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, '-');
  const noReport = () => info('Brak wyniku', 'Uruchom nesting dla koszyka albo wybierz zatwierdzony nesting w zakładce „6. Baza nestingów”.');
  async function exportPdf() {
    const d = reportData(); if (!d) { noReport(); return; }
    await api.exportPdf(reportHtml(d), 'Raport nestingu ' + fileBase(d));
  }
  async function exportCsv() {
    const d = reportData(); if (!d) { noReport(); return; }
    const rows = [['Profil', 'Gatunek', 'Kod mat.', 'Sztanga', 'Źródło', 'Nr mag.', 'Długość sztangi', 'Lp', 'Detal', 'Długość', 'Od', 'Do', 'Lewy koniec', 'Prawy koniec', 'Ułożenie', 'Uwagi']];
    for (const g of d.result.groups) for (const b of g.bars) b.placements.forEach((p, i) => rows.push([g.profile, g.grade, b.source.code || '', b.no,
      { remnant: 'odpad ' + b.source.id, stock: 'magazyn', purchase: 'zakup' }[b.source.kind], b.lotLabel || '', b.source.length, i + 1, p.name, p.L, Math.round(p.x0), Math.round(p.x1),
      report.endText(p.left, g.shape), report.endText(p.right, g.shape), geo.describeMove(p),
      p.scrapped ? `zezłomowany ${p.scrapped.date}${p.scrapped.reason ? ' – ' + p.scrapped.reason : ''}` : '']));
    await api.exportText(rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n'), 'Lista cięć ' + fileBase(d) + '.csv', 'csv');
  }

  // ---------- projekt ----------
  function loadProject(data, path) {
    project = Object.assign(newProject(), data);
    project.meta = Object.assign({ name: '', number: '', author: '' }, data.meta);
    project.options = Object.assign({}, nesting.DEFAULTS, data.options);
    project.parts = (data.parts || []).map(p => {
      // pliki sprzed reguł obrotu: zablokowany obrót lub przewrócenie = detal kierunkowy
      const q = Object.assign({}, p, { end1: geo.normalizeEnd(p.end1), end2: geo.normalizeEnd(p.end2),
        fixed: p.fixed === true || p.allowRev === false || p.allowFlip === false });
      delete q.allowRev; delete q.allowFlip;
      return q;
    });
    project.nestings = Array.isArray(data.nestings) ? data.nestings : [];
    project.seq = Object.assign({ nesting: project.nestings.length + 1 }, data.seq);
    project.cart = Array.isArray(data.cart) ? data.cart.filter(c => project.parts.some(p => p.id === c.partId) && c.qty > 0) : [];
    // pliki z wersji 0.1 (bez koszyka): zatwierdzony wynik → baza nestingów, roboczy → koszyk
    if (!Array.isArray(data.cart) && data.result) {
      if (data.committedAt) { archiveNesting(data.result, project.parts, project.meta, 0); project.result = null; }
      else project.cart = project.parts.filter(p => p.qty > 0).map(p => ({ partId: p.id, qty: p.qty }));
    }
    delete project.committedAt;
    // magazyn w projekcie; plik ze starszej wersji dostaje jednorazowo stan z dawnej wspólnej bazy
    let migrated = false;
    if (data.stock) {
      project.stock = Object.assign(emptyStock(), data.stock);
      for (const k of ['bars', 'remnants', 'history']) if (!Array.isArray(project.stock[k])) project.stock[k] = [];
      project.stock.seq = Object.assign({ bar: 1, remnant: 1, job: 1 }, data.stock.seq);
    } else {
      project.stock = legacyStock ? JSON.parse(JSON.stringify(legacyStock)) : emptyStock();
      migrated = project.stock.bars.length + project.stock.remnants.length > 0;
    }
    for (const b of project.stock.bars) if (!b.id) b.id = catalog.newBarId(project.stock);
    catalog.normalizeLots(project.stock.bars);
    // wynik roboczy sprzed partii: sztangi wskazywały wiersz magazynu – teraz pulę
    if (project.result) for (const g of project.result.groups) for (const b of g.bars) {
      if (b.source.kind !== 'stock' || String(b.source.id).startsWith('P|')) continue;
      const row = project.stock.bars.find(x => x.id === b.source.id);
      b.source.id = catalog.poolKey({ profile: g.profile, grade: g.grade, code: row ? row.code : b.source.code, length: b.source.length });
    }
    bindStock();
    projectPath = path; selectedId = project.parts.length ? project.parts[0].id : null; availability = null; keep = {};
    reportNestingId = null; archiveSel = null;
    sel = null; syncResult();
    renderAll(); setDirty(migrated);
    if (migrated) info('Magazyn przeniesiony do projektu', 'Ten projekt pochodzi z wcześniejszej wersji programu. Stan magazynu (sztangi, odpady użytkowe, historia) został skopiowany ze wspólnej bazy do projektu – zapisz projekt, żeby to utrwalić.');
  }
  async function openRecent() {
    const list = await api.projectRecent();
    if (!list.length) { info('Otwórz ostatnie', 'Lista ostatnio używanych projektów jest pusta.'); return; }
    const r = await modal('Otwórz ostatnie', '<div class="recent">' + list.map((f, i) =>
      `<button data-pick="${i}"><b>${esc(f.name)}</b><span>${esc(f.path)}</span><span>${new Date(f.mtime).toLocaleString('pl-PL')}</span></button>`).join('') + '</div>', [{ label: 'Anuluj', value: null }]);
    if (!r || !(await confirmDiscard())) return;
    const res = await api.projectOpenPath(list[Number(r.pick)].path);
    if (!res || !res.data || res.data.app !== 'nesting-profili') { info('Nie można otworzyć', 'Pliku nie ma już na dysku albo nie jest projektem nestingu.'); return; }
    loadProject(res.data, res.path); showTab('parts');
  }
  async function saveProject(asNew) {
    const p = await api.projectSave(project, asNew ? null : projectPath, fileBase(null));
    if (p) { projectPath = p; setDirty(false); }
  }
  function renderAll() {
    tv.resetAll();
    $('#metaName').value = project.meta.name; $('#metaNumber').value = project.meta.number; $('#metaAuthor').value = project.meta.author;
    renderParts(); renderCart(); renderStock(); renderOptions(); renderResult(); renderReport(); renderArchive();
  }
  [['metaName', 'name'], ['metaNumber', 'number'], ['metaAuthor', 'author']].forEach(([id, k]) =>
    $('#' + id).addEventListener('input', e => { project.meta[k] = e.target.value; setDirty(true); }));

  // ---------- akcje ----------
  const ACTIONS = {
    new: async () => { if (await confirmDiscard()) { project = newProject(); bindStock(); projectPath = null; selectedId = null; availability = null; keep = {}; sel = null; reportNestingId = null; archiveSel = null; renderAll(); setDirty(false); showTab('parts'); } },
    open: async () => {
      if (!(await confirmDiscard())) return;
      const r = await api.projectOpen(); if (!r) return;
      if (!r.data || r.data.app !== 'nesting-profili') { info('Nie można otworzyć', 'To nie jest plik projektu nestingu.'); return; }
      loadProject(r.data, api.desktop ? r.path : null); showTab('parts');
    },
    recent: openRecent,
    save: () => saveProject(false), saveas: () => saveProject(true),
    check: checkMaterial, nest: runNesting, commit,
    pdf: exportPdf, csv: exportCsv, ident: () => openIdent(),
    'part-add': () => { addPart(); const i = document.querySelector('#partsTable tr.sel input[data-f="name"]'); if (i) { i.focus(); i.select(); } },
    'part-dup': () => { const p = selected(); if (p) addPart(JSON.parse(JSON.stringify(Object.assign({}, p, { name: p.name + ' (kopia)' })))); },
    'part-import': () => openImport('parts'),
    'lot-import': () => openImport('lots'),
    'part-clear': async () => {
      if (!project.parts.length) return;
      if (project.nestings.length) { info('Nie można wyczyścić', 'Projekt ma zatwierdzone nestingi – detale użyte w nich muszą zostać na liście. Usuń pojedyncze, nieużyte detale przyciskiem ✕.'); return; }
      if (await confirmBox('Wyczyścić listę?', 'Wszystkie detale zostaną usunięte z projektu i z koszyka.', 'Wyczyść')) { project.parts = []; project.cart = []; selectedId = null; changed(true); renderParts(); }
    },
    'cart-all': () => {
      // przy włączonym filtrze listy do koszyka idą tylko widoczne detale
      const hidden = new Set(Array.from(document.querySelectorAll('#partsTable tr.vhide')).map(tr => tr.dataset.id));
      let n = 0; for (const p of project.parts) if (!hidden.has(p.id)) n += addToCart(p.id);
      if (n) { changed(true); refreshCounts(); showTab('cart'); }
      else info('Koszyk', (hidden.size ? 'Wśród detali widocznych po filtrze nie' : 'Nie') + ' ma już sztuk do przeniesienia – wszystkie są w koszyku albo w zatwierdzonych nestingach.');
    },
    'cart-clear': () => { if (project.cart.length) { project.cart = []; project.revisionOf = null; changed(true); renderCart(); } },
    'bar-add': () => receiveLot(),
    'rem-add': () => { tv.reset('remWrap'); db.remnants.push({ id: catalog.newRemnantId(db), profile: '', grade: 'S355', length: 1000, location: '', source: 'ręcznie', date: new Date().toLocaleDateString('sv-SE') }); changed(true); renderStock(); focusLast('#remWrap'); },
    'prof-add': () => { tv.reset('profWrap'); $('#profFilter').value = ''; db.profiles.push({ name: 'NOWY', type: '', shape: 'I', h: 100, b: 100, kgm: 0 }); saveDbSoon(); renderStock(); renderLists(); focusLast('#profWrap'); },
    'db-choose': async () => { if (await api.dbChoose('open')) await loadDb(); },
    'db-reveal': () => api.dbReveal(),
    'cat-info': catalogInfo, 'db-reload': loadDb,
  };
  function focusLast(sel) {
    const rows = document.querySelectorAll(sel + ' tbody tr'); const tr = rows[rows.length - 1];
    if (tr) { tr.scrollIntoView({ block: 'nearest' }); const i = tr.querySelector('input'); if (i) { i.focus(); i.select(); } }
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const fn = ACTIONS[b.dataset.act]; if (fn) fn();
  });
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveProject(e.shiftKey); }
    if (k === 'o') { e.preventDefault(); ACTIONS.open(); }
    if (k === 'n') { e.preventDefault(); ACTIONS.new(); }
  });
  window.addEventListener('beforeunload', e => { if (dirty && !api.desktop) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- start ----------
  (async function init() {
    bindStock();
    renderAll(); setDirty(false);
    await loadDb();
    renderParts();
    // detale, koszyk i baza nestingów są w pliku projektu – po starcie wraca ostatnio używany
    const last = api.projectLast ? await api.projectLast() : null;
    if (last && last.data && last.data.app === 'nesting-profili') loadProject(last.data, last.path);
  })();

  window.__nestApp = { get project() { return project; }, get db() { return db; }, loadProject, runNesting, addToCart, usedOf, remainingOf };
})();
