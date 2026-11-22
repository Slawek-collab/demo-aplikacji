/*
 * Katalog profili (startowy) i operacje na bazie materiałów.
 * Wymiary h, b w mm, masa w kg/m – wartości nominalne z tablic; katalog można edytować w aplikacji.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.catalog = m; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [oznaczenie, h, b, kg/m]
  const RAW = {
    IPE: [[80, 80, 46, 6.0], [100, 100, 55, 8.1], [120, 120, 64, 10.4], [140, 140, 73, 12.9], [160, 160, 82, 15.8],
      [180, 180, 91, 18.8], [200, 200, 100, 22.4], [220, 220, 110, 26.2], [240, 240, 120, 30.7], [270, 270, 135, 36.1],
      [300, 300, 150, 42.2], [330, 330, 160, 49.1], [360, 360, 170, 57.1], [400, 400, 180, 66.3], [450, 450, 190, 77.6],
      [500, 500, 200, 90.7], [550, 550, 210, 106], [600, 600, 220, 122]],
    HEA: [[100, 96, 100, 16.7], [120, 114, 120, 19.9], [140, 133, 140, 24.7], [160, 152, 160, 30.4], [180, 171, 180, 35.5],
      [200, 190, 200, 42.3], [220, 210, 220, 50.5], [240, 230, 240, 60.3], [260, 250, 260, 68.2], [280, 270, 280, 76.4],
      [300, 290, 300, 88.3], [320, 310, 300, 97.6], [340, 330, 300, 105], [360, 350, 300, 112], [400, 390, 300, 125],
      [450, 440, 300, 140], [500, 490, 300, 155], [550, 540, 300, 166], [600, 590, 300, 178]],
    HEB: [[100, 100, 100, 20.4], [120, 120, 120, 26.7], [140, 140, 140, 33.7], [160, 160, 160, 42.6], [180, 180, 180, 51.2],
      [200, 200, 200, 61.3], [220, 220, 220, 71.5], [240, 240, 240, 83.2], [260, 260, 260, 93.0], [280, 280, 280, 103],
      [300, 300, 300, 117], [320, 320, 300, 127], [340, 340, 300, 134], [360, 360, 300, 142], [400, 400, 300, 155],
      [450, 450, 300, 171], [500, 500, 300, 187], [550, 550, 300, 199], [600, 600, 300, 212]],
    UPN: [[80, 80, 45, 8.64], [100, 100, 50, 10.6], [120, 120, 55, 13.4], [140, 140, 60, 16.0], [160, 160, 65, 18.8],
      [180, 180, 70, 22.0], [200, 200, 75, 25.3], [220, 220, 80, 29.4], [240, 240, 85, 33.2], [260, 260, 90, 37.9],
      [280, 280, 95, 41.8], [300, 300, 100, 46.2]],
  };
  const OTHER = [
    ['L50x5', 'L', 50, 50, 3.77], ['L60x6', 'L', 60, 60, 5.42], ['L70x7', 'L', 70, 70, 7.38], ['L80x8', 'L', 80, 80, 9.63],
    ['L90x9', 'L', 90, 90, 12.2], ['L100x10', 'L', 100, 100, 15.0], ['L120x12', 'L', 120, 120, 21.6], ['L150x15', 'L', 150, 150, 33.8],
    ['RK60x60x4', 'RK', 60, 60, 6.71], ['RK80x80x4', 'RK', 80, 80, 9.22], ['RK100x100x5', 'RK', 100, 100, 14.4],
    ['RK120x120x6', 'RK', 120, 120, 20.7], ['RK150x150x8', 'RK', 150, 150, 34.2], ['RK200x200x8', 'RK', 200, 200, 46.7],
    ['RP100x50x4', 'RP', 100, 50, 8.59], ['RP120x80x5', 'RP', 120, 80, 14.4], ['RP200x100x6', 'RP', 200, 100, 26.4],
    ['RO88.9x5', 'RO', 88.9, 88.9, 10.3], ['RO114.3x6.3', 'RO', 114.3, 114.3, 16.8], ['RO168.3x8', 'RO', 168.3, 168.3, 31.6],
  ];

  /** Typy przekroju – decydują o ikonie w katalogu i o krawędziach na podglądzie detalu. */
  const SHAPES = [
    { id: 'I', label: 'dwuteownik' }, { id: 'C', label: 'ceownik' }, { id: 'L', label: 'kątownik' },
    { id: 'box', label: 'profil zamknięty' }, { id: 'O', label: 'rura okrągła' },
    { id: 'rod', label: 'lity pręt' },
  ];
  /** Typ przekroju odgadnięty z nazwy (dla profili bez ustawionego typu). */
  function guessShape(name) {
    const n = String(name || '').trim().toUpperCase();
    if (/^(PRĘT|PRET|PR\s*(Ø|FI))/.test(n)) return 'rod';
    if (/^(RO|CHS|RURA|OD|Ø|FI)/.test(n)) return 'O';
    if (/^(RK|RP|SHS|RHS|KW|PR)/.test(n)) return 'box';
    if (/^(UPN|UPE|UE|U|C)/.test(n)) return 'C';
    if (/^L/.test(n)) return 'L';
    return 'I';
  }

  function defaultProfiles() {
    const out = [];
    for (const type of Object.keys(RAW)) for (const [n, h, b, kgm] of RAW[type]) out.push({ name: type + n, type, shape: guessShape(type), h, b, kgm });
    for (const [name, type, h, b, kgm] of OTHER) out.push({ name, type, shape: guessShape(name), h, b, kgm });
    return out;
  }

  const GRADES = ['S235', 'S275', 'S355', 'S420', 'S460'];

  function emptyDb() {
    return { version: 1, profiles: defaultProfiles(), bars: [], remnants: [], history: [], seq: { bar: 1, remnant: 1, job: 1 } };
  }

  function normalizeDb(db) {
    const d = Object.assign(emptyDb(), db || {});
    if (!Array.isArray(d.profiles) || !d.profiles.length) d.profiles = defaultProfiles();
    for (const k of ['bars', 'remnants', 'history']) if (!Array.isArray(d[k])) d[k] = [];
    for (const pr of d.profiles) if (!SHAPES.some(x => x.id === pr.shape)) pr.shape = guessShape(pr.name);
    d.seq = Object.assign({ bar: 1, remnant: 1, job: 1 }, d.seq || {});
    return d;
  }


  // ---------- partie (numery magazynowe) i pula materiału ----------
  const up = v => String(v == null ? '' : v).trim().toUpperCase();
  /** Partia = wiersz „Sztangi w magazynie”: Nr mag. (lot), cechy, Przyjęto (qtyIn), Stan (qty), wytop, certyfikat, producent. */
  function normalizeLots(bars) {
    for (const b of bars) {
      if (b.lot == null) b.lot = '';
      if (b.qtyIn == null || b.qtyIn === '') b.qtyIn = Number(b.qty) || 0;
      for (const f of ['heat', 'cert', 'maker']) if (b[f] == null) b[f] = '';
    }
    return bars;
  }
  /** Klucz puli: sztangi wymienne dla nestingu – profil, gatunek, kod materiału, długość. */
  const poolKey = r => ['P', up(r.profile), up(r.grade), up(r.code), Number(r.length) || 0].join('|');
  /** Sztanga zatwierdzonego nestingu, która rezerwuje pulę (zatwierdzona, ale cięcie jeszcze niezgłoszone). */
  const reserves = (n, b) => n.lotMode && b.source.kind === 'stock' && !(b.report && b.report.lotId);
  /** Rezerwacje puli z zatwierdzonych nestingów: { klucz puli: liczba sztang }. */
  function reservedByPool(nestings) {
    const out = {};
    for (const n of nestings || []) for (const g of n.result.groups) for (const b of g.bars)
      if (reserves(n, b)) out[b.source.id] = (out[b.source.id] || 0) + 1;
    return out;
  }
  /**
   * Pule materiału dla nestingu: suma stanów partii o tych samych cechach minus rezerwacje.
   * Zwraca listę { id, profile, grade, code, length, stock, reserved, qty, location, lots }.
   */
  function pools(bars, nestings) {
    const res = reservedByPool(nestings), map = new Map();
    for (const b of bars) {
      if (!b.profile || !(Number(b.length) > 0)) continue;
      const k = poolKey(b);
      if (!map.has(k)) map.set(k, { id: k, profile: String(b.profile).trim(), grade: String(b.grade || '').trim(), code: String(b.code || '').trim(),
        length: Number(b.length), stock: 0, reserved: res[k] || 0, qty: 0, location: '', lots: [] });
      const p = map.get(k);
      p.stock += Math.max(0, Number(b.qty) || 0); p.lots.push(b);
    }
    for (const [k, n] of Object.entries(res)) if (!map.has(k)) {
      const [, profile, grade, code, length] = k.split('|');
      map.set(k, { id: k, profile, grade, code, length: Number(length), stock: 0, reserved: n, qty: 0, location: '', lots: [] });
    }
    for (const p of map.values()) {
      p.qty = p.stock - p.reserved;
      const locs = Array.from(new Set(p.lots.filter(l => Number(l.qty) > 0).map(l => String(l.location || '').trim()).filter(Boolean)));
      p.location = locs.join(', ');
    }
    return Array.from(map.values());
  }
  /** Partia po Nr mag. (bez wielkości liter i spacji na końcach). */
  const lotByNo = (bars, no) => (up(no) ? bars.find(b => up(b.lot) === up(no)) || null : null);

  /**
   * Ustalanie partii (Nr mag.) dla sztangi z planu i dla odpadu użytkowego.
   * Sztanga ze sztangi magazynowej / zakupu – partia ze zgłoszenia cięcia; sztanga z odpadu – partia odpadu.
   * Odpad – wpisana ręcznie albo partia sztangi, z której powstał (także przez kolejne odpady).
   */
  function lotResolver(stock, nestings) {
    const origin = {};
    for (const n of nestings || []) for (const g of n.result.groups) for (const b of g.bars) if (b.savedRemnantId) origin[b.savedRemnantId] = { n, b };
    const byId = {};
    for (const l of stock.bars) byId[l.id] = l;
    function barLotId(n, b, depth) {
      if (b.report && b.report.lotId) return b.report.lotId;
      if (b.source.kind !== 'remnant') return '';
      const rec = stock.remnants.find(r => r.id === b.source.id) || (n.consumed || []).find(r => r.id === b.source.id);
      return remnantLotId(b.source.id, rec, (depth || 0) + 1);
    }
    function remnantLotId(id, rec, depth) {
      if (rec && rec.lotId) return rec.lotId;
      if ((depth || 0) > 50) return '';
      const o = origin[id];
      return o ? barLotId(o.n, o.b, (depth || 0) + 1) : '';
    }
    return {
      barLotId, remnantLotId, lot: id => byId[id] || null, origin: id => origin[id] || null,
    };
  }

  /** Mapa profili po nazwie (wielkie litery) – wejście dla silnika nestingu. */
  function profileMap(db) {
    const m = {};
    for (const p of db.profiles) m[String(p.name).trim().toUpperCase()] = p;
    return m;
  }

  const pad = (n, w) => String(n).padStart(w, '0');
  const newBarId = db => 'SZ-' + pad(db.seq.bar++, 4);
  const newRemnantId = db => 'OU-' + pad(db.seq.remnant++, 4);

  /**
   * Zatwierdzenie nestingu w magazynie: zdejmuje zużyte sztangi i odpady,
   * dopisuje wybrane nowe odpady użytkowe oraz wpis do historii.
   * keep: lista { groupKey, barNo, location } – odpady, które użytkownik chce zapisać.
   */
  function commitResult(db, result, meta, keep) {
    const log = { removedRemnants: [], usedBars: 0, addedRemnants: [], missing: [] };
    const keepMap = new Map(keep.map(k => [k.groupKey + '#' + k.barNo, k]));
    const date = new Date().toLocaleDateString('sv-SE');
    for (const g of result.groups) {
      for (const b of g.bars) {
        if (b.source.kind === 'remnant') {
          const i = db.remnants.findIndex(r => r.id === b.source.id);
          if (i >= 0) { db.remnants.splice(i, 1); log.removedRemnants.push(b.source.id); }
          else log.missing.push(`odpad ${b.source.id}`);
        } else if (b.source.kind === 'stock' && meta.lotMode) {
          // tryb partii: sztanga jest tylko zarezerwowana z puli – stan partii maleje przy zgłoszeniu cięcia
          log.reserved = (log.reserved || 0) + 1;
        } else if (b.source.kind === 'stock') {
          const s = db.bars.find(x => x.id === b.source.id);
          if (s && s.qty > 0) { s.qty -= 1; log.usedBars++; }
          else log.missing.push(`sztanga ${g.profile} ${b.source.length} mm`);
        }
        const k = keepMap.get(g.key + '#' + b.no);
        if (k && b.remnant > 0) {
          const sh = b.squareRemnant || !b.remnantShape ? { length: b.remnant } : b.remnantShape;   // obcięty na prosto albo z kształtem
          const r = {
            id: newRemnantId(db), profile: g.profile, grade: g.grade, length: sh.length,
            location: k.location || '', source: meta.name || meta.number || '', date,
          };
          if (b.source.code) r.code = b.source.code;            // odpad dziedziczy kod materiału sztangi
          // kształt końców: odpad pamięta skośne lico po cięciu, żeby kolejny nesting mógł je wykorzystać
          if (sh.end1 && sh.end1.type !== 'square') r.end1 = sh.end1;
          if (sh.end2 && sh.end2.type !== 'square') r.end2 = sh.end2;
          db.remnants.push(r); log.addedRemnants.push(r);
          b.savedRemnantId = r.id;
        }
      }
    }
    if (!meta.lotMode) db.bars = db.bars.filter(b => b.qty > 0);   // partie zostają także po wyczerpaniu
    db.history.unshift({
      id: db.seq.job++, date, name: meta.name || '', number: meta.number || '', nestingNo: meta.no || '',
      parts: result.summary.parts, bars: result.summary.bars,
      material: Math.round(result.summary.material), scrap: Math.round(result.summary.scrap),
      remnantsUsed: log.removedRemnants.length, remnantsAdded: log.addedRemnants.length,
    });
    db.history = db.history.slice(0, 200);
    return log;
  }

  /**
   * Cofnięcie zatwierdzenia nestingu w magazynie: sztangi i zużyte odpady wracają, odpady utworzone przez nesting
   * są usuwane, wpis w historii dostaje znacznik „cofnięty”. Zablokowane, gdy któregoś utworzonego odpadu nie ma
   * już w magazynie (zużyty w późniejszym nestingu albo usunięty ręcznie) – wtedy zwraca { ok: false, missing }.
   * plainEnd: funkcja zamieniająca koniec zorientowany na zwykły opis (z geometry.js).
   */
  function revertCommit(db, n, plainEnd, date) {
    const r = n.result, created = [];
    for (const g of r.groups) for (const b of g.bars) if (b.savedRemnantId) created.push(b.savedRemnantId);
    const missing = created.filter(id => !db.remnants.some(x => x.id === id));
    if (missing.length) return { ok: false, missing };
    const log = { removedRemnants: created, restoredRemnants: [], restoredBars: 0 };
    db.remnants = db.remnants.filter(x => !created.includes(x.id));
    const snap = {};
    for (const rec of n.consumed || []) snap[rec.id] = rec;
    const square = e => !e || e.type === 'square';
    const copy = o => JSON.parse(JSON.stringify(o));
    for (const g of r.groups) for (const b of g.bars) {
      const s = b.source;
      if (s.kind === 'remnant' && !db.remnants.some(x => x.id === s.id)) {
        // kopia zapisana przy zatwierdzeniu; dla starszych nestingów odpad odtwarzany z planu
        let rec = snap[s.id] ? copy(snap[s.id]) : null;
        if (!rec) {
          rec = { id: s.id, profile: g.profile, grade: g.grade, length: s.length, location: s.location || '', source: 'przywrócony – cofnięto ' + n.no, date };
          if (s.code) rec.code = s.code;
          const e1 = plainEnd(s.left), e2 = plainEnd(s.right);
          if (!square(e1)) rec.end1 = e1;
          if (!square(e2)) rec.end2 = e2;
        }
        db.remnants.push(rec);
        log.restoredRemnants.push(s.id);
      }
      if (n.lotMode) {
        // tryb partii: zwrot tylko sztang zgłoszonych jako wycięte – do partii ze zgłoszenia
        if ((s.kind === 'stock' || s.kind === 'purchase') && b.report && b.report.lotId) {
          const row = db.bars.find(x => x.id === b.report.lotId);
          if (row) { row.qty = Number(row.qty) + 1; log.restoredBars++; }
        }
        continue;
      }
      if (s.kind === 'stock') {
        const row = db.bars.find(x => x.id === s.id);
        if (row) row.qty = Number(row.qty) + 1;
        else {
          const base = (n.stockRows || {})[s.id];
          db.bars.push(Object.assign(base ? copy(base) : { id: s.id, profile: g.profile, grade: g.grade, length: s.length, location: s.location || '', code: s.code || '' }, { qty: 1 }));
        }
        log.restoredBars++;
      }
    }
    const h = db.history.find(x => (n.historyId != null ? x.id === n.historyId : (x.nestingNo === n.no || String(x.name).endsWith(n.no))));
    if (h) h.reverted = date;
    return Object.assign({ ok: true }, log);
  }

  return { SHAPES, guessShape, defaultProfiles, GRADES, revertCommit, emptyDb, normalizeDb, profileMap, newBarId, newRemnantId, commitResult,
    normalizeLots, poolKey, reservedByPool, pools, lotByNo, lotResolver };
});
