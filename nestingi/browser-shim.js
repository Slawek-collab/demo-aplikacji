// Zastępcze API, gdy aplikacja jest otwarta w zwykłej przeglądarce (testy, podgląd bez Electrona).
// Baza trzymana w localStorage, pliki pobierane/wczytywane przez przeglądarkę.
(function () {
  if (window.api) return;
  const KEY = 'nesting-profili-db';
  const download = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  window.api = {
    desktop: false,
    dbLoad: async () => {
      let db = null;
      try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* brak */ }
      return { path: 'pamięć przeglądarki (tryb podglądu)', db, mtime: 0 };
    },
    dbSave: async db => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* brak */ } return { ok: true, mtime: 0 }; },
    dbChoose: async () => null,
    dbReveal: async () => {},
    projectOpen: () => new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.nest,.json';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return resolve(null);
        try { resolve({ path: f.name, data: JSON.parse(await f.text()) }); } catch (e) { resolve({ path: f.name, data: null }); }
      };
      inp.click();
    }),
    projectLast: async () => null,
    projectRecent: async () => [],
    projectOpenPath: async () => null,
    projectSave: async (data, file, suggested) => {
      const name = file || (suggested || 'nesting') + '.nest';
      download(name, JSON.stringify(data, null, 2), 'application/json');
      return name;
    },
    setDirty: () => {},
    setTitle: t => { document.title = t; },
    exportPdf: async html => {
      const w = window.open('', '_blank');
      if (!w) return null;
      w.document.write(html); w.document.close();
      setTimeout(() => w.print(), 300);
      return 'druk';
    },
    exportText: async (text, suggested) => { download(suggested, '﻿' + text, 'text/plain'); return suggested; },
  };
})();
