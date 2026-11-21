'use strict';
/* Shared helpers: IndexedDB storage and video element utilities. */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        if (!window.indexedDB) { rej(new Error('IndexedDB недоступен')); return; }
        const r = indexedDB.open('rank-shorts', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Транзакция отменена'));
    });
  }
  return {
    put: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)),
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    clear: store => tx(store, 'readwrite', s => s.clear()),
    keys: store => tx(store, 'readonly', s => s.getAllKeys()),
  };
})();

function waitEvent(el, ev, ms = 20000) {
  return new Promise((res, rej) => {
    if (ev === 'loadeddata' && el.readyState >= 2) { res(); return; }
    if (ev === 'loadedmetadata' && el.readyState >= 1) { res(); return; }
    const to = setTimeout(() => { done(); rej(new Error('timeout')); }, ms);
    const ok = () => { done(); res(); };
    const bad = () => { done(); rej(new Error('decode:' + (el.error ? el.error.code : '?'))); };
    function done() { clearTimeout(to); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
  });
}

function seekVideo(v, t) {
  return new Promise(res => {
    if (Math.abs(v.currentTime - t) < 0.002 && v.readyState >= 2 && !v.seeking) { res(); return; }
    const to = setTimeout(() => { done(); res(); }, 8000);
    const on = () => { done(); res(); };
    function done() { clearTimeout(to); v.removeEventListener('seeked', on); }
    v.addEventListener('seeked', on);
    v.currentTime = t;
  });
}

/* MediaRecorder WebM files often report duration = Infinity until the end is read. */
async function fixDuration(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise(res => {
    const to = setTimeout(finish, 6000);
    function finish() { clearTimeout(to); v.removeEventListener('durationchange', on); v.removeEventListener('timeupdate', on); res(); }
    function on() { if (isFinite(v.duration) && v.duration > 0) finish(); }
    v.addEventListener('durationchange', on);
    v.addEventListener('timeupdate', on);
    v.currentTime = 1e7;
  });
  await seekVideo(v, 0);
  return isFinite(v.duration) ? v.duration : 0;
}
