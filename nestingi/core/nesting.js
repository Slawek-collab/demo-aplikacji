/*
 * Silnik nestingu 1D profili z uwzględnieniem zazębiania skośnych końców.
 *
 * Metoda: dla każdej grupy (profil + gatunek) budowane są rozwiązania sztanga po sztandze.
 * Każdą sztangę wypełnia plecak (programowanie dynamiczne) na długościach efektywnych,
 * potem kolejność i orientacja detali są układane tak, by końce się zazębiały, a na koniec
 * sztanga jest dopełniana zachłannie. Całość powtarzana z losowymi zaburzeniami
 * (multi-start) – wybierane jest rozwiązanie z najmniejszym złomem.
 */
(function (root, factory) {
  const geo = (typeof module === 'object' && module.exports)
    ? require('./geometry.js') : root.NEST.geometry;
  const m = factory(geo);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.nesting = m; }
})(typeof self !== 'undefined' ? self : this, function (geo) {
  'use strict';

  const DEFAULTS = {
    kerf: 3,              // szerokość rzazu [mm]
    trimStart: 0,         // obcięcie czoła sztangi [mm]
    trimEnd: 0,           // nieużywany koniec sztangi [mm]
    minRemnant: 500,      // minimalna długość odpadu użytkowego [mm]
    preferRemnants: true, // najpierw zużywaj odpady użytkowe
    squareRemnants: false, // odpady ze skośnym końcem obcinaj na prosto (domyślne ustawienie)
    allowPurchase: true,  // brakujący materiał dobierz jako zakup
    purchaseLength: 12000,
    timeLimitMs: 1200,    // czas optymalizacji na grupę
    seed: 12345,
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const groupKey = (profile, grade) => `${String(profile).trim().toUpperCase()}|${String(grade || '').trim().toUpperCase()}`;
  /** Kod materiału (article no) – porównywany bez wielkości liter i spacji na końcach; '' = bez kodu. */
  const normCode = c => String(c == null ? '' : c).trim().toUpperCase();
  /** Czy detal o kodzie partCode może być wycięty z materiału o kodzie srcCode. */
  const codeFits = (partCode, srcCode) => !normCode(partCode) || normCode(partCode) === normCode(srcCode);
  /** Waga detalu z kodem przy wypełnianiu sztangi z kodem – najpierw „swoje” detale, detale bez kodu tylko dopełniają. */
  const CODE_W = 1000;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /** Detal kierunkowy – nie wolno go obracać (zgodność z plikami sprzed wersji z typami profili). */
  const isFixed = p => p.fixed === true || p.allowRev === false || p.allowFlip === false;

  /** Przygotowanie grupy: typy detali, warianty ułożenia, macierz odstępów. */
  function prepareGroup(group, opt) {
    const parts = group.parts, dims = group.dims;
    const types = [], variants = [];
    for (const p of parts) {
      const L = Number(p.length), count = Math.floor(Number(p.qty));
      if (!(L > 0) || !(count > 0)) continue;
      const code = normCode(p.code);
      const t = { idx: types.length, part: p, L, count, variants: [], code, w: code ? CODE_W : 1 };
      const seen = new Set();
      for (const mv of geo.allowedMoves(group.shape, dims, isFixed(p))) {
        const ends = geo.orientedEnds(p, mv.rev, mv.flip, mv.rot);
        const sig = geo.endSignature(ends.left) + '|' + geo.endSignature(ends.right);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const v = {
          idx: variants.length, t: t.idx, rev: mv.rev, flip: mv.flip, rot: mv.rot, ends, L,
          mean: geo.meanSetback(ends.left, dims) + geo.meanSetback(ends.right, dims),
          lastKerf: geo.kerfAlong(opt.kerf, ends.right.e.angle),
        };
        variants.push(v); t.variants.push(v.idx);
      }
      types.push(t);
    }
    const V = variants.length;
    const adv = new Float64Array(V * V), sav = new Float64Array(V * V);
    let anyInterlock = false;
    for (let a = 0; a < V; a++) for (let b = 0; b < V; b++) {
      const r = geo.advance(variants[a].ends.right, variants[b].ends.left, dims, opt.kerf);
      adv[a * V + b] = r.adv; sav[a * V + b] = r.saving;
      if (r.saving > 0) anyInterlock = true;
    }
    for (const t of types) {
      let best = opt.kerf;
      for (const a of t.variants) for (const b of t.variants) best = Math.min(best, adv[a * V + b]);
      t.selfAdv = best;
      t.net = t.L - Math.min.apply(null, t.variants.map(v => variants[v].mean));
    }
    const d0 = opt.trimStart > 0 ? opt.trimStart + opt.kerf : 0;
    return { types, variants, V, adv, sav, anyInterlock, d0, dims };
  }

  /**
   * Początek pierwszego detalu na sztandze. Odpad ze skośnym licem pozwala dosunąć detal o pasującym końcu
   * bez cięcia; przy obcięciu czoła lico jest odcinane prosto za swoim skrajnym punktem.
   */
  function startFor(src, pe, dims, o) {
    const d0 = o.trimStart > 0 ? o.trimStart + o.kerf : 0;
    if (!src || !src.left || geo.isSquare(src.left.e)) return d0;
    return o.trimStart > 0 ? geo.maxSetback(src.left, dims) + d0 : geo.fitInside(src.left, pe, dims);
  }
  /** Dane źródła potrzebne silnikowi: początek dla każdego wariantu detalu i strata na drugim końcu. */
  function prepareSource(g, src, opt) {
    src.rightLoss = src.right ? geo.maxSetback(src.right, g.dims) : 0;
    src.startOff = src.left && !geo.isSquare(src.left.e) ? g.variants.map(v => startFor(src, v.ends.left, g.dims, opt)) : null;
    return src;
  }
  const startOf = (g, src, vi) => (src && src.startOff ? src.startOff[vi] : g.d0);

  /** Kształt i długość gabarytowa odpadu, który zostaje na końcu sztangi (straight = prosty odcinek). */
  function remnantShape(lastRight, src, straight, dims) {
    const end1 = lastRight ? geo.complementEnd(lastRight) : geo.plainEnd(src.left);
    const extra1 = geo.isSquare(end1) ? 0 : geo.maxSetback(lastRight || src.left, dims);
    const end2 = geo.plainEnd(src.right);
    const extra2 = src.right ? geo.maxSetback(src.right, dims) : 0;
    return { length: Math.floor(straight + extra1 + extra2), end1, end2 };
  }

  /** Ułożenie kolejności i orientacji zadanego zestawu detali (minimalna długość łańcucha). */
  function sequence(g, cnt, total, src) {
    const { types, variants, V, adv, d0 } = g;
    if (total === 0) return { seq: [], end: d0 };
    const present = [];
    for (let t = 0; t < types.length; t++) if (cnt[t] > 0) present.push(t);
    if (!g.anyInterlock && !(src && src.startOff)) {
      const seq = [];
      present.sort((a, b) => types[b].L - types[a].L);
      for (const t of present) for (let i = 0; i < cnt[t]; i++) seq.push(types[t].variants[0]);
      let end = startOf(g, src, seq[0]);
      seq.forEach((v, i) => { end += (i ? adv[seq[i - 1] * V + v] : 0) + variants[v].L; });
      return { seq, end };
    }
    let best = null;
    const starts = [];
    for (const t of present) for (const v of types[t].variants) starts.push(v);
    for (const s of starts) {
      const c = cnt.slice();
      const seq = [s]; c[variants[s].t]--;
      let end = startOf(g, src, s) + variants[s].L, last = s;
      for (let n = 1; n < total; n++) {
        let bv = -1, ba = Infinity, bl = 0;
        for (const t of present) {
          if (c[t] <= 0) continue;
          for (const v of types[t].variants) {
            const a = adv[last * V + v];
            if (a < ba - 1e-9 || (a < ba + 1e-9 && types[t].L > bl)) { bv = v; ba = a; bl = types[t].L; }
          }
        }
        seq.push(bv); c[variants[bv].t]--; end += ba + variants[bv].L; last = bv;
      }
      if (!best || end < best.end - 1e-9) best = { seq, end };
    }
    return best;
  }

  /** Plecak: wybór zestawu detali o największej sumie długości mieszczącego się w sztandze. */
  function knapsack(g, counts, limit, opt, rng, noise, src) {
    const { types } = g;
    const d0 = src && src.startOff ? Math.min.apply(null, src.startOff) : g.d0;
    const res = Math.max(1, Math.ceil(limit / 4000));
    const cap = Math.floor((limit - d0 + opt.kerf) / res);
    const pick = new Array(types.length).fill(0);
    if (cap <= 0) return pick;
    const items = [];
    const order = types.map(t => t.idx);
    if (noise > 0) for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]];
    }
    for (const ti of order) {
      const t = types[ti];
      if (counts[ti] <= 0) continue;
      const w = Math.max(1, Math.ceil((t.L + t.selfAdv) / res));
      if (w > cap) continue;
      const val = t.w * t.L * (1 + (noise > 0 ? noise * 0.08 * (rng() - 0.5) : 0));
      let left = Math.min(counts[ti], Math.floor(cap / w)), m = 1;
      while (left > 0) {
        const k = Math.min(m, left);
        items.push({ t: ti, k, w: w * k, v: val * k });
        left -= k; m *= 2;
      }
    }
    const dp = new Float64Array(cap + 1);
    const keep = items.map(() => new Uint8Array(cap + 1));
    items.forEach((it, i) => {
      const kp = keep[i];
      for (let c = cap; c >= it.w; c--) {
        const cand = dp[c - it.w] + it.v;
        if (cand > dp[c] + 1e-9) { dp[c] = cand; kp[c] = 1; }
      }
    });
    let c = cap;
    for (let i = items.length - 1; i >= 0; i--) {
      if (keep[i][c]) { pick[items[i].t] += items[i].k; c -= items[i].w; }
    }
    return pick;
  }

  /** Dopełnienie sztangi: dokładaj na koniec największy detal, który jeszcze się mieści. */
  function topUp(g, seq, end, counts, used, limit, rng, noise, src) {
    const { types, variants, V, adv, sav } = g;
    for (;;) {
      const last = seq.length ? seq[seq.length - 1] : -1;
      let bv = -1, bs = -Infinity, bEnd = 0;
      for (const t of types) {
        if (counts[t.idx] - used[t.idx] <= 0) continue;
        for (const v of t.variants) {
          const e = last < 0 ? startOf(g, src, v) + t.L : end + adv[last * V + v] + t.L;
          if (e > limit + 1e-6) continue;
          let sc = t.w * (t.L + (last < 0 ? 0 : 2 * sav[last * V + v]));
          if (noise > 0) sc *= 1 + noise * (rng() - 0.5);
          if (sc > bs) { bs = sc; bv = v; bEnd = e; }
        }
      }
      if (bv < 0) break;
      seq.push(bv); used[variants[bv].t]++; end = bEnd;
    }
    return end;
  }

  /** Najlepsze wypełnienie jednej sztangi o długości len. */
  function fillBar(g, counts, len, opt, rng, noise, src) {
    const { types, variants } = g;
    const limit = len - opt.trimEnd - (src && src.rightLoss || 0);
    const sumL = seq => seq.reduce((s, v) => s + variants[v].L * types[variants[v].t].w, 0);
    const results = [];

    // 1) plecak + układanie kolejności
    {
      const pick = knapsack(g, counts, limit, opt, rng, noise, src);
      let total = pick.reduce((s, x) => s + x, 0);
      let s = sequence(g, pick, total, src);
      while (total > 0 && s.end > limit + 1e-6) {       // nie mieści się – zdejmij najkrótszy
        let ti = -1;
        for (const t of types) if (pick[t.idx] > 0 && (ti < 0 || t.w < types[ti].w || (t.w === types[ti].w && t.L < types[ti].L))) ti = t.idx;
        pick[ti]--; total--;
        s = sequence(g, pick, total, src);
      }
      const seq = s.seq.slice(), used = pick.slice();
      const end = topUp(g, seq, s.end, counts, used, limit, rng, 0, src);
      results.push({ seq, end, used });
    }
    // 2) czysto zachłannie (dobre przy silnym zazębianiu)
    if (g.anyInterlock || noise > 0) {
      const seq = [], used = new Array(types.length).fill(0);
      const end = topUp(g, seq, g.d0, counts, used, limit, rng, noise, src);
      results.push({ seq, end, used });
    }
    let best = results[0];
    for (const r of results) {
      const a = sumL(r.seq), b = sumL(best.seq);
      if (a > b + 1e-6 || (Math.abs(a - b) <= 1e-6 && r.end < best.end)) best = r;
    }
    return best;
  }

  function finalizeBar(g, source, fill, opt) {
    const { types, variants, V, adv, sav } = g;
    const placements = [];
    let x = fill.seq.length ? startOf(g, source, fill.seq[0]) : g.d0, net = 0;
    fill.seq.forEach((vi, i) => {
      const v = variants[vi], t = types[v.t];
      let saving = 0;
      if (i > 0) { x += adv[fill.seq[i - 1] * V + vi]; saving = sav[fill.seq[i - 1] * V + vi]; }
      placements.push({
        partId: t.part.id, name: t.part.name, x0: x, x1: x + v.L, L: v.L,
        rev: v.rev, flip: v.flip, rot: v.rot, left: v.ends.left, right: v.ends.right,
        saving, net: v.L - v.mean,
      });
      net += v.L - v.mean;
      x += v.L;
    });
    const len = source.length;
    const lastKerf = fill.seq.length ? variants[fill.seq[fill.seq.length - 1]].lastKerf : 0;
    const remnant = Math.max(0, len - opt.trimEnd - (source.rightLoss || 0) - x - lastKerf);
    const usable = remnant >= opt.minRemnant;
    const last = placements[placements.length - 1];
    return {
      source: { kind: source.kind, id: source.id, label: source.label, length: len, location: source.location || '', code: source.code || '',
        left: source.left || null, right: source.right || null, move: source.move || null },
      placements, usedTo: x, net,
      remnant: usable ? Math.floor(remnant) : 0,
      remnantShape: usable ? remnantShape(last ? last.right : null, source, remnant, g.dims) : null,
      scrap: Math.max(0, len - net - (usable ? Math.floor(remnant) : 0)),
      util: net / len,
      saving: placements.reduce((s, p) => s + p.saving, 0),
    };
  }

  /**
   * Budowa rozwiązania sztanga po sztandze. Kod materiału:
   *  faza 1 – dopóki zostały detale z kodem, otwierane są tylko sztangi z tym samym kodem (detale bez kodu je dopełniają);
   *  faza 2 – detale bez kodu: najpierw materiał bez kodu, potem wolny materiał z kodem, na końcu zakup bez kodu.
   */
  function buildSolution(g, sources, opt, rng, noise) {
    const counts = g.types.map(t => t.count);
    const qty = [];
    for (const s of sources) qty[s.pool] = s.qty;          // warianty ułożenia jednego odpadu = jedna sztuka
    const bars = [];
    const masked = code => counts.map((c, t) => (g.types[t].code && g.types[t].code !== code ? 0 : c));
    const codedLeft = new Set();
    g.types.forEach(t => { if (t.code && counts[t.idx] > 0) codedLeft.add(t.code); });
    const bestOf = list => list.reduce((b, c) => (!b || c.value > b.value ? c : b), null);
    for (;;) {
      for (const c of Array.from(codedLeft)) if (!g.types.some(t => t.code === c && counts[t.idx] > 0)) codedLeft.delete(c);
      const coded = codedLeft.size > 0;
      if (!coded && !counts.some((c, t) => c > 0 && !g.types[t].code)) break;
      const seenLen = new Set();
      const cands = [];
      sources.forEach((s, i) => {
        if (qty[s.pool] <= 0) return;
        const sc = s.code || '';
        if (coded ? !codedLeft.has(sc) : (s.kind === 'purchase' && sc)) return;
        const key = s.kind + ':' + s.length + ':' + (s.sig || '') + ':' + sc;
        if (seenLen.has(key)) return;
        seenLen.add(key);
        const cnt = masked(sc);
        if (!coded) g.types.forEach(t => { if (t.code) cnt[t.idx] = 0; });
        const fill = fillBar(g, cnt, s.length, opt, rng, noise, s);
        if (!fill.seq.length) return;
        if (coded && !fill.seq.some(v => g.types[g.variants[v].t].code)) return;   // sztanga z kodem tylko dla „swoich” detali
        const bar = finalizeBar(g, s, fill, opt);
        let value = (bar.net + bar.remnant * 0.6) / s.length;
        if (noise > 0) value *= 1 + noise * 0.3 * (rng() - 0.5);
        cands.push({ i, s, fill, bar, value, kind: s.kind, spare: !coded && !!sc });
      });
      if (!cands.length) {
        if (coded) { codedLeft.clear(); continue; }
        break;
      }
      const pickFrom = list => {
        const rem = list.filter(c => c.kind === 'remnant');
        const stock = list.filter(c => c.kind === 'stock');
        let choice = null;
        if (opt.preferRemnants) {
          const r = bestOf(rem);
          if (r && r.value >= 0.5) choice = r;
        }
        if (!choice) choice = bestOf(opt.preferRemnants ? stock : stock.concat(rem));
        if (!choice) choice = bestOf(rem);
        return choice;
      };
      // materiał z kodem zostawiamy dla „swoich” detali – detale bez kodu biorą go dopiero, gdy brak innego
      let choice = pickFrom(cands.filter(c => !c.spare)) || pickFrom(cands.filter(c => c.spare)) || bestOf(cands.filter(c => c.kind === 'purchase'));
      if (!choice) break;
      qty[choice.s.pool]--;
      choice.fill.used.forEach((u, t) => { counts[t] -= u; });
      bars.push(choice.bar);
      if (coded) {
        // detale z kodem, dla których żadna sztanga z ich kodem nie ma już miejsca, przestają blokować fazę 1
        for (const c of Array.from(codedLeft)) {
          if (!sources.some(s => qty[s.pool] > 0 && (s.code || '') === c)) codedLeft.delete(c);
        }
      }
    }
    const unplaced = [];
    g.types.forEach(t => { if (counts[t.idx] > 0) unplaced.push({ partId: t.part.id, name: t.part.name, length: t.L, count: counts[t.idx], code: t.code }); });
    let cost = 0;
    for (const b of bars) {
      cost += b.scrap + b.remnant * 0.02 + 1;
      if (b.source.kind === 'purchase') cost += b.source.length * 0.05;
    }
    cost += unplaced.reduce((s, u) => s + u.count, 0) * 1e9;
    return { bars, unplaced, cost };
  }

  /** Statystyki jednej grupy – liczone też po ręcznych zmianach planu. */
  function groupStats(bars, opt) {
    bars.forEach((b, i) => { b.no = i + 1; });
    const sum = f => bars.reduce((s, b) => s + f(b), 0);
    const of = kind => bars.filter(b => b.source.kind === kind);
    const st = {
      bars: bars.length, parts: sum(b => b.placements.length), material: sum(b => b.source.length),
      net: sum(b => b.net), remnant: sum(b => b.remnant), scrap: sum(b => b.scrap), saving: sum(b => b.saving),
      over: sum(b => b.over || 0),
      fromRemnants: of('remnant').length, fromStock: of('stock').length, toPurchase: of('purchase').length,
      purchaseLength: of('purchase').reduce((s, b) => s + b.source.length, 0), iterations: 0,
    };
    st.util = st.material > 0 ? st.net / (st.material - st.remnant) : 0;
    return st;
  }

  /** Podsumowanie całego nestingu. */
  function summaryOf(groups) {
    const tot = f => groups.reduce((s, g) => s + f(g), 0);
    return {
      bars: tot(g => g.stats.bars), parts: tot(g => g.stats.parts),
      material: tot(g => g.stats.material), net: tot(g => g.stats.net),
      remnant: tot(g => g.stats.remnant), scrap: tot(g => g.stats.scrap), saving: tot(g => g.stats.saving),
      massMaterial: tot(g => g.stats.material * g.kgm / 1000), massNet: tot(g => g.stats.net * g.kgm / 1000),
      massScrap: tot(g => g.stats.scrap * g.kgm / 1000),
      toPurchase: tot(g => g.stats.toPurchase), over: tot(g => g.stats.over || 0),
      loose: tot(g => (g.loose || []).length),
      unplaced: tot(g => (g.unplaced || []).reduce((s, u) => s + u.count, 0)),
    };
  }

  function nestGroup(group, opt) {
    const g = prepareGroup(group, opt);
    const sources = [];
    let pool = 0;
    // odpady ze skośnym końcem: każde dozwolone ułożenie odpadu to osobny wariant źródła (wspólna sztuka)
    group.remnants.slice().sort((a, b) => a.length - b.length).forEach(r => {
      const pid = pool++, seen = new Set();
      const shaped = !geo.isSquare(geo.normalizeEnd(r.end1)) || !geo.isSquare(geo.normalizeEnd(r.end2));
      const moves = shaped ? geo.allowedMoves(group.shape, group.dims, false) : [{ rev: false, flip: false, rot: false }];
      for (const mv of moves) {
        const ends = geo.orientedEnds(r, mv.rev, mv.flip, mv.rot);
        const sig = shaped ? geo.endSignature(ends.left) + '|' + geo.endSignature(ends.right) : '';
        if (seen.has(sig)) continue;
        seen.add(sig);
        sources.push(prepareSource(g, { kind: 'remnant', id: r.id, label: r.label || ('Odpad ' + r.id), length: Number(r.length), qty: 1, pool: pid,
          location: r.location, code: normCode(r.code), left: shaped ? ends.left : null, right: shaped ? ends.right : null, move: shaped ? mv : null, sig }, opt));
      }
    });
    group.bars.slice().sort((a, b) => a.length - b.length).forEach(b => {
      if (b.qty > 0) sources.push(prepareSource(g, { kind: 'stock', id: b.id, label: 'Magazyn', length: Number(b.length), qty: Math.floor(b.qty), pool: pool++, location: b.location, code: normCode(b.code) }, opt));
    });
    if (opt.allowPurchase && opt.purchaseLength > 0) {
      // zakup: osobno dla każdego kodu z detali (sztanga kupowana pod kod) i bez kodu
      const codes = [''].concat(Array.from(new Set(g.types.map(t => t.code).filter(Boolean))));
      for (const code of codes) {
        sources.push(prepareSource(g, { kind: 'purchase', id: null, label: 'Do zakupu', length: Number(opt.purchaseLength), qty: Infinity, pool: pool++, code }, opt));
      }
    }
    const rng = mulberry32(opt.seed);
    const t0 = now();
    let best = buildSolution(g, sources, opt, rng, 0), iters = 1;
    while (now() - t0 < opt.timeLimitMs && iters < 400) {
      const noise = 0.15 + 0.6 * rng();
      const s = buildSolution(g, sources, opt, rng, noise);
      if (s.cost < best.cost - 1e-6) best = s;
      iters++;
    }
    best.bars.sort((a, b) => {
      const o = { remnant: 0, stock: 1, purchase: 2 };
      return o[a.source.kind] - o[b.source.kind] || b.source.length - a.source.length || b.util - a.util;
    });
    const stats = groupStats(best.bars, opt);
    stats.iterations = iters;
    return { bars: best.bars, unplaced: best.unplaced, stats };
  }

  /** Podział detali i materiału na grupy profil + gatunek. */
  function buildGroups(input) {
    const groups = new Map();
    const get = (profile, grade) => {
      const k = groupKey(profile, grade);
      if (!groups.has(k)) {
        const pr = (input.profiles || {})[String(profile).trim().toUpperCase()] || {};
        groups.set(k, {
          key: k, profile: String(profile).trim(), grade: String(grade || '').trim(),
          dims: { h: Number(pr.h) || 0, b: Number(pr.b) || 0 }, kgm: Number(pr.kgm) || 0, shape: pr.shape || '',
          known: !!pr.h, parts: [], bars: [], remnants: [],
        });
      }
      return groups.get(k);
    };
    for (const p of input.parts || []) if (p.profile && Number(p.length) > 0 && Number(p.qty) > 0) get(p.profile, p.grade).parts.push(p);
    for (const b of input.bars || []) { const k = groupKey(b.profile, b.grade); if (groups.has(k)) groups.get(k).bars.push(b); }
    for (const r of input.remnants || []) { const k = groupKey(r.profile, r.grade); if (groups.has(k)) groups.get(k).remnants.push(r); }
    return Array.from(groups.values());
  }

  /**
   * Szybkie sprawdzenie dostępności materiału (przed nestingiem) – wiersz na grupę profil + gatunek,
   * a przy kodach materiału osobny wiersz na każdy kod. Detale bez kodu mogą też korzystać z nadwyżki materiału z kodem.
   */
  function checkAvailability(input) {
    const opt = Object.assign({}, DEFAULTS, input.options || {});
    const rows = [];
    for (const g of buildGroups(input)) {
      const codes = Array.from(new Set(g.parts.map(p => normCode(p.code)).filter(Boolean))).sort();
      const need = parts => parts.reduce((s, p) => s + Math.floor(p.qty) * (Number(p.length) + opt.kerf), 0);
      let spareLen = 0, spareCount = 0, spareRemLen = 0, spareRemCount = 0, spareLongest = 0;
      const row = (code, parts, bars, rems, extra) => {
        const n = parts.reduce((s, p) => s + Math.floor(p.qty), 0);
        const required = need(parts);
        const longest = Math.max.apply(null, parts.map(p => Number(p.length)));
        const stockLen = bars.reduce((s, b) => s + b.qty * b.length, 0) + (extra ? extra.stockLen : 0);
        const stockCount = bars.reduce((s, b) => s + Number(b.qty), 0) + (extra ? extra.stockCount : 0);
        const remLen = rems.reduce((s, r) => s + Number(r.length), 0) + (extra ? extra.remLen : 0);
        const remCount = rems.length + (extra ? extra.remCount : 0);
        const longestBar = Math.max(0, extra ? extra.longest : 0, ...bars.filter(b => b.qty > 0).map(b => Number(b.length)), ...rems.map(r => Number(r.length)));
        const avail = stockLen + remLen;
        let status = 'ok', note = 'Materiał dostępny';
        if (avail <= 0) { status = 'none'; note = code ? 'Brak materiału z tym kodem' : 'Brak materiału w bazie'; }
        else if (avail < required) { status = 'short'; note = `Brakuje ok. ${Math.ceil((required - avail) / 100) / 10} m`; }
        else if (longestBar < longest + opt.trimStart + opt.trimEnd) { status = 'short'; note = `Najdłuższy detal (${longest} mm) nie mieści się w żadnej sztandze`; }
        else if (avail < required * 1.08) { status = 'tight'; note = 'Zapas poniżej 8% – wynik pokaże nesting'; }
        if (extra && (extra.stockCount || extra.remCount)) note += ' · wliczono wolny materiał z kodem';
        rows.push({
          key: g.key + '|' + code, profile: g.profile, grade: g.grade, code, known: g.known, count: n, required, longest,
          stockLen, stockCount, remLen, remCount, avail, status, note,
        });
        return { avail, required };
      };
      for (const code of codes) {
        const bars = g.bars.filter(b => normCode(b.code) === code), rems = g.remnants.filter(r => normCode(r.code) === code);
        const r = row(code, g.parts.filter(p => normCode(p.code) === code), bars, rems);
        if (r.avail > r.required) {
          // nadwyżka w przybliżeniu: cała pula ponad potrzebę, liczona długością
          const k = (r.avail - r.required) / r.avail;
          spareLen += k * bars.reduce((s, b) => s + b.qty * b.length, 0); spareCount += Math.floor(k * bars.reduce((s, b) => s + Number(b.qty), 0));
          spareRemLen += k * rems.reduce((s, x) => s + Number(x.length), 0); spareRemCount += Math.floor(k * rems.length);
          spareLongest = Math.max(spareLongest, ...bars.filter(b => b.qty > 0).map(b => Number(b.length)), ...rems.map(x => Number(x.length)));
        }
      }
      const plain = g.parts.filter(p => !normCode(p.code));
      if (plain.length) {
        // kody materiału bez detali w koszyku – cały taki materiał jest wolny
        const free = c => !codes.includes(c);
        const bars = g.bars.filter(b => free(normCode(b.code))), rems = g.remnants.filter(r => free(normCode(r.code)));
        row('', plain, bars, rems, { stockLen: spareLen, stockCount: spareCount, remLen: spareRemLen, remCount: spareRemCount, longest: spareLongest });
      }
    }
    return rows;
  }

  /**
   * Spójność kodów materiału: ten sam kod powinien zawsze oznaczać ten sam profil i gatunek.
   * items: [{ code, profile, grade, where }] → lista ostrzeżeń.
   */
  function codeConflicts(items) {
    const map = new Map();
    for (const it of items) {
      const c = normCode(it.code); if (!c || !it.profile) continue;
      const pg = `${String(it.profile).trim().toUpperCase()} ${String(it.grade || '').trim().toUpperCase()}`.trim();
      if (!map.has(c)) map.set(c, new Map());
      const m = map.get(c);
      if (!m.has(pg)) m.set(pg, new Set());
      if (it.where) m.get(pg).add(it.where);
    }
    const out = [];
    for (const [c, m] of map) if (m.size > 1) {
      out.push({ code: c, variants: Array.from(m.keys()),
        text: `Kod materiału „${c}” występuje z różnymi profilami/gatunkami: ` +
          Array.from(m.entries()).map(([pg, w]) => pg + (w.size ? ` (${Array.from(w).join(', ')})` : '')).join('; ') + '.' });
    }
    return out;
  }

  /** Główna funkcja: nesting wszystkich grup. */
  function nest(input) {
    const opt = Object.assign({}, DEFAULTS, input.options || {});
    const groups = buildGroups(input);
    const out = { options: opt, groups: [], warnings: [] };
    for (const c of codeConflicts([].concat(
      (input.parts || []).map(p => Object.assign({ where: 'detale' }, p)),
      (input.bars || []).map(b => Object.assign({ where: 'magazyn' }, b)),
      (input.remnants || []).map(r => Object.assign({ where: 'odpady' }, r))))) out.warnings.push(c.text);
    const perGroup = Math.max(150, Math.min(opt.timeLimitMs, 6000 / Math.max(1, groups.length)));
    for (const g of groups) {
      if (!g.known) out.warnings.push(`Profil „${g.profile}” nie ma wymiarów w katalogu – skosy liczone dla wysokości 100 mm.`);
      const r = nestGroup(g, Object.assign({}, opt, { timeLimitMs: perGroup }));
      for (const u of r.unplaced) {
        out.warnings.push(u.code
          ? `${g.profile} ${g.grade}: nie rozmieszczono ${u.count} × „${u.name}” (${u.length} mm) – brak materiału z kodem ${u.code}.`
          : `${g.profile} ${g.grade}: nie rozmieszczono ${u.count} × „${u.name}” (${u.length} mm) – brak wystarczająco długiego materiału.`);
      }
      // detale, których silnik nie zmieścił, trafiają na półkę „poza planem” – można je dołożyć ręcznie
      const loose = [];
      for (const u of r.unplaced) for (let i = 0; i < u.count; i++) loose.push(u.partId);
      out.groups.push({
        key: g.key, profile: g.profile, grade: g.grade, shape: g.shape,
        dims: { h: geo.planeSize(g.dims, 'h'), b: geo.planeSize(g.dims, 'b') },
        kgm: g.kgm, bars: r.bars, unplaced: r.unplaced, loose, stats: r.stats,
      });
    }
    out.summary = summaryOf(out.groups);
    return out;
  }

  // ---------- ręczna korekta planu ----------
  /** Kontekst grupy do przeliczeń: definicje detali, wymiary i typ przekroju. */
  function editContext(group, parts) {
    const byId = {};
    for (const p of parts) byId[p.id] = p;
    return { dims: group.dims, shape: group.shape, byId };
  }

  /** Przelicza sztangę po zmianie kolejności, ułożenia lub materiału. */
  function relayoutBar(bar, ctx, opt) {
    const o = Object.assign({}, DEFAULTS, opt);
    const src = bar.source, rightLoss = src.right ? geo.maxSetback(src.right, ctx.dims) : 0;
    let x = o.trimStart > 0 ? o.trimStart + o.kerf : 0;
    let net = 0, prev = null, lastKerf = 0;
    for (const p of bar.placements) {
      const part = ctx.byId[p.partId];
      const ends = geo.orientedEnds(part, p.rev, p.flip, p.rot);
      p.saving = 0;
      if (prev) { const a = geo.advance(prev, ends.left, ctx.dims, o.kerf); x += a.adv; p.saving = a.saving; }
      else x = startFor(src, ends.left, ctx.dims, o);
      p.name = part.name; p.L = Number(part.length);
      p.left = ends.left; p.right = ends.right;
      p.x0 = x; p.x1 = x + p.L;
      p.net = p.L - (geo.meanSetback(ends.left, ctx.dims) + geo.meanSetback(ends.right, ctx.dims));
      net += p.net; x += p.L;
      prev = ends.right;
      lastKerf = geo.kerfAlong(o.kerf, ends.right.e.angle);
    }
    // jak w silniku: ostatni detal musi się skończyć przed nieużywanym końcem sztangi; ostatni rzaz może wejść w ten koniec
    // (albo poza sztangę – piła odcina wtedy tylko resztkę), więc nie liczy się do przepełnienia
    const limit = src.length - o.trimEnd - rightLoss;
    const free = limit - x - lastKerf;
    bar.usedTo = x; bar.net = net;
    bar.over = x - limit > 1e-6 ? Math.ceil(x - limit) : 0;
    bar.remnant = !bar.over && free >= o.minRemnant ? Math.floor(free) : 0;
    bar.remnantShape = bar.remnant ? remnantShape(prev, src, free, ctx.dims) : null;
    bar.scrap = Math.max(0, bar.source.length - net - bar.remnant);
    bar.util = net / bar.source.length;
    bar.saving = bar.placements.reduce((s, p) => s + p.saving, 0);
    return bar;
  }

  /** Dozwolone ułożenia detalu (przycisk „obróć”). */
  const movesFor = (part, ctx) => geo.allowedMoves(ctx.shape, ctx.dims, isFixed(part));

  /** Najlepsze ułożenie detalu wstawianego między dwóch sąsiadów (któryś może nie istnieć). */
  function bestMove(part, ctx, opt, prevRight, nextLeft) {
    const o = Object.assign({}, DEFAULTS, opt);
    let best = null;
    for (const mv of movesFor(part, ctx)) {
      const ends = geo.orientedEnds(part, mv.rev, mv.flip, mv.rot);
      let cost = 0;
      if (prevRight) cost += geo.advance(prevRight, ends.left, ctx.dims, o.kerf).adv;
      if (nextLeft) cost += geo.advance(ends.right, nextLeft, ctx.dims, o.kerf).adv;
      if (!best || cost < best.cost - 1e-9) best = { mv, cost };
    }
    return best ? best.mv : { rev: false, flip: false, rot: false };
  }

  /** Układa od nowa kolejność i ułożenia w jednej sztandze (materiał bez zmian). */
  function optimizeBar(bar, group, parts, opt) {
    const o = Object.assign({}, DEFAULTS, opt);
    if (bar.placements.length < 2) return relayoutBar(bar, editContext(group, parts), o);
    const cnt = {};
    for (const p of bar.placements) cnt[p.partId] = (cnt[p.partId] || 0) + 1;
    const list = Object.keys(cnt).map(id => Object.assign({}, parts.find(p => p.id === id), { qty: cnt[id] }));
    const g = prepareGroup({ parts: list, dims: group.dims, shape: group.shape }, o);
    const counts = g.types.map(t => t.count);
    const r = sequence(g, counts, counts.reduce((a, b) => a + b, 0), prepareSource(g, Object.assign({}, bar.source), o));
    bar.placements = r.seq.map(vi => {
      const v = g.variants[vi];
      return { partId: g.types[v.t].part.id, rev: v.rev, flip: v.flip, rot: v.rot };
    });
    return relayoutBar(bar, editContext(group, parts), o);
  }

  /** Odpad z bazy jako materiał sztangi – ułożony tak, żeby stracić jak najmniej przy pierwszym detalu. */
  function orientRemnant(rec, ctx, first, opt) {
    const o = Object.assign({}, DEFAULTS, opt);
    const base = { kind: 'remnant', id: rec.id, label: 'Odpad ' + rec.id, length: Number(rec.length), location: rec.location || '', left: null, right: null, move: null };
    if (geo.isSquare(geo.normalizeEnd(rec.end1)) && geo.isSquare(geo.normalizeEnd(rec.end2))) return base;
    const pe = first ? geo.orientedEnds(ctx.byId[first.partId], first.rev, first.flip, first.rot).left : null;
    let best = null;
    for (const mv of geo.allowedMoves(ctx.shape, ctx.dims, false)) {
      const ends = geo.orientedEnds(rec, mv.rev, mv.flip, mv.rot);
      const cost = startFor({ left: ends.left }, pe, ctx.dims, o) + geo.maxSetback(ends.right, ctx.dims);
      if (!best || cost < best.cost - 1e-9) best = { cost, mv, ends };
    }
    return Object.assign(base, { left: best.ends.left, right: best.ends.right, move: best.mv });
  }

  /** Przelicza statystyki i podsumowanie po ręcznych zmianach. */
  function recompute(result) {
    for (const g of result.groups) {
      const it = g.stats ? g.stats.iterations : 0;
      g.stats = groupStats(g.bars, result.options);
      g.stats.iterations = it;
    }
    result.summary = summaryOf(result.groups);
    return result;
  }

  return {
    DEFAULTS, nest, checkAvailability, groupKey, buildGroups, normCode, codeFits, codeConflicts,
    edit: { editContext, relayoutBar, optimizeBar, bestMove, movesFor, orientRemnant, recompute },
  };
});
