/*
 * Geometria końców profili.
 *
 * Każdy koniec detalu opisany jest funkcją "cofnięcia" p(y) >= 0: o ile mm materiał
 * kończy się wcześniej niż skrajny punkt końca, na wysokości y w płaszczyźnie cięcia
 * (y = 0 dół, y = H góra; H to wysokość profilu h albo szerokość b).
 * Długość detalu L to wymiar gabarytowy (od skrajnego punktu do skrajnego punktu).
 *
 * Dzięki temu zazębianie dwóch sąsiednich detali liczy się jednym wzorem:
 *   zysk = min po y ( pA(y) + pB(y) )   (gdy oba końce cięte w tej samej płaszczyźnie)
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.geometry = m; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const MAX_ANGLE = 80;

  const END_TYPES = [
    { id: 'square', label: 'Prosto (90°)' },
    { id: 'miter', label: 'Skos na całej wysokości' },
    { id: 'partial', label: 'Zacięcie naroża (skos częściowy)' },
    { id: 'peak', label: 'Szpic (podwójny skos)' },
    { id: 'vnotch', label: 'Wcięcie V' },
  ];

  function squareEnd() {
    return { type: 'square', angle: 0, plane: 'h', side: 'top', depth: 0 };
  }

  function normalizeEnd(e) {
    const o = Object.assign(squareEnd(), e || {});
    o.angle = Math.max(0, Math.min(MAX_ANGLE, Number(o.angle) || 0));
    o.depth = Math.max(0, Number(o.depth) || 0);
    if (o.plane !== 'b') o.plane = 'h';
    if (o.side !== 'bottom') o.side = 'top';
    if (!END_TYPES.some(t => t.id === o.type)) o.type = 'square';
    if (o.type !== 'square' && o.angle === 0) o.type = 'square';
    if (o.type === 'square') { o.angle = 0; }
    return o;
  }

  function isSquare(e) { return !e || e.type === 'square' || !e.angle; }

  /** Wymiar profilu w płaszczyźnie cięcia. */
  function planeSize(dims, plane) {
    const v = plane === 'b' ? dims.b : dims.h;
    return v > 0 ? v : 100;
  }

  /** Cofnięcie końca na wysokości y (bez uwzględnienia orientacji). */
  function setbackRaw(e, H, y) {
    if (isSquare(e)) return 0;
    const t = Math.tan(e.angle * DEG);
    switch (e.type) {
      case 'miter':
        return e.side === 'top' ? t * y : t * (H - y);
      case 'partial': {
        const c = Math.min(H, e.depth > 0 ? e.depth : H);
        return e.side === 'top' ? t * Math.max(0, y - (H - c)) : t * Math.max(0, c - y);
      }
      case 'peak':
        return t * Math.abs(y - H / 2);
      case 'vnotch':
        return t * (H / 2 - Math.abs(y - H / 2));
      default:
        return 0;
    }
  }

  /** Punkty załamania funkcji cofnięcia. */
  function breakpointsRaw(e, H) {
    if (isSquare(e)) return [0, H];
    if (e.type === 'partial') {
      const c = Math.min(H, e.depth > 0 ? e.depth : H);
      return e.side === 'top' ? [0, H - c, H] : [0, c, H];
    }
    if (e.type === 'peak' || e.type === 'vnotch') return [0, H / 2, H];
    return [0, H];
  }

  /** Nazwy płaszczyzn cięcia zależnie od typu przekroju. */
  const PLANE_LABEL = {
    I: ['środnik', 'półka'], C: ['środnik', 'półka'], L: ['ramię pionowe', 'ramię poziome'],
    box: ['ścianka pionowa', 'ścianka pozioma'], O: ['płaszczyzna pionowa', 'płaszczyzna pozioma'],
    rod: ['płaszczyzna pionowa', 'płaszczyzna pozioma'],
  };
  const planeLabel = (plane, shape) => (PLANE_LABEL[shape] || PLANE_LABEL.I)[plane === 'h' ? 0 : 1];

  /**
   * Koniec zorientowany: { e, mirror }. mirror = współrzędna w płaszczyźnie cięcia odbita.
   * Ułożenie detalu w sztandze (obroty sztywne, przekrój musi pokryć się z przekrojem sztangi):
   *   rev  = obrócony końcami   – 180° wokół osi pionowej: zamienia końce, odbija przekrój w poziomie (b),
   *   flip = przewrócony        – 180° wokół osi podłużnej: odbija przekrój w pionie i w poziomie,
   *   rot  = obrócony o 90°     – tylko profile kwadratowe i rury: zamienia płaszczyzny cięcia h ↔ b.
   * rev + flip razem = 180° wokół osi poprzecznej poziomej (zamienia końce, odbija tylko w pionie).
   */
  function orientedEnds(part, rev, flip, rot) {
    const mk = e0 => {
      const e = normalizeEnd(e0);
      const plane = rot ? (e.plane === 'h' ? 'b' : 'h') : e.plane;
      const base = rot && e.plane === 'h';          // obrót o 90° odbija cięcie przeniesione do płaszczyzny b
      return {
        e: plane === e.plane ? e : Object.assign({}, e, { plane }),
        mirror: !!(base ^ flip ^ (rev && plane === 'b')),
      };
    };
    const a = mk(part.end1), b = mk(part.end2);
    return rev ? { left: b, right: a } : { left: a, right: b };
  }

  /**
   * Dozwolone ułożenia detalu – dokładnie te obroty, które odwzorowują przekrój profilu sam na siebie.
   * fixed = detal kierunkowy (znakowanie, obróbki), wtedy tylko ułożenie z rysunku.
   */
  function allowedMoves(shape, dims, fixed) {
    const M = (rev, flip, rot) => ({ rev, flip, rot });
    const none = [M(false, false, false)];
    if (fixed) return none;
    switch (shape) {
      case 'L':                                     // kątownik: brak symetrii w osiach h i b
        return none;
      case 'C':                                     // ceownik: tylko odbicie w pionie, czyli oba ruchy naraz
        return none.concat([M(true, true, false)]);
      case 'O': case 'box': case 'rod': {           // lity pręt: okrągły / kwadratowy – też obrót o 90°, płaskownik – jak prostokąt
        const four = [M(false, false, false), M(true, false, false), M(false, true, false), M(true, true, false)];
        const square = shape === 'O' || Math.abs((dims.h || 0) - (dims.b || 0)) < 1e-6;
        return square ? four.concat(four.map(m => M(m.rev, m.flip, true))) : four;
      }
      default:                                      // dwuteownik, profil prostokątny, profil spoza katalogu
        return [M(false, false, false), M(true, false, false), M(false, true, false), M(true, true, false)];
    }
  }

  /** Opis ułożenia detalu na sztandze – dla raportu i listy cięć. */
  function describeMove(m) {
    const t = [];
    if (m.rev && m.flip) t.push('przewrócony, mierzyć od drugiego końca');
    else if (m.rev) t.push('obrócony końcami');
    else if (m.flip) t.push('przewrócony');
    if (m.rot) t.push('obrócony o 90°');
    return t.length ? t.join(', ') : 'jak na rysunku detalu';
  }

  function setback(oe, dims, y) {
    const H = planeSize(dims, oe.e.plane);
    return setbackRaw(oe.e, H, oe.mirror ? H - y : y);
  }

  function breakpoints(oe, dims) {
    const H = planeSize(dims, oe.e.plane);
    const b = breakpointsRaw(oe.e, H);
    return oe.mirror ? b.map(y => H - y).sort((a, c) => a - c) : b;
  }

  function maxSetback(oe, dims) {
    return Math.max.apply(null, breakpoints(oe, dims).map(y => setback(oe, dims, y)));
  }

  /** Średnie cofnięcie (pole trójkąta odpadu / H) – do liczenia masy netto. */
  function meanSetback(oe, dims) {
    const H = planeSize(dims, oe.e.plane);
    const b = breakpoints(oe, dims);
    let area = 0;
    for (let i = 1; i < b.length; i++) {
      area += (setback(oe, dims, b[i - 1]) + setback(oe, dims, b[i])) / 2 * (b[i] - b[i - 1]);
    }
    return area / H;
  }

  /** Zysk z zazębienia: prawy koniec detalu A i lewy koniec detalu B. */
  function interlockSaving(rightA, leftB, dims) {
    if (isSquare(rightA.e) || isSquare(leftB.e)) return 0;
    if (rightA.e.plane !== leftB.e.plane) return 0;
    const ys = breakpoints(rightA, dims).concat(breakpoints(leftB, dims));
    let s = Infinity;
    for (const y of ys) s = Math.min(s, setback(rightA, dims, y) + setback(leftB, dims, y));
    return s > 1e-9 ? s : 0;
  }

  /** Rzaz mierzony wzdłuż osi profilu (cięcie pod kątem zabiera więcej długości). */
  function kerfAlong(kerf, angleDeg) {
    return kerf / Math.cos(Math.min(MAX_ANGLE, angleDeg || 0) * DEG);
  }

  /**
   * Odstęp wzdłuż osi między skrajnym punktem końca A a skrajnym punktem początku B.
   * Może być ujemny – wtedy detale zachodzą na siebie gabarytowo (zazębienie).
   */
  function advance(rightA, leftB, dims, kerf) {
    const s = interlockSaving(rightA, leftB, dims);
    if (s <= 0) return { adv: kerf, saving: 0 };
    const k = kerfAlong(kerf, Math.max(rightA.e.angle, leftB.e.angle));
    return { adv: k - s, saving: s };
  }

  /** Zarys detalu w danej płaszczyźnie: lista punktów [x, y] (x od 0 do L). */
  function outline(ends, L, dims, plane) {
    const H = planeSize(dims, plane);
    const side = (oe) => {
      if (oe.e.plane !== plane || isSquare(oe.e)) return [[0, 0], [H, 0]]; // [y, p]
      return breakpoints(oe, dims).map(y => [y, setback(oe, dims, y)]);
    };
    const l = side(ends.left), r = side(ends.right);
    const pts = [];
    for (const [y, p] of l) pts.push([p, y]);                      // lewa krawędź w górę
    for (let i = r.length - 1; i >= 0; i--) pts.push([L - r[i][1], r[i][0]]); // prawa w dół
    return pts;
  }

  /** Koniec zapisany w układzie sztangi (bez flagi odbicia) – do zapamiętania w odpadzie. */
  function plainEnd(oe) {
    if (!oe || isSquare(oe.e)) return squareEnd();
    const e = oe.e;
    if (e.type === 'peak' || e.type === 'vnotch') return Object.assign({}, e);
    return Object.assign({}, e, { side: ((e.side === 'top') !== !!oe.mirror) ? 'top' : 'bottom' });
  }

  /**
   * Lico odpadu po odcięciu detalu – dopełnienie prawego końca detalu: skos ↔ skos przeciwny, szpic ↔ wcięcie V.
   * Zacięcie naroża daje prosty koniec (cienki „język” za zacięciem nie jest liczony jako materiał).
   */
  function complementEnd(oe) {
    if (!oe || isSquare(oe.e) || oe.e.type === 'partial') return squareEnd();
    const e = oe.e;
    if (e.type === 'peak') return Object.assign({}, e, { type: 'vnotch' });
    if (e.type === 'vnotch') return Object.assign({}, e, { type: 'peak' });
    return Object.assign({}, e, { side: ((e.side === 'top') !== !!oe.mirror) ? 'bottom' : 'top' });
  }

  /** Najmniejsze przesunięcie detalu, przy którym jego lewe lico pe leży w całości w materiale o licu qe. */
  function fitInside(qe, pe, dims) {
    if (!qe || isSquare(qe.e)) return 0;
    const maxq = maxSetback(qe, dims);
    if (!pe || isSquare(pe.e) || pe.e.plane !== qe.e.plane) return maxq;
    let d = 0;
    for (const y of breakpoints(qe, dims).concat(breakpoints(pe, dims))) d = Math.max(d, setback(qe, dims, y) - setback(pe, dims, y));
    return d;
  }

  function describeEnd(e, shape) {
    e = normalizeEnd(e);
    if (isSquare(e)) return 'prosto';
    const pl = planeLabel(e.plane, shape);
    const sd = e.side === 'top' ? 'góra' : 'dół';
    switch (e.type) {
      case 'miter': return `skos ${e.angle}° (${pl}, cięta ${sd})`;
      case 'partial': return `zacięcie ${e.angle}° × ${e.depth || 'cała'} mm (${pl}, ${sd})`;
      case 'peak': return `szpic 2×${e.angle}° (${pl})`;
      case 'vnotch': return `wcięcie V 2×${e.angle}° (${pl})`;
    }
    return 'prosto';
  }

  function endSignature(oe) {
    const e = oe.e;
    if (isSquare(e)) return 'sq';
    const symmetric = e.type === 'peak' || e.type === 'vnotch';
    const side = symmetric ? '' : ((e.side === 'top') !== oe.mirror ? 'T' : 'B');
    return [e.type, e.angle, e.plane, side, e.type === 'partial' ? e.depth : ''].join(':');
  }

  return {
    END_TYPES, MAX_ANGLE, squareEnd, normalizeEnd, isSquare, planeSize, planeLabel,
    orientedEnds, allowedMoves, describeMove, setback, breakpoints, maxSetback, meanSetback,
    interlockSaving, kerfAlong, advance, outline, describeEnd, endSignature, plainEnd, complementEnd, fitInside,
  };
});
