/* Rysunki SVG: plan cięcia sztangi i podgląd detalu. Wspólne dla okna aplikacji i raportu. */
(function (root, factory) {
  const geo = (typeof module === 'object' && module.exports) ? require('./geometry.js') : root.NEST.geometry;
  const m = factory(geo);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.draw = m; }
})(typeof self !== 'undefined' ? self : this, function (geo) {
  'use strict';

  const PALETTE = ['#8ecae6', '#ffb703', '#a7c957', '#f4a261', '#cdb4db', '#90e0c9', '#f28482', '#bde0fe',
    '#e9c46a', '#b5c99a', '#f7b7a3', '#9fa8da', '#80cbc4', '#ffe082', '#ef9a9a', '#b0bec5'];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f1 = n => (Math.round(n * 10) / 10).toString();
  const fmt = n => Math.round(n).toLocaleString('pl-PL').replace(/ | /g, ' ');

  function colorFor(index) { return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]; }

  const SQ = { e: { type: 'square', angle: 0, plane: 'h', side: 'top', depth: 0 }, mirror: false };
  const asOe = e => (e ? { e, mirror: false } : SQ);
  function usesPlaneB(bar) {
    const ends = [];
    for (const p of bar.placements) ends.push(p.left, p.right);
    if (bar.source) ends.push(bar.source.left, bar.source.right);
    if (bar.remnantShape) ends.push(asOe(bar.remnantShape.end1), asOe(bar.remnantShape.end2));
    return ends.some(oe => oe && !geo.isSquare(oe.e) && oe.e.plane === 'b');
  }
  const hasShape = sh => !!sh && [sh.end1, sh.end2].some(e => e && e.type !== 'square');
  /**
   * Odpad, który faktycznie trafi do magazynu. Obcięty na prosto: dodatkowe cięcie proste za najkrótszym punktem
   * skośnego lica (i drugiego końca), długość = prosty odcinek, trójkąty idą na złom.
   */
  function remnantOut(bar) {
    if (!bar || !(bar.remnant > 0)) return null;
    if (bar.squareRemnant || !bar.remnantShape)
      return { length: bar.remnant, end1: null, end2: null, squared: !!bar.squareRemnant && hasShape(bar.remnantShape) };
    return bar.remnantShape;
  }

  /** Opis kształtu końców materiału (odpadu): „skos 45° (…) / prosto”; pusty dla prostych końców. */
  function sourceEnds(src, shape) {
    if (!src || (!src.left && !src.right)) return '';
    const a = geo.describeEnd(geo.plainEnd(src.left), shape), b = geo.describeEnd(geo.plainEnd(src.right), shape);
    return a === 'prosto' && b === 'prosto' ? '' : `${a} / ${b}`;
  }

  /** Plan cięcia jednej sztangi. colorOf(partId) → kolor. */
  function barSvg(bar, group, colorOf, o) {
    o = Object.assign({ width: 1100, strip: 42, trimEnd: 0 }, o || {});
    const len = bar.source.length;
    const planes = usesPlaneB(bar) ? ['h', 'b'] : ['h'];
    const left = 56, right = 24, top = 4, gap = 8, axis = 18;
    const span = len + (bar.over || 0);          // przepełniona sztanga: rysunek obejmuje wystającą część
    const sx = (o.width - left - right) / span;
    const height = top + planes.length * o.strip + (planes.length - 1) * gap + axis;
    const X = x => left + x * sx;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.width} ${height}" width="100%" class="bar-svg" font-family="Segoe UI, Arial, sans-serif">`;
    s += `<defs><pattern id="hatchR" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#d8f3dc"/><line x1="0" y1="0" x2="0" y2="6" stroke="#52b788" stroke-width="2"/></pattern>` +
      `<pattern id="hatchS" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="7" height="7" fill="#f8d7da"/><line x1="0" y1="0" x2="0" y2="7" stroke="#b02a1a" stroke-width="2.2"/></pattern></defs>`;
    planes.forEach((plane, pi) => {
      const y0 = top + pi * (o.strip + gap);
      const H = geo.planeSize(group.dims, plane);
      const Y = y => y0 + o.strip - (y / H) * o.strip;
      s += viewLabel(plane, group.dims, left - 6, y0 + o.strip / 2, 10);
      // zarys materiału – odpad ze skośnym końcem rysowany w swoim kształcie
      const srcPts = geo.outline({ left: bar.source.left || SQ, right: bar.source.right || SQ }, len, group.dims, plane)
        .map(([x, y]) => `${f1(X(x))},${f1(Y(y))}`).join(' ');
      s += `<polygon points="${srcPts}" fill="#e3e6ea" stroke="#8a9099" stroke-width="0.8"/>`;
      if (bar.over) s += `<rect x="${f1(X(len))}" y="${y0}" width="${f1(bar.over * sx)}" height="${o.strip}" fill="#f8d7da" stroke="#b02a1a" stroke-width="0.8" stroke-dasharray="4 3"/>`;
      if (bar.remnant > 0) {
        const sh = remnantOut(bar);
        const x1 = len - o.trimEnd, x0 = x1 - sh.length;
        const rPts = geo.outline({ left: asOe(sh.end1), right: asOe(sh.end2) }, sh.length, group.dims, plane)
          .map(([x, y]) => `${f1(X(x0 + x))},${f1(Y(y))}`).join(' ');
        s += `<polygon points="${rPts}" fill="url(#hatchR)" stroke="#2d6a4f" stroke-width="0.8"/>`;
        if (sh.length * sx > 70) s += `<text x="${X((x0 + x1) / 2)}" y="${y0 + o.strip / 2 + 4}" font-size="11" text-anchor="middle" fill="#1b4332" font-weight="600">odpad użytk. ${fmt(sh.length)}</text>`;
      }
      bar.placements.forEach((p, pix) => {
        const pts = geo.outline({ left: p.left, right: p.right }, p.L, group.dims, plane)
          .map(([x, y]) => `${f1(X(p.x0 + x))},${f1(Y(y))}`).join(' ');
        s += `<polygon points="${pts}" fill="${p.scrapped ? 'url(#hatchS)' : colorOf(p.partId)}" stroke="${p.scrapped ? '#b02a1a' : '#2b2f36'}" stroke-width="0.8"` +
          `${o.pick ? ` data-pl="${pix}" class="${o.sel === pix || (Array.isArray(o.sel) && o.sel.includes(pix)) ? 'selp' : ''}"` : ''}>` +
          `<title>${esc(p.name)} – ${fmt(p.L)} mm (${fmt(p.x0)} → ${fmt(p.x1)})${p.scrapped ? ' – ZEZŁOMOWANY ' + esc(p.scrapped.date) : ''}</title></polygon>`;
        s += edgesSvg(group.shape, plane, { left: p.left, right: p.right }, p.L, group.dims, p.rev, p.flip, x => X(p.x0 + x), Y);
        const w = p.L * sx;
        if (w > 26) {
          const maxCh = Math.floor((w - 8) / 6);
          let label = (p.scrapped ? '✕ ' : '') + (p.name || '');
          const full = `${label} · ${fmt(p.L)}`;
          label = full.length <= maxCh ? full : (label.length <= maxCh ? label : label.slice(0, Math.max(1, maxCh - 1)) + '…');
          s += `<text x="${f1(X(p.x0 + p.L / 2))}" y="${y0 + o.strip / 2 + 4}" font-size="11" text-anchor="middle" fill="#14171c" pointer-events="none">${esc(label)}</text>`;
        }
      });
    });
    if (bar.over) s += `<line x1="${f1(X(len))}" y1="${top - 2}" x2="${f1(X(len))}" y2="${height - axis + 2}" stroke="#b02a1a" stroke-width="2"/>` +
      `<text x="${f1(X(len) - 4)}" y="${top + 9}" font-size="10" text-anchor="end" fill="#b02a1a" font-weight="700">koniec sztangi</text>`;
    const yA = height - axis + 3;
    const step = span <= 3000 ? 250 : span <= 7000 ? 500 : 1000;
    for (let x = 0; x <= span + 1e-6; x += step) {
      s += `<line x1="${f1(X(x))}" y1="${yA}" x2="${f1(X(x))}" y2="${yA + 4}" stroke="#777" stroke-width="0.8"/>`;
      s += `<text x="${f1(X(x))}" y="${yA + 14}" font-size="9" text-anchor="middle" fill="#666">${x}</text>`;
    }
    return s + '</svg>';
  }

  const SHAPE_LABEL = { I: 'dwuteownik', C: 'ceownik', L: 'kątownik', box: 'profil zamknięty', O: 'rura okrągła', rod: 'lity pręt' };
  /** Mała ikona przekroju (tytuł SVG służy też jako podpowiedź i tekst do filtrowania listy). */
  function shapeIcon(shape, size) {
    const c = '#1f3a5f', z = size || 20;
    const body = {
      I: `<path fill="${c}" d="M3 3h18v4h-7v10h7v4H3v-4h7V7H3z"/>`,
      C: `<path fill="${c}" d="M5 3h14v4H9v10h10v4H5z"/>`,
      L: `<path fill="${c}" d="M5 3h4v14h10v4H5z"/>`,
      box: `<rect x="4.5" y="4.5" width="15" height="15" rx="1.5" fill="none" stroke="${c}" stroke-width="3"/>`,
      O: `<circle cx="12" cy="12" r="7.5" fill="none" stroke="${c}" stroke-width="3"/>`,
      rod: `<circle cx="12" cy="12" r="9" fill="${c}"/>`,
    }[shape] || '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${z}" height="${z}" style="vertical-align:middle"><title>${SHAPE_LABEL[shape] || ''}</title>${body}</svg>`;
  }
  /**
   * Krawędzie podłużne na podglądzie (schematycznie, nie w skali): y = ułamek wysokości rzutu,
   * hidden = krawędź niewidoczna (linia przerywana).
   * Rzut z boku: patrzymy na środnik (ceownik – od strony grzbietu, kątownik – od płaskiej, zewnętrznej strony ramienia).
   * Profile niesymetryczne: krawędź drugiego ramienia / środnika leży u góry rzutu bocznego i u dołu rzutu z góry.
   */
  function edgeLines(shape, plane) {
    const L = (y, hidden) => ({ y, hidden });
    switch (shape) {
      case 'I': return plane === 'h' ? [L(0.11, false), L(0.89, false)] : [L(0.45, true), L(0.55, true)];
      case 'C': return plane === 'h' ? [L(0.11, true), L(0.89, true)] : [L(0.1, true)];
      case 'L': return plane === 'h' ? [L(0.9, true)] : [L(0.1, true)];   // widok od płaskiej strony ramion
      case 'box': case 'O': return [L(0.1, true), L(0.9, true)];
      case 'rod': return [];                          // pełny przekrój – tylko obrys
      default: return [];
    }
  }

  /** Podpis rzutu: „bok / h = 200” albo „góra / b = 100” (wymiar przekroju pod nazwą). */
  function viewLabel(plane, dims, x, yCenter, size) {
    const v = plane === 'h' ? dims.h : dims.b;
    const t = `${plane === 'h' ? 'h' : 'b'} = ${v > 0 ? f1(v) : '?'}`;
    return `<text x="${f1(x)}" y="${f1(yCenter - 1)}" font-size="${size}" text-anchor="end" fill="#555">${plane === 'h' ? 'bok' : 'góra'}</text>` +
      `<text x="${f1(x)}" y="${f1(yCenter + size)}" font-size="${size - 1}" text-anchor="end" fill="#5d6673">${t}</text>`;
  }

  /**
   * Krawędzie podłużne jednego detalu w danym rzucie – wspólne dla podglądu i planu cięcia.
   * ends: { left, right } (końce zorientowane), rev/flip: ułożenie detalu na sztandze.
   * X(x), Y(y): przeliczenie mm na współrzędne rysunku.
   */
  function edgesSvg(shape, plane, ends, L, dims, rev, flip, X, Y) {
    const H = geo.planeSize(dims, plane);
    // przewrócenie odbija przekrój w obu rzutach, obrót końcami tylko w rzucie z góry
    const mirrored = plane === 'h' ? !!flip : (!!flip !== !!rev);
    const sbAt = (oe, y) => (oe.e.plane === plane && !geo.isSquare(oe.e) ? geo.setback(oe, dims, y) : 0);
    let s = '';
    for (const e of edgeLines(shape, plane)) {
      const y = (mirrored ? 1 - e.y : e.y) * H;
      const x1 = sbAt(ends.left, y), x2 = L - sbAt(ends.right, y);
      if (x2 - x1 < 1e-6) continue;
      s += `<line x1="${f1(X(x1))}" y1="${f1(Y(y))}" x2="${f1(X(x2))}" y2="${f1(Y(y))}" stroke="#2b2f36" stroke-width="${e.hidden ? 0.9 : 1.1}"${e.hidden ? ' stroke-dasharray="8 4" opacity=".75"' : ''}/>`;
    }
    return s;
  }

  /** Podgląd detalu w dwóch rzutach (w prawdziwych kątach, długość skrócona). */
  function partSvg(part, dims, color, shape) {
    const ends = geo.orientedEnds(part, false, false);
    const d = { h: geo.planeSize(dims, 'h'), b: geo.planeSize(dims, 'b') };
    const sb = geo.maxSetback(ends.left, d) + geo.maxSetback(ends.right, d);
    const Ls = Math.max(3.2 * Math.max(d.h, d.b), sb + 1.2 * Math.max(d.h, d.b));
    // szerokość zbliżona do panelu (ok. 300 px) – podpisy w skali ~1:1, czytelne
    const W = 320, pad = 8, lab = 46;
    const sc = (W - 2 * pad - lab) / Ls;
    const hh = d.h * sc, hb = d.b * sc, gap = 20;
    const height = pad * 2 + hh + gap + hb + 18;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${f1(height)}" width="100%" font-family="Segoe UI, Arial, sans-serif">`;
    const view = (plane, y0, hpx) => {
      const H = d[plane];
      const pts = geo.outline(ends, Ls, d, plane).map(([x, y]) => `${f1(lab + pad + x * sc)},${f1(y0 + hpx - y / H * hpx)}`).join(' ');
      const xm = lab + pad + Ls * sc / 2;
      s += viewLabel(plane, dims, lab, y0 + hpx / 2, 13);
      s += `<polygon points="${pts}" fill="${color || '#8ecae6'}" stroke="#2b2f36" stroke-width="1.2"/>`;
      // krawędzie widoczne (ciągłe) i ukryte (przerywane) – dochodzą do skośnych końców
      s += edgesSvg(shape, plane, ends, Ls, d, false, false, x => lab + pad + x * sc, y => y0 + hpx - y / H * hpx);
      s += `<path d="M${f1(xm - 5)},${f1(y0 - 4)} l6,${f1(hpx / 2 + 4)} l-8,0 l6,${f1(hpx / 2 + 4)}" fill="none" stroke="#fff" stroke-width="5"/>`;
      s += `<path d="M${f1(xm - 5)},${f1(y0 - 4)} l6,${f1(hpx / 2 + 4)} l-8,0 l6,${f1(hpx / 2 + 4)}" fill="none" stroke="#2b2f36" stroke-width="1"/>`;
    };
    view('h', pad, hh);
    view('b', pad + hh + gap, hb);
    const yT = height - 4;
    s += `<text x="${lab + pad}" y="${f1(yT)}" font-size="12" fill="#3f4652">◀ początek</text>`;
    s += `<text x="${W - pad}" y="${f1(yT)}" font-size="12" fill="#3f4652" text-anchor="end">koniec ▶</text>`;
    s += `<text x="${f1(lab + pad + Ls * sc / 2)}" y="${f1(yT)}" font-size="12" fill="#3f4652" text-anchor="middle">L = ${fmt(Number(part.length) || 0)} mm</text>`;
    return s + '</svg>';
  }

  return { PALETTE, colorFor, barSvg, sourceEnds, remnantOut, hasShape, partSvg, shapeIcon, edgeLines, edgesSvg, viewLabel, SHAPE_LABEL, esc, fmt };
});
