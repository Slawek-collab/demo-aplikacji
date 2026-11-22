/*
 * Import listy detali z arkusza: wykrycie wiersza nagłówka, dopasowanie kolumn, odczyt liczb w formatach
 * spotykanych w polskich arkuszach, rozpoznawanie zapisów profili, walidacja, sumowanie powtórzeń
 * i scalanie z detalami, które już są w projekcie. Czysta logika – bez DOM, testowana w Node.
 */
(function (root, factory) {
  const geo = (typeof module === 'object' && module.exports) ? require('./geometry.js') : root.NEST.geometry;
  const m = factory(geo);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.importmap = m; }
})(typeof self !== 'undefined' ? self : this, function (geo) {
  'use strict';

  /** Pola detalu i nagłówki, po których są rozpoznawane (porównanie bez polskich znaków i jednostek). */
  const FIELDS = [
    { id: 'name', label: 'Nazwa / znak', req: true,
      syn: ['nazwa', 'znak', 'pozycja', 'poz', 'nr poz', 'nr pozycji', 'numer', 'nr', 'mark', 'element', 'detal', 'oznaczenie', 'nazwa detalu', 'part', 'name', 'symbol'] },
    { id: 'profile', label: 'Profil', req: true,
      syn: ['profil', 'przekroj', 'profile', 'section', 'ksztaltownik', 'wymiar profilu', 'typ profilu'] },
    { id: 'grade', label: 'Gatunek',
      syn: ['gatunek', 'material', 'stal', 'grade', 'gatunek stali', 'klasa stali'] },
    { id: 'code', label: 'Kod materiału',
      syn: ['kod materialu', 'kod mat', 'article no', 'article number', 'art no', 'art nr', 'nr artykulu', 'numer artykulu',
        'indeks materialu', 'material code', 'material no', 'material number', 'mat no', 'artikelnummer'] },
    { id: 'length', label: 'Długość [mm]', req: true,
      syn: ['dlugosc', 'dl', 'l', 'length', 'dlug', 'dlugosc detalu'] },
    { id: 'qty', label: 'Ilość [szt.]', req: true,
      syn: ['ilosc', 'il', 'szt', 'sztuk', 'qty', 'quantity', 'liczba', 'ilosc sztuk', 'liczba sztuk'] },
    { id: 'angle1', label: 'Kąt początku [°]',
      syn: ['kat poczatku', 'kat pocz', 'kat 1', 'kat1', 'skos 1', 'skos1', 'skos poczatku', 'skos pocz', 'angle 1', 'angle start', 'start angle', 'kat lewy'] },
    { id: 'angle2', label: 'Kąt końca [°]',
      syn: ['kat konca', 'kat kon', 'kat 2', 'kat2', 'skos 2', 'skos2', 'skos konca', 'skos kon', 'angle 2', 'angle end', 'end angle', 'kat prawy'] },
    { id: 'plane', label: 'Płaszczyzna skosów (h/b)',
      syn: ['plaszczyzna', 'plaszczyzna skosu', 'plaszczyzna ciecia', 'plane'] },
  ];
  /** Układ kolumn bez nagłówka – taki jak przy dotychczasowym wklejaniu. */
  const POSITIONAL = { name: 0, profile: 1, grade: 2, length: 3, qty: 4, angle1: 5, angle2: 6, plane: -1, code: -1 };

  const fold = s => String(s == null ? '' : s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[.:;#°*/\\_-]/g, ' ').replace(/\s+/g, ' ').trim();

  /** Jak bardzo nagłówek pasuje do pola: 3 – dokładnie, 2 – zaczyna się od synonimu, 0 – nie pasuje. */
  function headerScore(text, field) {
    const t = fold(text);
    if (!t) return 0;
    let best = 0;
    for (const s of field.syn) {
      if (t === s) return 3;
      if (s.length > 2 && (t.startsWith(s + ' ') || t.startsWith(s))) best = Math.max(best, 2);
    }
    return best;
  }

  /** Wiersz nagłówka: ten z pierwszych 30, w którym rozpoznano najwięcej pól (co najmniej 2); -1 = brak. */
  function detectHeaderRow(rows, fields) {
    fields = fields || FIELDS;
    let best = -1, bestN = 1;
    for (let r = 0; r < Math.min(30, rows.length); r++) {
      const cells = rows[r] || [];
      const n = fields.filter(f => cells.some(c => headerScore(c, f) >= 2)).length;
      if (n > bestN) { best = r; bestN = n; }
    }
    return best;
  }

  /** Dopasowanie kolumn do pól na podstawie nagłówka; bez nagłówka – układ jak przy wklejaniu. */
  function autoMap(rows, headerRow, fields, positional) {
    fields = fields || FIELDS; positional = positional || (fields === FIELDS ? POSITIONAL : {});
    const map = {};
    for (const f of fields) map[f.id] = -1;
    if (headerRow < 0) {
      const width = Math.max(0, ...rows.slice(0, 50).map(r => (r || []).length));
      for (const f of fields) map[f.id] = positional[f.id] != null && positional[f.id] >= 0 && positional[f.id] < width ? positional[f.id] : -1;
      return map;
    }
    const cells = rows[headerRow] || [], cand = [];
    fields.forEach(f => cells.forEach((c, i) => { const s = headerScore(c, f); if (s >= 2) cand.push({ f: f.id, i, s }); }));
    cand.sort((a, b) => b.s - a.s || a.i - b.i);
    const usedCol = new Set();
    for (const c of cand) if (map[c.f] < 0 && !usedCol.has(c.i)) { map[c.f] = c.i; usedCol.add(c.i); }
    return map;
  }

  /** Liczba z komórki: „2 100,5”, „2100 mm”, „45°”, liczba z Excela. NaN, gdy nie da się odczytać. */
  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean' || v == null) return NaN;
    let s = String(v).replace(/[\s  ]/g, '').replace(/(mm|szt\.?|sztuk|°|st\.?)$/i, '');
    if (!s) return NaN;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');   // 1.250,5 → 1250,5
    s = s.replace(',', '.');
    return /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
  }

  /**
   * Zapis profilu → nazwa z katalogu. Rozpoznaje m.in. „HE 200 B” = HEB200, „L 100x100x10” = L100x10,
   * „IPE 200” = IPE200, wielkość liter i spacje bez znaczenia.
   */
  function normalizeProfile(raw, catalogNames) {
    const text = String(raw == null ? '' : raw).trim();
    const key = s => String(s).toUpperCase().replace(/[\s_]/g, '').replace(/[×*]/g, 'X').replace(/,/g, '.');
    const idx = {};
    for (const n of catalogNames || []) idx[key(n)] = n;
    const k = key(text);
    if (!k) return { name: '', known: false, changed: false };
    const tries = [k,
      k.replace(/^HE(\d+)([ABM])$/, 'HE$2$1'),                                   // HE200B → HEB200
      k.replace(/^L(\d+(?:\.\d+)?)X\1X(\d+(?:\.\d+)?)$/, 'L$1X$2'),               // L100X100X10 → L100X10
      k.replace(/^(?:U|C)(\d+)$/, 'UPN$1'),                                        // U200 → UPN200
      k.replace(/^(?:SHS|RK)(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)$/, 'RK$1X$2X$3'),
      k.replace(/^(?:RHS|RP)(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)$/, 'RP$1X$2X$3'),
      k.replace(/^(?:CHS|RO|RURA)(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)$/, 'RO$1X$2')];
    for (const t of tries) if (idx[t]) return { name: idx[t], known: true, changed: idx[t] !== text };
    return { name: text.replace(/\s+/g, ''), known: false, changed: false };
  }

  /** Kąt: dodatni = ścięta krawędź górna, ujemny = dolna, 0 / puste = cięcie proste. */
  function endFrom(v, plane) {
    const a = parseNumber(v);
    if (v === '' || v == null || !isFinite(a) || a === 0) return { end: geo.squareEnd(), error: v !== '' && v != null && !isFinite(a) ? `kąt „${v}” nieczytelny` : '' };
    if (Math.abs(a) > geo.MAX_ANGLE) return { end: geo.squareEnd(), error: `kąt ${a}° większy niż ${geo.MAX_ANGLE}°` };
    return { end: { type: 'miter', angle: Math.abs(a), plane, side: a > 0 ? 'top' : 'bottom', depth: 0 }, error: '' };
  }
  function planeFrom(v) {
    const t = fold(v);
    if (!t) return 'h';
    if (/^(b|polka|poziom|pozioma|flange|top)/.test(t)) return 'b';
    return 'h';
  }

  /**
   * Wiersze arkusza → detale do importu (z błędami i ostrzeżeniami).
   * cfg: { headerRow, map, defaultGrade, qtyDefault1, catalogNames, overrides, skip }
   * overrides: { indeks wiersza: { pole: wartość } } – poprawki wpisane w podglądzie (mają pierwszeństwo przed arkuszem),
   * skip: Set indeksów wierszy pominiętych w podglądzie.
   */
  function buildItems(rows, cfg) {
    const out = [];
    const txt = v => (v == null ? '' : String(v).trim());
    for (let r = cfg.headerRow + 1; r < rows.length; r++) {
      if (cfg.skip && cfg.skip.has(r)) continue;
      const ov = cfg.overrides && cfg.overrides[r];
      const cell = (row, f) => (ov && f in ov ? ov[f] : (cfg.map[f] >= 0 ? row[cfg.map[f]] : ''));
      const row = rows[r] || [];
      const used = FIELDS.map(f => txt(cell(row, f.id)));
      if (used.every(v => v === '')) continue;                                  // pusty wiersz
      const it = { row: r + 1, errors: [], warnings: [], edited: !!ov };
      it.name = txt(cell(row, 'name'));
      if (!it.name) { it.name = 'Wiersz ' + (r + 1); it.warnings.push('brak nazwy – nadano „' + it.name + '”'); }
      const pr = normalizeProfile(cell(row, 'profile'), cfg.catalogNames);
      it.profile = pr.name;
      if (!pr.name) it.errors.push('brak profilu');
      else if (!pr.known) it.warnings.push('profilu „' + pr.name + '” nie ma w katalogu');
      else if (pr.changed) it.note = '„' + txt(cell(row, 'profile')) + '” → ' + pr.name;
      it.grade = txt(cell(row, 'grade')) || cfg.defaultGrade || '';
      it.code = txt(cell(row, 'code'));
      const L = parseNumber(cell(row, 'length'));
      if (!isFinite(L) || L <= 0) it.errors.push(txt(cell(row, 'length')) ? `długość „${txt(cell(row, 'length'))}” nieczytelna` : 'brak długości');
      it.length = isFinite(L) && L > 0 ? Math.round(L * 10) / 10 : 0;
      const qRaw = txt(cell(row, 'qty')), q = parseNumber(cell(row, 'qty'));
      if (!qRaw && cfg.qtyDefault1) { it.qty = 1; it.warnings.push('brak ilości – przyjęto 1 szt.'); }
      else if (!isFinite(q) || q <= 0 || Math.abs(q - Math.round(q)) > 1e-9) { it.qty = 0; it.errors.push(qRaw ? `ilość „${qRaw}” nieprawidłowa` : 'brak ilości'); }
      else it.qty = Math.round(q);
      const plane = planeFrom(cell(row, 'plane'));
      const e1 = endFrom(cell(row, 'angle1'), plane), e2 = endFrom(cell(row, 'angle2'), plane);
      it.end1 = e1.end; it.end2 = e2.end;
      if (e1.error) it.errors.push('początek: ' + e1.error);
      if (e2.error) it.errors.push('koniec: ' + e2.error);
      out.push(it);
    }
    return out;
  }

  const sig = it => [String(it.name).trim().toUpperCase(), String(it.profile).toUpperCase(), String(it.grade).toUpperCase(), String(it.code || '').trim().toUpperCase(), it.length,
    JSON.stringify(geo.normalizeEnd(it.end1)), JSON.stringify(geo.normalizeEnd(it.end2))].join('|');

  const DIFF = 'ta sama nazwa ma w arkuszu różną geometrię';
  /** Sumuje powtórzenia tej samej pozycji (nazwa, profil, gatunek, kod materiału, długość, końce); wiersze z błędami zostają osobno. */
  function aggregate(items) {
    const byKey = new Map(), out = [];
    for (const it of items) {
      if (it.errors.length) { out.push(it); continue; }
      const k = sig(it);
      if (byKey.has(k)) { const a = byKey.get(k); a.qty += it.qty; a.rows.push(it.row); a.edited = a.edited || it.edited; a.warnings = Array.from(new Set(a.warnings.concat(it.warnings))); continue; }
      const a = Object.assign({}, it, { rows: [it.row] });
      byKey.set(k, a); out.push(a);
    }
    // ta sama nazwa z inną geometrią – osobne detale, ale warto o tym wiedzieć
    const names = {};
    for (const it of out) if (!it.errors.length) (names[it.name.toUpperCase()] = names[it.name.toUpperCase()] || []).push(it);
    for (const list of Object.values(names)) if (list.length > 1) for (const it of list) if (!it.warnings.includes(DIFF)) it.warnings.push(DIFF);
    return out;
  }

  const MODES = [
    { id: 'add', label: 'dodaj ilość, jeśli detal jest taki sam (inna geometria = nowy detal)' },
    { id: 'replace', label: 'zastąp danymi z arkusza (detal o tej samej nazwie)' },
    { id: 'skip', label: 'pomiń detale o nazwach, które już są' },
    { id: 'new', label: 'zawsze dodawaj jako nowe' },
  ];

  /**
   * Plan scalenia z detalami projektu. usedOf(id) – sztuki w zatwierdzonych nestingach.
   * Zwraca { add: [nowe detale], update: [{ id, set, note }], skip: [{ item, why }] }.
   */
  function planMerge(items, existing, mode, usedOf) {
    const ok = items.filter(it => !it.errors.length);
    const plan = { add: [], update: [], skip: [] };
    const byName = {};
    for (const p of existing) (byName[String(p.name).trim().toUpperCase()] = byName[String(p.name).trim().toUpperCase()] || []).push(p);
    const pending = {};                                                   // kolejne pozycje trafiające w ten sam istniejący detal
    for (const it of ok) {
      const same = byName[it.name.toUpperCase()] || [];
      if (mode === 'new' || !same.length) { plan.add.push(it); continue; }
      if (mode === 'skip') { plan.skip.push({ item: it, why: 'detal o tej nazwie już jest' }); continue; }
      if (mode === 'add') {
        const p = same.find(x => sig(x) === sig(it));
        if (!p) { plan.add.push(it); continue; }
        const u = pending[p.id] || (pending[p.id] = { id: p.id, set: { qty: Number(p.qty) || 0 }, note: '' });
        u.set.qty += it.qty;
        continue;
      }
      // replace: pierwszy detal o tej nazwie dostaje dane z arkusza
      const p = same[0], used = usedOf(p.id) || 0;
      const u = { id: p.id, set: { qty: it.qty }, note: '' };
      const geomChanged = sig(Object.assign({}, p, { name: it.name })) !== sig(it);
      if (geomChanged && used > 0) u.note = `już użyty w nestingach (${used} szt.) – zmieniono tylko ilość, profil/długość/końce bez zmian`;
      else if (geomChanged) Object.assign(u.set, { profile: it.profile, grade: it.grade, code: it.code || '', length: it.length, end1: it.end1, end2: it.end2 });
      if (u.set.qty < used) { u.note = (u.note ? u.note + '; ' : '') + `ilość nie może być mniejsza niż użyte ${used} szt.`; u.set.qty = used; }
      if (pending[p.id]) { pending[p.id].set.qty += it.qty; continue; }    // druga pozycja o tej nazwie – sumuj
      pending[p.id] = u;
    }
    plan.update = Object.values(pending);
    return plan;
  }

  /** Zwykły tekst rozdzielany tabulatorami / średnikami / przecinkami (wklejenie z Excela, plik CSV). */
  function parseDelimited(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
    const sample = lines.slice(0, 20).join('\n');
    const count = ch => (sample.match(new RegExp(ch === '\t' ? '\\t' : '\\' + ch, 'g')) || []).length;
    const sep = ['\t', ';', ','].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [], cellBuf = '', q = false;
    const src = lines.join('\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"' && src[i + 1] === '"') { cellBuf += '"'; i++; }
        else if (ch === '"') q = false;
        else cellBuf += ch;
      } else if (ch === '"' && cellBuf === '') q = true;
      else if (ch === sep) { row.push(cellBuf); cellBuf = ''; }
      else if (ch === '\n') { row.push(cellBuf); rows.push(row); row = []; cellBuf = ''; }
      else cellBuf += ch;
    }
    if (cellBuf !== '' || row.length) { row.push(cellBuf); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every(c => String(c).trim() === '')) rows.pop();
    return rows;
  }

  /** Litera kolumny arkusza: 0 → A, 26 → AA. */
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }


  // ---------- import przyjęć magazynowych (partie z numerem magazynowym) ----------
  const F = id => FIELDS.find(f => f.id === id);
  const LOT_FIELDS = [
    { id: 'lot', label: 'Nr mag. (Code no.)', req: true,
      syn: ['nr mag', 'nr magazynowy', 'numer magazynowy', 'kod magazynowy', 'code no', 'code number', 'nr partii', 'numer partii', 'partia', 'lot', 'lot no', 'batch', 'batch no'] },
    Object.assign({}, F('profile'), { req: true }),
    F('grade'),
    { id: 'code', label: 'Kod mat. (article no)', syn: F('code').syn },
    Object.assign({}, F('length'), { req: true }),
    Object.assign({}, F('qty'), { req: true }),
    { id: 'heat', label: 'Wytop (Heat No.)', syn: ['wytop', 'nr wytopu', 'numer wytopu', 'heat', 'heat no', 'heat number', 'nr wyt'] },
    { id: 'cert', label: 'Nr certyfikatu', syn: ['certyfikat', 'nr certyfikatu', 'numer certyfikatu', 'atest', 'nr atestu', 'swiadectwo', 'certificate', 'cert no', 'certificate no', 'cert'] },
    { id: 'maker', label: 'Producent', syn: ['producent', 'huta', 'wytworca', 'dostawca', 'manufacturer', 'maker', 'mill', 'supplier', 'producer'] },
    { id: 'date', label: 'Data przyjęcia', syn: ['data przyjecia', 'data dostawy', 'data przyj', 'data', 'date', 'delivery date', 'received', 'data pz'] },
    { id: 'location', label: 'Lokalizacja', syn: ['lokalizacja', 'miejsce skladowania', 'miejsce', 'regal', 'location', 'polozenie'] },
  ];
  /** Data z komórki → rrrr-mm-dd (liczba z Excela, dd.mm.rrrr, rrrr-mm-dd); inaczej tekst bez zmian. */
  function isoDate(v) {
    if (v === '' || v == null) return '';
    const pad = n => String(n).padStart(2, '0');
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const t = String(v).trim();
    let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = t.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    return t;
  }
  /** Wiersze arkusza → partie do przyjęcia. cfg jak w buildItems (headerRow, map, defaultGrade, catalogNames, overrides, skip). */
  function buildLotItems(rows, cfg) {
    const out = [], txt = v => (v == null ? '' : String(v).trim());
    for (let r = cfg.headerRow + 1; r < rows.length; r++) {
      if (cfg.skip && cfg.skip.has(r)) continue;
      const ov = cfg.overrides && cfg.overrides[r];
      const cell = (row, f) => (ov && f in ov ? ov[f] : (cfg.map[f] >= 0 ? row[cfg.map[f]] : ''));
      const row = rows[r] || [];
      if (LOT_FIELDS.every(f => txt(cell(row, f.id)) === '')) continue;
      const it = { row: r + 1, errors: [], warnings: [], edited: !!ov };
      it.lot = txt(cell(row, 'lot'));
      if (!it.lot) it.errors.push('brak Nr mag.');
      const pr = normalizeProfile(cell(row, 'profile'), cfg.catalogNames);
      it.profile = pr.name;
      if (!pr.name) it.errors.push('brak profilu');
      else if (!pr.known) it.warnings.push('profilu „' + pr.name + '” nie ma w katalogu');
      else if (pr.changed) it.note = '„' + txt(cell(row, 'profile')) + '” → ' + pr.name;
      it.grade = txt(cell(row, 'grade')) || cfg.defaultGrade || '';
      it.code = txt(cell(row, 'code'));
      const L = parseNumber(cell(row, 'length'));
      it.length = isFinite(L) && L > 0 ? Math.round(L) : 0;
      if (!it.length) it.errors.push(txt(cell(row, 'length')) ? `długość „${txt(cell(row, 'length'))}” nieczytelna` : 'brak długości');
      const q = parseNumber(cell(row, 'qty'));
      it.qty = isFinite(q) && q > 0 && Math.abs(q - Math.round(q)) < 1e-9 ? Math.round(q) : 0;
      if (!it.qty) it.errors.push(txt(cell(row, 'qty')) ? `ilość „${txt(cell(row, 'qty'))}” nieprawidłowa` : 'brak ilości');
      it.heat = txt(cell(row, 'heat')); it.cert = txt(cell(row, 'cert')); it.maker = txt(cell(row, 'maker'));
      it.date = isoDate(cell(row, 'date')); it.location = txt(cell(row, 'location'));
      out.push(it);
    }
    return out;
  }
  const LOT_ATTRS = ['profile', 'grade', 'code', 'length', 'heat', 'cert', 'maker'];
  const LOT_LABEL = { profile: 'profil', grade: 'gatunek', code: 'kod mat.', length: 'długość', heat: 'wytop', cert: 'certyfikat', maker: 'producent', qtyIn: 'przyjęto', date: 'data przyjęcia' };
  const normV = v => String(v == null ? '' : v).trim().toUpperCase();
  /**
   * Ten sam Nr mag. w kilku wierszach: przy tych samych cechach ilości są sumowane (sztangi wpisane osobno),
   * przy różnych cechach wszystkie te wiersze są błędne (jeden numer = jedna dostawa).
   */
  function aggregateLots(items) {
    const groups = new Map(), out = [];
    for (const it of items) {
      if (it.errors.length) { out.push(Object.assign({ rows: [it.row] }, it)); continue; }
      const k = normV(it.lot);
      if (!groups.has(k)) { const a = Object.assign({ rows: [it.row], parts: [it] }, it); groups.set(k, a); out.push(a); continue; }
      const a = groups.get(k); a.parts.push(it); a.rows.push(it.row);
    }
    for (const a of groups.values()) {
      if (a.parts.length < 2) { delete a.parts; continue; }
      const diff = LOT_ATTRS.filter(f => new Set(a.parts.map(p => normV(p[f]))).size > 1);
      if (diff.length) a.errors.push(`Nr mag. ${a.lot} w kilku wierszach z różnymi cechami (${diff.map(f => LOT_LABEL[f]).join(', ')}) – jeden numer to jedna dostawa`);
      else {
        a.qty = a.parts.reduce((t, p) => t + p.qty, 0);
        a.edited = a.parts.some(p => p.edited);
        a.warnings = Array.from(new Set([].concat(...a.parts.map(p => p.warnings))));
        for (const f of ['date', 'location']) if (!a[f]) a[f] = (a.parts.find(p => p[f]) || {})[f] || '';
        a.summed = a.parts.length;
      }
      delete a.parts;
    }
    return out;
  }
  /**
   * Porównanie z magazynem: nowe partie, identyczne (pomijane – już zaimportowane) i różniące się (do decyzji).
   * Lokalizacja nie jest porównywana (sztangi mogły zostać przeniesione).
   */
  function planLots(items, bars) {
    const plan = { add: [], same: [], diff: [] };
    const byNo = new Map(); for (const b of bars) if (normV(b.lot)) byNo.set(normV(b.lot), b);
    for (const it of items) {
      if (it.errors.length) continue;
      const b = byNo.get(normV(it.lot));
      if (!b) { plan.add.push(it); continue; }
      const changes = [];
      for (const f of LOT_ATTRS) {
        const a = f === 'length' ? Number(b[f]) : normV(b[f]), c = f === 'length' ? Number(it[f]) : normV(it[f]);
        if (a !== c) changes.push({ f, label: LOT_LABEL[f], old: b[f] == null ? '' : b[f], val: it[f] });
      }
      if (Number(b.qtyIn) !== Number(it.qty)) changes.push({ f: 'qtyIn', label: LOT_LABEL.qtyIn, old: b.qtyIn, val: it.qty });
      if (it.date && normV(b.date) !== normV(it.date)) changes.push({ f: 'date', label: LOT_LABEL.date, old: b.date || '', val: it.date });
      if (changes.length) plan.diff.push({ item: it, lot: b, changes }); else plan.same.push({ item: it, lot: b });
    }
    return plan;
  }
  /** Aktualizacja partii danymi z arkusza; zmiana „Przyjęto” zmienia Stan o różnicę (nie poniżej sztuk wydanych). */
  function applyLotChanges(lot, changes) {
    const notes = [];
    for (const c of changes) {
      if (c.f === 'qtyIn') {
        const issued = Number(lot.qtyIn) - Number(lot.qty);
        if (Number(c.val) < issued) { notes.push(`przyjęto ${c.val} szt. to mniej niż już wydane ${issued} szt. – ilość bez zmian`); continue; }
        lot.qty = Number(lot.qty) + Number(c.val) - Number(lot.qtyIn);
        lot.qtyIn = Number(c.val);
      } else lot[c.f] = c.f === 'length' ? Number(c.val) : c.val;
    }
    return notes;
  }

  return { LOT_FIELDS, isoDate, buildLotItems, aggregateLots, planLots, applyLotChanges, FIELDS, MODES, fold, headerScore, detectHeaderRow, autoMap, parseNumber, normalizeProfile, buildItems, aggregate, planMerge, parseDelimited, colName };
});
