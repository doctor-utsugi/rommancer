// Plays a game, a save or a savestate from Rommancer in the browser with EmulatorJS. The page gets what to play in its
// address's fragment (never sent to the server): the system, the rom and, for a save, its file, with their download
// links; a game alone ("ROM") starts with no save. No game progress is kept: the emulator's save folder lives in
// memory (see the Containerfile), its own save buttons are hidden and nothing goes back to the server; only the
// emulator's settings stay in the browser.
(async function () {
  const fail = (msg) => {
    const el = document.getElementById('error');
    el.textContent = msg;
    el.hidden = false;
  };
  let cfg;
  try {
    cfg = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return fail('Falta qué jugar: abre esta página desde una partida de Rommancer.');
  }
  // The links carry a download token: out of the address bar once read
  history.replaceState(null, '', location.pathname);
  const es = (navigator.language || '').startsWith('es');
  document.title = `${cfg.title} · Rommancer`;
  document.getElementById('title').textContent = cfg.title;
  const rom = cfg.kind === 'ROM'
  document.getElementById('note').textContent = rom
    ? es ? 'Sin partida: solo para probarlo. Nada de lo que hagas aquí se guarda.' : 'No save: just to try it. Nothing you do here is kept.'
    : es
    ? `${cfg.kind === 'STATE' ? 'Savestate' : 'Partida'} de ${cfg.core}. Nada de lo que hagas aquí se guarda.` + (cfg.kind === 'STATE' ? ' Un savestate solo carga si el core del navegador es compatible con el de la consola.' : '')
    : `${cfg.kind === 'STATE' ? 'Savestate' : 'Save'} from ${cfg.core}. Nothing you do here is kept.` + (cfg.kind === 'STATE' ? ' A savestate only loads when the browser core is compatible with the console one.' : '');

  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  let game, file;
  try {
    [game, file] = await Promise.all([get(cfg.romUrl), rom ? null : get(cfg.fileUrl)]);
  } catch (e) {
    return fail((es ? 'No se pudo bajar la rom o la partida: ' : 'Could not download the rom or the save: ') + e.message);
  }

  window.EJS_player = '#game';
  window.EJS_core = cfg.system;
  window.EJS_pathtodata = '/emulatorjs/data/';
  // The npm package has no minified build: load its sources
  window.EJS_DEBUG_XX = true;
  // A File keeps the rom's name, whose extension some cores read
  window.EJS_gameUrl = new File([game], cfg.romName);
  // One name per system: the emulator's own settings (controls, video, volume) are kept in this browser for every game
  // of the system; saves are not (the save folder lives in memory)
  window.EJS_gameName = `rommancer-${cfg.system}`;
  window.EJS_language = es ? 'es-ES' : 'en-US';
  window.EJS_startOnLoaded = true;
  window.EJS_disableDatabases = true;
  window.EJS_Buttons = { saveState: false, loadState: false, saveSavFiles: false, loadSavFiles: false, netplay: false, cacheManager: false };
  const { prepareState } = await import('./savestate.js');
  window.EJS_onGameStart = async () => {
    if (rom) return;
    const gm = window.EJS_emulator.gameManager;
    try {
      if (cfg.kind === 'STATE') {
        gm.toggleMainLoop(0);
        try {
          const prepared = await prepareState(file, gm.getState(), window.EJS_emulator.getCore(), cfg.core);
          gm.loadState(prepared.data);
          if (prepared.adapted) document.getElementById('note').textContent += es
            ? ' Estado adaptado entre versiones de Gambatte. El original no se ha modificado.'
            : ' State adapted between Gambatte versions. The original is unchanged.';
        } finally { gm.toggleMainLoop(1); }
      }
      else {
        // The game's save where the core reads it, then the game started again with it
        const p = gm.getSaveFilePath();
        gm.FS.mkdirTree(p.substring(0, p.lastIndexOf('/')));
        gm.FS.writeFile(p, file);
        gm.loadSaveFiles();
        gm.restart();
      }
    } catch (e) {
      fail((es ? 'El emulador no aceptó el fichero: ' : 'The emulator did not take the file: ') + e.message);
    }
  };
  const s = document.createElement('script');
  s.src = '/emulatorjs/data/loader.js';
  document.body.appendChild(s);
})();
