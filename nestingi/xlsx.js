/*
 * Odczyt arkuszy Excela (.xlsx) bez zewnętrznych bibliotek: plik .xlsx to archiwum ZIP z plikami XML.
 * Rozpakowanie przez DecompressionStream('deflate-raw'), XML przez DOMParser – oba są w Chromium (Electron).
 * Wynik: { sheets: [{ name, rows: [[wartość komórki, ...], ...] }] } – liczby jako number, reszta jako tekst.
 * Formuły: odczytywana jest ostatnia obliczona wartość zapisana przez Excela.
 */
(function () {
  'use strict';
  const td = new TextDecoder('utf-8');

  function unzip(buf) {
    const dv = new DataView(buf), files = {};
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('To nie jest plik .xlsx (brak struktury ZIP). Starsze pliki .xls zapisz w Excelu jako .xlsx albo .csv.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = td.decode(new Uint8Array(buf, p + 46, nlen));
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      files[name] = { method, data: new Uint8Array(buf, start, csize) };
      p += 46 + nlen + elen + clen;
    }
    return files;
  }

  async function readEntry(files, name) {
    const f = files[name] || files[Object.keys(files).find(k => k.toLowerCase() === name.toLowerCase())];
    if (!f) return null;
    if (f.method === 0) return td.decode(f.data);
    if (f.method !== 8) throw new Error('Nieobsługiwana kompresja w pliku .xlsx (' + f.method + ').');
    const stream = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return td.decode(await new Response(stream).arrayBuffer());
  }

  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
  const attrLocal = (el, local) => { const a = Array.from(el.attributes).find(x => x.localName === local); return a ? a.value : null; };

  /** „AB12” → indeks kolumny 27. */
  function colIndex(ref) {
    const m = /^([A-Z]+)/i.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function readXlsx(buf) {
    const files = unzip(buf);
    const wbText = await readEntry(files, 'xl/workbook.xml');
    if (!wbText) throw new Error('W pliku brak skoroszytu (xl/workbook.xml).');
    const relsText = await readEntry(files, 'xl/_rels/workbook.xml.rels');
    const rels = {};
    if (relsText) for (const r of tags(xml(relsText), 'Relationship')) {
      let t = r.getAttribute('Target') || '';
      t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      rels[r.getAttribute('Id')] = t;
    }
    const ssText = await readEntry(files, 'xl/sharedStrings.xml');
    const shared = ssText ? tags(xml(ssText), 'si').map(si =>
      tags(si, 't').filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('')) : [];
    const sheets = [];
    for (const s of tags(xml(wbText), 'sheet')) {
      const path = rels[attrLocal(s, 'id')] || ('xl/worksheets/sheet' + s.getAttribute('sheetId') + '.xml');
      const text = await readEntry(files, path);
      if (!text) continue;
      const rows = [];
      let rIdx = -1;
      for (const row of tags(xml(text), 'row')) {
        rIdx = row.getAttribute('r') ? Number(row.getAttribute('r')) - 1 : rIdx + 1;
        const cells = rows[rIdx] = [];
        let cIdx = -1;
        for (const c of tags(row, 'c')) {
          const ref = c.getAttribute('r');
          cIdx = ref ? colIndex(ref) : cIdx + 1;
          const t = c.getAttribute('t'), vEl = tags(c, 'v')[0], v = vEl ? vEl.textContent : null;
          let val = '';
          if (t === 's') val = v != null ? (shared[Number(v)] || '') : '';
          else if (t === 'inlineStr') val = tags(c, 't').map(x => x.textContent).join('');
          else if (t === 'b') val = v === '1' ? 'TAK' : 'NIE';
          else if (t === 'str') val = v != null ? v : '';
          else if (t === 'e') val = '';
          else val = v != null && v !== '' ? Number(v) : '';
          cells[cIdx] = val;
        }
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || [];
        for (let j = 0; j < r.length; j++) if (r[j] === undefined) r[j] = '';
        rows[i] = r;
      }
      sheets.push({ name: s.getAttribute('name') || ('Arkusz ' + (sheets.length + 1)), rows });
    }
    if (!sheets.length) throw new Error('Nie znaleziono żadnego arkusza w pliku.');
    return { sheets };
  }

  /** Plik wybrany przez użytkownika → arkusze. CSV/TXT czytane jako tekst rozdzielany. */
  async function readFile(file) {
    const name = file.name || '';
    if (/\.(csv|txt|tsv)$/i.test(name)) {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('windows-1250').decode(buf);   // CSV z polskiego Excela
      return { sheets: [{ name: name, rows: window.NEST.importmap.parseDelimited(text) }] };
    }
    if (/\.xls$/i.test(name)) throw new Error('Pliki .xls (stary format Excela) nie są obsługiwane – zapisz plik w Excelu jako .xlsx albo .csv.');
    return readXlsx(await file.arrayBuffer());
  }

  window.NEST = window.NEST || {};
  window.NEST.xlsx = { readXlsx, readFile, colIndex };
})();
