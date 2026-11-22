/* Raport z nestingu – samodzielny dokument HTML (drukowany do PDF, A4 poziomo). */
(function (root, factory) {
  const dep = (typeof module === 'object' && module.exports)
    ? { geo: require('./geometry.js'), draw: require('./draw.js') }
    : { geo: root.NEST.geometry, draw: root.NEST.draw };
  const m = factory(dep.geo, dep.draw);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else { root.NEST = root.NEST || {}; root.NEST.report = m; }
})(typeof self !== 'undefined' ? self : this, function (geo, draw) {
  'use strict';
  const { esc, fmt } = draw;
  const m1 = mm => (mm / 1000).toFixed(2).replace('.', ',');
  const kg = v => v.toFixed(1).replace('.', ',');
  const pct = v => (v * 100).toFixed(1).replace('.', ',') + '%';
  const SRC = { remnant: 'odpad użytkowy', stock: 'magazyn', purchase: 'DO ZAKUPU' };

  const CSS = `
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10pt; color: #14171c; margin: 0; padding: 14px; }
  h1 { font-size: 17pt; margin: 0 0 2px; }
  h2 { font-size: 12.5pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #1f3a5f; color: #1f3a5f; }
  h3 { font-size: 10.5pt; margin: 0 0 3px; }
  .meta { color: #555; margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
  th, td { border: 1px solid #c3c8cf; padding: 2.5px 6px; text-align: left; vertical-align: top; }
  th { background: #eef1f5; font-weight: 600; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .tiles { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .tile { border: 1px solid #c3c8cf; border-radius: 4px; padding: 5px 10px; min-width: 120px; }
  .tile b { display: block; font-size: 13pt; }
  .tile span { color: #555; font-size: 8.5pt; }
  .bar { break-inside: avoid; page-break-inside: avoid; margin: 0 0 10px; border: 1px solid #c3c8cf; border-radius: 4px; padding: 6px 8px; }
  .bar .head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .bar .head span { color: #444; }
  .bar table { font-size: 8.5pt; margin-bottom: 0; }
  .buy { color: #b02a1a; font-weight: 700; }
  .warn { border: 1px solid #e0a800; background: #fff8e1; padding: 6px 10px; border-radius: 4px; margin: 6px 0; }
  .foot { margin-top: 14px; color: #777; font-size: 8pt; }
  .sw { display: inline-block; width: 10px; height: 10px; border: 1px solid #333; margin-right: 4px; vertical-align: -1px; }
  `;

  function buildReport(project, result, colorOf, appInfo) {
    const meta = project.meta || {};
    const o = result.options, s = result.summary;
    const today = project.date || new Date().toLocaleDateString('pl-PL');
    let h = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Raport nestingu ${esc(project.no || '')}${meta.name ? ' – ' + esc(meta.name) : ''}</title><style>${CSS}</style></head><body>`;
    h += `<h1>Raport nestingu profili${project.no ? ' – ' + esc(project.no) : ''}</h1>`;
    h += `<div class="meta">Zlecenie: <b>${esc(meta.name || '—')}</b>${meta.number ? ' · nr ' + esc(meta.number) : ''}${meta.author ? ' · opracował: ' + esc(meta.author) : ''} · data: ${today}` +
      `${project.committed ? ' · <b>zatwierdzono w magazynie</b>' : ' · wariant roboczy (magazyn nie został zmieniony)'}` +
      `${result.edited ? ' · <b>plan poprawiany ręcznie</b>' : ''}` +
      `${result.reopenedFrom ? ' · zmiana nestingu ' + esc(result.reopenedFrom) + ' (jego zatwierdzenie cofnięte)' : ''}` +
      `${(n => n ? ` · <b class="buy">zezłomowano ${n} szt. detali</b>` : '')(result.groups.reduce((t, g) => t + g.bars.reduce((u, b) => u + b.placements.filter(p => p.scrapped).length, 0), 0))}</div>`;
    h += `<div class="meta">Parametry: rzaz ${o.kerf} mm · obcięcie czoła ${o.trimStart} mm · nieużywany koniec ${o.trimEnd} mm · min. odpad użytkowy ${o.minRemnant} mm · długość handlowa do zakupu ${o.allowPurchase ? o.purchaseLength + ' mm' : 'brak (tylko magazyn)'}</div>`;

    h += `<div class="tiles">
      <div class="tile"><b>${s.parts}</b><span>detali rozmieszczonych</span></div>
      <div class="tile"><b>${s.bars}</b><span>sztang / odpadów użytych</span></div>
      <div class="tile"><b>${m1(s.material)} m</b><span>materiał pobrany (${kg(s.massMaterial)} kg)</span></div>
      <div class="tile"><b>${m1(s.net)} m</b><span>detale netto (${kg(s.massNet)} kg)</span></div>
      <div class="tile"><b>${m1(s.remnant)} m</b><span>odpad użytkowy (wraca)</span></div>
      <div class="tile"><b>${m1(s.scrap)} m</b><span>złom (${kg(s.massScrap)} kg)</span></div>
      <div class="tile"><b>${m1(s.saving)} m</b><span>zysk z zazębienia końców</span></div>
    </div>`;
 // zakup z podziałem na kody materiału: „2 × 12 000 (kod A1) + 1 × 12 000”
    // ilość sztang według długości (i kodu materiału): „2 × 12 000 + 1 × 6 000 (kod X1)”
    const countText = (g, kind) => {
      const by = {};
      for (const b of g.bars) if (b.source.kind === kind) { const k = (b.source.code || '') + '|' + b.source.length; by[k] = (by[k] || 0) + 1; }
      return Object.keys(by).sort((a, b) => Number(b.split('|')[1]) - Number(a.split('|')[1]) || a.localeCompare(b))
        .map(k => { const [c, L] = k.split('|'); return `${by[k]} × ${fmt(Number(L))}${c ? ` (kod ${esc(c)})` : ''}`; }).join('<br>');
    };
    const buyText = g => countText(g, 'purchase');
    // bez informacji o detalach nierozmieszczonych (zostają w programie, nie na raporcie)
    for (const w of result.warnings.filter(x => !/nie rozmieszczono/.test(x))) h += `<div class="warn">⚠ ${esc(w)}</div>`;

    h += `<h2>Zestawienie materiału</h2><table><tr><th>Profil</th><th>Gatunek</th><th class="n">Detali</th><th class="n">Z odpadów</th><th class="n">Z magazynu [szt. × mm]</th><th class="n">Do zakupu [szt. × mm]</th><th class="n">Pobrano [m]</th><th class="n">Netto [m]</th><th class="n">Odpad użytk. [m]</th><th class="n">Złom [m]</th><th class="n">Wykorzystanie</th><th class="n">Masa pobrana [kg]</th></tr>`;
    for (const g of result.groups) {
      const t = g.stats;
      h += `<tr><td><b>${esc(g.profile)}</b></td><td>${esc(g.grade)}</td><td class="n">${t.parts}</td><td class="n">${t.fromRemnants}</td><td class="n">${t.fromStock ? countText(g, 'stock') : '—'}</td>` +
        `<td class="n ${t.toPurchase ? 'buy' : ''}">${t.toPurchase ? buyText(g) : '—'}</td><td class="n">${m1(t.material)}</td><td class="n">${m1(t.net)}</td>` +
        `<td class="n">${m1(t.remnant)}</td><td class="n">${m1(t.scrap)}</td><td class="n">${pct(t.util)}</td><td class="n">${kg(t.material * g.kgm / 1000)}</td></tr>`;
    }
    h += `</table>`;

    const rem = [];
    for (const g of result.groups) for (const b of g.bars) if (b.remnant > 0) rem.push({ g, b });
    if (rem.length) {
      h += `<h2>Odpady użytkowe powstałe z nestingu</h2><table><tr><th>Nr w bazie</th><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Długość gabarytowa [mm]</th><th>Początek (lico po cięciu)</th><th>Koniec</th><th>Ze sztangi</th></tr>`;
      for (const { g, b } of rem) {
        const sh = draw.remnantOut(b);
        h += `<tr><td>${esc(b.savedRemnantId || (project.committed ? 'nie zapisano' : '—'))}</td><td>${esc(g.profile)}</td><td>${esc(g.grade)}</td><td>${esc(b.source.code || '')}</td><td class="n">${fmt(sh.length)}</td>` +
          `<td>${esc(geo.describeEnd(sh.end1, g.shape))}${sh.squared ? ' – <b>obcięty na prosto</b>' : ''}</td><td>${esc(geo.describeEnd(sh.end2, g.shape))}</td><td>${esc(g.profile)} #${b.no}</td></tr>`;
      }
      h += `</table>`;
    }

    h += `<h2>Plan cięcia</h2>`;
    for (const g of result.groups) {
      for (const b of g.bars) {
        h += `<div class="bar"><div class="head"><h3>${esc(g.profile)} ${esc(g.grade)} · sztanga #${b.no} · ${fmt(b.source.length)} mm · <span class="${b.source.kind === 'purchase' ? 'buy' : ''}">${SRC[b.source.kind]}${b.source.kind === 'remnant' ? ' ' + esc(b.source.id) : ''}</span>${b.source.code ? ' · kod mat. <b>' + esc(b.source.code) + '</b>' : ''}${b.lotLabel ? ' · Nr mag. <b>' + esc(b.lotLabel) + '</b>' : ''}${b.source.location ? ' · ' + esc(b.source.location) : ''}` +
          `${draw.sourceEnds(b.source, g.shape) ? ' · końce: ' + esc(draw.sourceEnds(b.source, g.shape)) + (b.source.move ? ', ' + esc(geo.describeMove(b.source.move)) : '') : ''}</h3>` +
          `<span>wykorzystanie ${pct(b.util)} · odpad użytkowy ${b.remnant ? fmt(draw.remnantOut(b).length) + ' mm' + (draw.remnantOut(b).squared ? ' (obcięty na prosto – dodatkowe cięcie)' : '') : '—'} · złom ${fmt(b.scrap)} mm` +
          `${b.over ? ` · <b class="buy">PRZEKROCZONO o ${fmt(b.over)} mm</b>` : ''}</span></div>`;
        h += draw.barSvg(b, g, colorOf, { trimEnd: o.trimEnd });
        h += `<table><tr><th class="n">Lp.</th><th>Detal</th><th class="n">Długość</th><th class="n">Od [mm]</th><th class="n">Do [mm]</th><th>Lewy koniec</th><th>Prawy koniec</th><th>Ułożenie</th><th class="n">Zazębienie</th></tr>`;
        b.placements.forEach((p, i) => {
          const or = geo.describeMove(p);
          h += `<tr><td class="n">${i + 1}</td><td><span class="sw" style="background:${colorOf(p.partId)}"></span>${esc(p.name)}${p.scrapped ? ` <b class="buy">ZEZŁOMOWANY ${esc(p.scrapped.date)}${p.scrapped.reason ? ' – ' + esc(p.scrapped.reason) : ''}</b>` : ''}</td><td class="n">${fmt(p.L)}</td><td class="n">${fmt(p.x0)}</td><td class="n">${fmt(p.x1)}</td>` +
            `<td>${esc(endText(p.left, g.shape))}</td><td>${esc(endText(p.right, g.shape))}</td><td>${or}</td><td class="n">${p.saving > 0 ? fmt(p.saving) + ' mm' : ''}</td></tr>`;
        });
        h += `</table></div>`;
      }
    }

    h += `<h2>Lista detali</h2><table><tr><th class="n">Lp.</th><th>Nazwa</th><th>Profil</th><th>Gatunek</th><th>Kod mat.</th><th class="n">Długość [mm]</th><th class="n">Ilość</th><th>Początek</th><th>Koniec</th><th class="n">Masa szt. [kg]</th></tr>`;
    const kgmOf = {}, shapeOf = {}; for (const g of result.groups) { kgmOf[g.key] = g.kgm; shapeOf[g.key] = g.shape; }
    // ilości z planu cięcia – sztuki poza planem nie trafiają na raport
    const placed = {};
    for (const g of result.groups) for (const b of g.bars) for (const p of b.placements) placed[p.partId] = (placed[p.partId] || 0) + 1;
    (project.parts || []).filter(p => placed[p.id]).map(p => Object.assign({}, p, { qty: placed[p.id] })).forEach((p, i) => {
      const key = `${String(p.profile).trim().toUpperCase()}|${String(p.grade || '').trim().toUpperCase()}`;
      const sh = (shapeOf[key] || '');
      h += `<tr><td class="n">${i + 1}</td><td><span class="sw" style="background:${colorOf(p.id)}"></span>${esc(p.name)}</td><td>${esc(p.profile)}</td><td>${esc(p.grade)}</td><td>${esc(p.code || '')}</td><td class="n">${fmt(p.length)}</td><td class="n">${p.qty}</td>` +
        `<td>${esc(geo.describeEnd(p.end1, sh))}</td><td>${esc(geo.describeEnd(p.end2, sh))}</td><td class="n">${kgmOf[key] ? kg(p.length * kgmOf[key] / 1000) : '—'}</td></tr>`;
    });
    h += `</table><div class="foot">Pozycje „Od/Do” mierzone od początku sztangi do skrajnych punktów detalu. Masy liczone z długości gabarytowej i masy jednostkowej z katalogu. ${esc(appInfo || '')}</div></body></html>`;
    return h;
  }

  /** Opis końca w ułożeniu na sztandze (po obróceniu „góra/dół” może się zamienić). */
  function endText(oe, shape) {
    const e = oe.e;
    if (geo.isSquare(e)) return 'prosto';
    const symmetric = e.type === 'peak' || e.type === 'vnotch';
    const top = (e.side === 'top') !== oe.mirror;
    return geo.describeEnd(Object.assign({}, e, symmetric ? {} : { side: top ? 'top' : 'bottom' }), shape);
  }

  /** Raport identyfikacji materiałowej: detal → Nr mag. → wytop → certyfikat. */
  function buildIdentReport(meta, rows, filterLabel, appInfo) {
    meta = meta || {};
    let h = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Identyfikacja materiałowa – ${esc(meta.name || '')}</title><style>${CSS}
      tr.todo td { color: #b02a1a; } tr.scrap td { color: #888; text-decoration: line-through; }</style></head><body>`;
    h += `<h1>Identyfikacja materiałowa</h1>`;
    h += `<div class="meta">Zlecenie: <b>${esc(meta.name || '—')}</b>${meta.number ? ' · nr ' + esc(meta.number) : ''}${meta.author ? ' · opracował: ' + esc(meta.author) : ''} · data: ${new Date().toLocaleDateString('pl-PL')}` +
      `${filterLabel ? ' · zakres: <b>' + esc(filterLabel) + '</b>' : ' · zakres: cały projekt'}</div>`;
    const todo = rows.filter(r => r.status === 'todo').reduce((t, r) => t + r.qty, 0);
    if (todo) h += `<div class="warn">⚠ ${todo} szt. detali bez zgłoszonego numeru magazynowego (cięcie niezgłoszone).</div>`;
    h += `<table><tr><th>Detal</th><th>Profil</th><th>Gatunek</th><th class="n">Szt.</th><th>Nesting / sztanga</th><th>Nr mag.</th><th>Wytop (Heat No.)</th><th>Nr certyfikatu</th><th>Producent</th><th>Status</th></tr>`;
    for (const r of rows) {
      h += `<tr class="${r.status === 'ok' ? '' : r.status}"><td><b>${esc(r.name)}</b></td><td>${esc(r.profile)}</td><td>${esc(r.grade)}</td><td class="n">${r.qty}</td><td>${esc(r.where.join(', '))}</td>` +
        `<td><b>${esc(r.lot || '—')}</b></td><td>${esc(r.heat || '')}</td><td>${esc(r.cert || '')}</td><td>${esc(r.maker || '')}</td><td>${esc(r.statusLabel || r.status)}</td></tr>`;
    }
    h += `</table><div class="foot">Powiązanie detalu z numerem magazynowym wynika z planu cięcia (nesting, sztanga) i zgłoszenia cięcia. ${esc(appInfo || '')}</div></body></html>`;
    return h;
  }

  return { buildReport, buildIdentReport, endText };
});
