'use strict';
/* RankShorts editor: state, UI, import, watermark editor, export. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); const s = (t - m * 60).toFixed(1); return `${m}:${s.length < 4 ? '0' : ''}${s}`; };
  const r2 = n => Math.round(n * 100) / 100;

  const S = {
    p: null, urls: new Map(), sel: null, tab: 'clip', engine: null, detectQ: Promise.resolve(),
    server: { mode: 'unknown' }, exp: null, lastExport: null, saveTimer: null, scrubbing: false,
    wm: { video: null, key: null, view: 'before', drag: null, selRegion: null, time: 0 },
  };
  window.RankShorts = S;

  /* ---------- project model ---------- */
  function defaultProject() {
    return {
      version: 1,
      title: 'Рейтинг *лучших*\n{кунг-фу малышей}',
      places: Array.from({ length: 5 }, () => ({ id: uid(), name: '' })),
      clips: [], style: { ...DEFAULT_STYLE },
      output: { res: '1080', fps: 30, audio: true }, autoDetect: true,
    };
  }
  function normalize(p) {
    const d = defaultProject();
    p = { ...d, ...p };
    p.style = { ...DEFAULT_STYLE, ...(p.style || {}) };
    p.output = { ...d.output, ...(p.output || {}) };
    p.places = Array.isArray(p.places) ? p.places : d.places;
    p.clips = Array.isArray(p.clips) ? p.clips : [];
    p.clips.forEach(c => { c.watermarks = c.watermarks || []; c.wm = c.wm || { status: 'none' }; });
    return p;
  }
  const clipById = id => S.p.clips.find(c => c.id === id);
  const selClip = () => clipById(S.sel);
  const placeIdx = id => S.p.places.findIndex(p => p.id === id);
  const clipDur = c => { const max = Math.max(0, (c.srcDuration || 0) - (c.trimStart || 0)); return Math.max(0, Math.min(c.duration || max, max)); };
  const placeColor = i => (S.p.style.medalColors && i < 3 ? MEDAL[i] : S.p.style.numberColor);

  function buildSegments() {
    let start = 0; const segs = [];
    for (const c of S.p.clips) {
      const url = S.urls.get(c.videoKey); if (!url) continue;
      const dur = clipDur(c); if (dur <= 0.05) continue;
      segs.push({ clip: c, url, start, dur }); start += dur;
    }
    return segs;
  }

  /* ---------- persistence ---------- */
  function setSaved(t, cls) { const el = $('#saveStatus'); el.textContent = t; el.className = 'save-status ' + (cls || ''); }
  function save() {
    clearTimeout(S.saveTimer); setSaved('Сохранение…');
    S.saveTimer = setTimeout(async () => {
      try {
        await DB.put('kv', 'project', JSON.parse(JSON.stringify(S.p, (k, v) => (k[0] === '_' ? undefined : v))));
        setSaved('Сохранено в браузере');
      } catch (e) { setSaved('Не сохранено', 'err'); toast('Не удалось сохранить проект в хранилище браузера: ' + esc(e.message), 'error'); }
    }, 400);
  }

  /* ---------- toasts ---------- */
  function toast(html, type = 'info', ms = 5000) {
    const el = document.createElement('div'); el.className = 'toast ' + type; el.innerHTML = html;
    el.onclick = () => el.remove(); $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), ms); setTimeout(() => el.remove(), ms + 400);
  }

  /* ---------- adding videos ---------- */
  function probe(url) {
    return new Promise((res, rej) => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
      let done = false;
      const end = () => { v.removeAttribute('src'); v.load(); };
      const fail = e => { if (done) return; done = true; clearTimeout(to); end(); rej(e); };
      const to = setTimeout(() => fail(new Error('timeout')), 25000);
      v.onerror = () => fail(new Error('decode:' + (v.error ? v.error.code : '?')));
      v.onloadeddata = async () => {
        v.onloadeddata = null;
        if (!v.videoWidth || !v.videoHeight) { fail(new Error('novideo')); return; }
        try {
          const duration = await fixDuration(v);
          if (!duration) { fail(new Error('noduration')); return; }
          await seekVideo(v, Math.min(0.5, duration / 3));
          const c = document.createElement('canvas'); c.width = 96; c.height = Math.round(96 * v.videoHeight / v.videoWidth);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          const thumb = c.toDataURL('image/jpeg', 0.7);
          // Proof that it really plays: muted playback has to advance (a decoded still frame is not enough).
          if (duration > 0.4) {
            const t0 = v.currentTime; let advanced = false;
            try { await v.play(); }
            catch (e) { advanced = !!(e && e.name === 'NotAllowedError'); }   // autoplay policy: the frame above already decoded
            if (!advanced) advanced = await new Promise(r => {
              const t = setTimeout(() => { v.removeEventListener('timeupdate', chk); r(false); }, 4000);
              function chk() { if (v.currentTime - t0 > 0.08) { clearTimeout(t); v.removeEventListener('timeupdate', chk); r(true); } }
              v.addEventListener('timeupdate', chk); chk();
            });
            v.pause();
            if (!advanced) { fail(new Error('stalled')); return; }
          }
          if (done) return; done = true; clearTimeout(to);
          const out = { w: v.videoWidth, h: v.videoHeight, duration, thumb }; end(); res(out);
        } catch (e) { fail(e); }
      };
      v.src = url;
    });
  }

  function probeErrorText(name, e) {
    const m = String(e && e.message || e);
    const base = `«${esc(name)}»: `;
    if (m === 'novideo') return base + 'в файле нет видеодорожки (похоже, это аудио).';
    if (m === 'stalled') return base + 'видео открылось, но не воспроизводится (зависает). Перекодируйте его в MP4 (H.264 + AAC) и загрузите снова.';
    if (m === 'noduration') return base + 'не удалось определить длительность — файл повреждён или записан не до конца.';
    const hevc = /\.(mov|mp4|m4v|hevc)$/i.test(name)
      ? ' Частая причина — кодек HEVC/H.265 (видео с iPhone): браузер на Windows не всегда умеет его декодировать.' : '';
    return base + 'браузер не смог открыть это видео (неподдерживаемый кодек или повреждённый файл).' + hevc +
      ' Перекодируйте в MP4 (H.264 + AAC), например в HandBrake или командой <code>ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4</code>, и загрузите снова.';
  }

  async function addFiles(list, source) { for (const f of Array.from(list)) await addFile(f, source); }

  function freePlaceId() {
    const used = new Set(S.p.clips.map(c => c.placeId));
    for (let i = S.p.places.length - 1; i >= 0; i--) if (!used.has(S.p.places[i].id)) return S.p.places[i].id;
    return null;
  }

  /* target: an existing (link) clip that should receive this file, keeping its caption and place. */
  async function addFile(file, source, target) {
    const name = file.name || 'video.mp4';
    if (file.type && !file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv|ogv|3gp)$/i.test(name)) {
      toast(`«${esc(name)}» — это не видеофайл. Поддерживаются MP4, WebM, MOV (H.264/VP8/VP9/AV1).`, 'error', 8000); return null;
    }
    if (file.size > 1.5e9) toast(`«${esc(name)}» очень большой (${(file.size / 1e9).toFixed(1)} ГБ) — браузер может работать медленно.`, 'warn');
    const url = URL.createObjectURL(file);
    let info;
    try { info = await probe(url); }
    catch (e) { URL.revokeObjectURL(url); toast(probeErrorText(name, e), 'error', 12000); return null; }
    const key = 'v_' + uid();
    try { await DB.put('blobs', key, file); }
    catch (e) { toast('Видео добавлено, но не сохранено в хранилище браузера (не хватает места?). После перезагрузки страницы его придётся добавить снова.', 'warn', 9000); }
    S.urls.set(key, url);
    if (target && S.p.clips.includes(target)) {
      Object.assign(target, {
        kind: 'file', videoKey: key, fileName: name, source: source || target.url || 'file',
        srcDuration: r2(info.duration), width: info.w, height: info.h, thumb: info.thumb,
        trimStart: 0, duration: r2(Math.min(info.duration, 60)), captionDelay: 0,
        fit: info.h >= info.w ? 'cover' : 'contain', focusX: 0.5, focusY: 0.5, watermarks: [], wm: { status: 'none' },
      });
      delete target.embed; delete target.linkReason;
      S.sel = target.id; S.tab = 'clip';
      save(); renderTabs(); renderClipList(); renderInspector(); refreshSegments(target.id);
      toast(`Видео загружено в клип «${esc(target.caption || name)}» — теперь он попадёт в итоговый ролик.`, 'ok', 4000);
      if (S.p.autoDetect) queueDetect(target);
      return target;
    }
    const clip = {
      id: uid(), videoKey: key, fileName: name, source: source || 'file',
      srcDuration: r2(info.duration), width: info.w, height: info.h, thumb: info.thumb,
      placeId: null, caption: '', trimStart: 0, duration: r2(Math.min(info.duration, 60)), captionDelay: 0,
      fit: info.h >= info.w ? 'cover' : 'contain', focusX: 0.5, focusY: 0.5, muted: false, volume: 1,
      watermarks: [], wm: { status: 'none' },
    };
    // Default: countdown — fill the highest free place first (the user can change it).
    clip.placeId = freePlaceId();
    S.p.clips.push(clip);
    if (!S.sel) S.sel = clip.id;
    save(); renderClipList(); renderInspector(); refreshSegments(S.sel);
    toast(`Добавлено: ${esc(name)}`, 'ok', 2500);
    if (S.p.autoDetect) queueDetect(clip);
    return clip;
  }

  /* ---------- link import ---------- */
  async function checkServer() {
    const el = $('#serverStatus');
    if (!location.protocol.startsWith('http')) {
      S.server = { mode: 'file' };
      el.innerHTML = '<span class="status-warn">Импорт по ссылке выключен:</span> сайт открыт как файл, а TikTok не отдаёт видео напрямую браузеру. Запустите <b>start.cmd</b> (локальный сервер) и установите yt-dlp — или скачайте ролик и загрузите файл.';
      return;
    }
    // Opened from the local server: same origin. Opened from the published site: look for the local
    // server of THIS computer (start.cmd) on localhost.
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const bases = local ? [''] : ['http://localhost:8787', 'http://127.0.0.1:8787'];
    let j = null;
    for (const base of bases) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(base + '/api/status', { cache: 'no-store', signal: ctl.signal }); clearTimeout(t);
        const d = await r.json(); if (d && d.ok) { j = d; S.api = base; break; }
      } catch (e) { /* try next */ }
    }
    if (j) {
      S.server = { mode: 'server', ytdlp: j.ytdlp, version: j.version, tiktok: !!j.tiktok };
      const via = local ? '' : ' Подключено к серверу на этом компьютере.';
      el.innerHTML = (j.ytdlp
        ? `<span class="status-ok">Импорт по ссылке доступен</span> (yt-dlp ${esc(j.version)}): TikTok, YouTube Shorts и др.`
        : '<span class="status-ok">Ссылки TikTok скачиваются</span> встроенным загрузчиком. Для YouTube, Instagram и других сайтов установите yt-dlp (<code>winget install yt-dlp</code>) и перезапустите start.cmd — до этого такие ролики можно только смотреть.') + via;
    } else {
      S.api = ''; S.server = { mode: 'static' };
      el.innerHTML = '<span class="status-warn">Скачивание по ссылке сейчас недоступно.</span> Оно работает через программу на компьютере: запустите <b>start.cmd</b> и обновите страницу (на этом же компьютере подключится само, в Chrome/Edge разрешите доступ к локальной сети, если спросит). На телефоне ссылки открываются только в плеере — для монтажа загрузите видеофайл.';
    }
  }

  /* Recognise a link and build an embeddable player for it (watching only; not used for export). */
  function parseLink(u) {
    const h = u.hostname.replace(/^(www|m)\./, '');
    let m;
    const yt = (id, short) => ({ provider: 'YouTube', id, type: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, vertical: !!short });
    if (h === 'youtu.be' && (m = u.pathname.match(/^\/([\w-]{6,})/))) return yt(m[1]);
    if (/(^|\.)youtube\.com$/.test(h)) {
      if ((m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/))) return yt(m[2], m[1] === 'shorts');
      const v = u.searchParams.get('v'); if (v) return yt(v);
    }
    const tt = tiktokInfo(u);
    if (tt && tt.id && !tt.photo) {
      return { provider: 'TikTok', id: tt.id, type: 'iframe', vertical: true,
        src: `https://www.tiktok.com/player/v1/${tt.id}?controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&music_info=1&description=1&rel=0` };
    }
    if (/(^|\.)instagram\.com$/.test(h) && (m = u.pathname.match(/^(?:\/[\w.]+)?\/(reel|reels|p|tv)\/([\w-]+)/))) {
      return { provider: 'Instagram', id: m[2], type: 'iframe', vertical: m[1] !== 'p', src: `https://www.instagram.com/${m[1] === 'p' ? 'p' : m[1] === 'tv' ? 'tv' : 'reel'}/${m[2]}/embed/` };
    }
    if (h === 'vimeo.com' && (m = u.pathname.match(/^\/(\d+)/))) return { provider: 'Vimeo', id: m[1], type: 'iframe', vertical: false, src: `https://player.vimeo.com/video/${m[1]}` };
    if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(u.pathname)) return { provider: 'Видеофайл', id: decodeURIComponent(u.pathname.split('/').pop()), type: 'video', vertical: false, src: u.href };
    return null;
  }
  const isTikTok = u => /(^|\.)tiktok\.com$/.test(u.hostname);
  const canServerDownload = u => S.server.mode === 'server' && (S.server.ytdlp || (S.server.tiktok && isTikTok(u)));
  const isShortTikTok = u => /^(vm|vt)\.tiktok\.com$/.test(u.hostname) || (isTikTok(u) && /^\/t\/[\w-]+/.test(u.pathname));

  /* Video id from any TikTok link shape that contains one (mirrors tiktok.ps1). null for photos/profiles/short links. */
  function tiktokInfo(u) {
    if (!isTikTok(u)) return null;
    let m = u.pathname.match(/^\/@([^/]+)\/(video|photo)\/(\d{6,})/);
    if (m) return m[2] === 'photo' ? { photo: true, id: m[3] } : { id: m[3], user: decodeURIComponent(m[1]) };
    m = u.pathname.match(/^\/(?:share\/video|v|embed(?:\/v\d)?|player\/v\d)\/(\d{6,})/) || u.pathname.match(/^\/video\/(\d{6,})/);
    if (m) return { id: m[1], user: '_' };
    m = u.search.match(/[?&](?:item_id|share_item_id|aweme_id)=(\d{6,})/);
    return m ? { id: m[1], user: '_' } : null;
  }
  /* The same video reached by different links gets the same key. */
  function keyOfUrl(str) {
    try { const u = new URL(str); const t = tiktokInfo(u); if (t && t.id) return 'tiktok:' + t.id; u.hash = ''; return u.href; } catch (e) { return String(str); }
  }
  const findByLink = key => S.p.clips.find(c => [c.url, c.source].some(x => x && /^https?:/.test(x) && keyOfUrl(x) === key));

  /* ---- errors ---- */
  class ImportError extends Error {
    constructor(code, details, retryable, retryAfter) { super(code); this.code = code; this.details = details || ''; this.retryable = !!retryable; this.retryAfter = retryAfter || 0; }
  }
  const IMPORT_MSG = {
    bad_url: ['Ссылка не подошла', 'Сервер не принял ссылку. Проверьте, что адрес скопирован целиком.'],
    tiktok_unsupported_url: ['Это не ссылка на видео TikTok', 'Нужна ссылка на конкретный ролик: …/@автор/video/…, короткая vm.tiktok.com/… или tiktok.com/t/…. Профили, поиск и хэштеги не подходят.'],
    tiktok_photo: ['Это фото-карусель, а не видео', 'В TikTok это публикация из картинок. Видеофайла у неё нет.'],
    tiktok_private: ['Ролик приватный', 'Автор закрыл просмотр (закрытый аккаунт или доступ «только друзья»). Без входа в аккаунт такой ролик получить нельзя.'],
    tiktok_removed: ['Ролик недоступен', 'Похоже, видео удалено автором, скрыто или недоступно в вашем регионе.'],
    tiktok_blocked: ['TikTok остановил автоматическую загрузку', 'Вместо ролика TikTok показал проверку «Please wait» — так он защищается от программ. Загрузчик приостановил запросы, чтобы не усугублять блокировку. Повторите чуть позже (обычно через несколько минут) или загрузите файл.'],
    tiktok_page_failed: ['Не удалось открыть TikTok', 'Нет интернета, TikTok недоступен из вашей сети или ссылка не открывается.'],
    tiktok_bad_redirect: ['Короткая ссылка не раскрылась', 'TikTok не вернул адрес ролика: ссылка устарела или удалена. Откройте её в браузере и вставьте полный адрес из адресной строки.'],
    tiktok_no_video: ['TikTok не отдал видео', 'Ролик нельзя получить без входа в аккаунт (возраст, регион, закрытый доступ) либо TikTok изменил страницу.'],
    tiktok_download_failed: ['Файл не скачался', 'TikTok показал страницу ролика, но не отдал сам файл: ссылка на файл защищена или соединение оборвалось.'],
    download_failed: ['yt-dlp не смог скачать ролик', 'Видео приватное или удалено, нужен вход в аккаунт, есть возрастное ограничение, либо источник изменил защиту (обновите yt-dlp: yt-dlp -U).'],
    no_ytdlp: ['Нужен yt-dlp для этого сайта', 'Для YouTube, Instagram и других сайтов установите yt-dlp (winget install yt-dlp) и перезапустите start.cmd.'],
    server_unreachable: ['Локальный сервер не отвечает', 'Запустите start.cmd и откройте сайт по адресу http://localhost:8787/.'],
    timeout: ['Источник отвечает слишком долго', 'Загрузка не завершилась за отведённое время. Возможно, медленный интернет или источник завис.'],
    unplayable: ['Файл скачан, но не воспроизводится', 'Браузер не смог проиграть видео (неподдерживаемый кодек или повреждённый файл). Загрузите файл, перекодированный в MP4 (H.264 + AAC).'],
    cors: ['Источник не даёт скачать файл', 'Сайт запрещает загрузку видео из браузера (CORS) или файл недоступен.'],
    unsupported_source: ['Скачать это нельзя', 'Для этого источника нет загрузчика.'],
    server_error: ['Ошибка сервера при импорте', 'Сервер вернул неожиданный ответ.'],
  };

  /* ---- server calls (each import gets its own AbortController; the timeout is part of it) ---- */
  async function fetchSrv(path, ctrl, ms) {
    ctrl.timedOut = false;
    const timer = setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, ms);
    try { return await fetch((S.api || '') + path, { cache: 'no-store', signal: ctrl.signal }); }
    catch (e) {
      if (ctrl.signal.aborted) throw new ImportError(ctrl.timedOut ? 'timeout' : 'cancelled', '', ctrl.timedOut);
      throw new ImportError('server_unreachable', String(e && e.message || e), true);
    } finally { clearTimeout(timer); }
  }
  async function srvError(r) {
    let j = {}; try { j = await r.json(); } catch (e) {}
    return new ImportError(j.error || 'server_error', j.details, j.retryable, j.retryAfter);
  }
  async function downloadViaServer(href, ctrl) {
    const r = await fetchSrv('/api/import?url=' + encodeURIComponent(href), ctrl, 180000);
    if (!r.ok) throw await srvError(r);
    let blob;
    try { blob = await r.blob(); } catch (e) { throw new ImportError(ctrl.signal.aborted ? 'cancelled' : 'tiktok_download_failed', 'обрыв при получении файла', true); }
    if (!blob.size) throw new ImportError('tiktok_download_failed', 'сервер вернул пустой файл', true);
    const host = new URL(href).hostname.replace(/^www\./, '').split('.')[0] || 'video';
    const fname = (r.headers.get('X-File-Name') || 'video.mp4').replace(/^video/, host);
    return new File([blob], fname, { type: blob.type || 'video/mp4' });
  }

  function addLinkClip(u, emb, reason) {
    const clip = {
      id: uid(), kind: 'link', url: u.href, embed: emb, linkReason: reason || '', videoKey: null,
      fileName: `${emb.provider} · ${emb.id}`, source: u.href, srcDuration: 0,
      width: emb.vertical ? 1080 : 1920, height: emb.vertical ? 1920 : 1080, thumb: emb.thumb || '',
      placeId: freePlaceId(), caption: '', trimStart: 0, duration: 0, captionDelay: 0,
      fit: 'cover', focusX: 0.5, focusY: 0.5, muted: false, volume: 1, watermarks: [], wm: { status: 'none' },
    };
    S.p.clips.push(clip);
    S.sel = clip.id; S.tab = 'clip';
    save(); renderTabs(); renderClipList(); renderInspector();
    if (emb.provider === 'TikTok') {
      // Preview image for the queue card (TikTok oEmbed); purely cosmetic, failures are ignored.
      fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(u.href)).then(r => r.json()).then(j => {
        if (!j || !j.thumbnail_url || !S.p.clips.includes(clip) || clip.kind !== 'link') return;
        clip.thumb = j.thumbnail_url; save(); renderClipList();
        const img = $('.insp-head img'); if (img && S.sel === clip.id) img.src = clip.thumb;
      }).catch(() => {});
    }
    return clip;
  }

  /* ---- import status card (under the link field) ---- */
  const IMP = { busy: false, seq: 0, ctrl: null, last: '', card: null, tick: 0 };
  S.imp = IMP;
  function setImportCard(c) { IMP.card = c; renderImportCard(); }
  function renderImportCard() {
    const el = $('#importCard'); const c = IMP.card; clearInterval(IMP.tick);
    if (!c) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false; el.className = 'import-card ' + c.phase;
    const det = c.details ? `<small class="det">${esc(String(c.details).slice(0, 300))}</small>` : '';
    if (c.phase === 'loading') {
      el.innerHTML = `<div class="ic-row"><span class="spin"></span><b>${esc(c.text)}</b></div><div class="actions"><button type="button" class="small" data-imp="cancel">Отмена</button></div>`;
    } else if (c.phase === 'ok') {
      el.innerHTML = `<div class="ic-row"><b>✓ ${esc(c.text)}</b></div>`;
    } else {
      const alt = c.embedOnly
        ? '<b>Пока видеофайла нет, ролик можно только смотреть</b> во встроенном плеере справа. Редактировать его и включить в экспорт нельзя. Для монтажа загрузите видеофайл с устройства — подпись и место сохранятся.'
        : 'Можно загрузить исходный видеофайл с устройства — подпись и место сохранятся.';
      el.innerHTML = `<div class="ic-row"><b>${esc(c.title)}</b></div><p>${esc(c.text)}</p>${det}
        <p class="alt">${alt}</p>
        <div class="actions">${c.retryable ? '<button type="button" class="primary small" data-imp="retry">Повторить</button>' : ''}
        <button type="button" class="small" data-imp="file">Загрузить файл с устройства</button>
        <button type="button" class="ghost small" data-imp="close">Закрыть</button></div>`;
      const rb = el.querySelector('[data-imp="retry"]');
      if (rb && c.until) {
        const upd = () => { const left = Math.ceil((c.until - Date.now()) / 1000); if (left > 0) { rb.disabled = true; rb.textContent = `Повторить через ${left} с`; } else { rb.disabled = false; rb.textContent = 'Повторить'; clearInterval(IMP.tick); } };
        upd(); IMP.tick = setInterval(upd, 500);
      }
    }
  }
  function bindImportCard() {
    $('#importCard').addEventListener('click', e => {
      const b = e.target.closest('[data-imp]'); if (!b) return;
      const act = b.dataset.imp;
      if (act === 'cancel') { if (IMP.ctrl) IMP.ctrl.abort(); }
      else if (act === 'close') setImportCard(null);
      else if (act === 'retry') { if (IMP.last) importUrl(IMP.last); }
      else if (act === 'file') {
        const target = IMP.card && IMP.card.clipId ? clipById(IMP.card.clipId) : null;
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*,.mp4,.webm,.mov,.m4v,.mkv';
        inp.onchange = async () => {
          if (!inp.files[0]) return;
          const clip = await addFile(inp.files[0], target ? target.url : null, target && S.p.clips.includes(target) ? target : null);
          if (clip) { selectClip(clip.id); setImportCard({ phase: 'ok', text: `Файл загружен и воспроизводится: ${clip.fileName}` }); setTimeout(() => { if (IMP.card && IMP.card.phase === 'ok') setImportCard(null); }, 6000); }
        };
        inp.click();
      }
    });
  }

  /* One import = one isolated job: its own seq, AbortController, status card and result. Nothing is reused
     from a previous attempt except the clip for the *same* video (so Retry never creates duplicates). */
  async function importUrl(raw) {
    if (IMP.busy) { toast('Дождитесь окончания текущей загрузки или нажмите «Отмена».', 'info', 3500); return; }
    raw = String(raw || '').trim();
    let u;
    try { u = new URL(raw); } catch (e) { toast('Это не похоже на ссылку. Вставьте полный адрес, например https://www.tiktok.com/@user/video/…', 'error'); return; }
    if (!/^https?:$/.test(u.protocol)) { toast('Поддерживаются только ссылки http(s).', 'error'); return; }

    const seq = ++IMP.seq; IMP.busy = true; IMP.last = raw;
    const ctrl = IMP.ctrl = new AbortController();
    const btn = $('#urlBtn'); btn.disabled = true; btn.textContent = 'Загрузка…';
    setImportCard({ phase: 'loading', text: 'Проверяю ссылку…' });
    const step = text => { if (seq === IMP.seq) setImportCard({ phase: 'loading', text }); };
    let canon = u, linkClip = null, reason = null;
    try {
      // The download server (start.cmd) may have been started after the page was opened: look again.
      if (S.server.mode !== 'server') { step('Ищу сервер скачивания на этом компьютере…'); await checkServer(); }
      // 1. Any TikTok link (short, redirecting, with tracking parameters) -> one canonical video.
      if (isTikTok(u)) {
        const info = tiktokInfo(u);
        if (info && info.photo) throw new ImportError('tiktok_photo');
        if (S.server.mode === 'server') {
          step(isShortTikTok(u) ? 'Раскрываю короткую ссылку…' : 'Проверяю ссылку…');
          const r = await fetchSrv('/api/resolve?url=' + encodeURIComponent(u.href), ctrl, 30000);
          if (!r.ok) throw await srvError(r);
          canon = new URL((await r.json()).url);
        } else if (info && info.id) {
          canon = new URL(`https://www.tiktok.com/@${info.user || '_'}/video/${info.id}`);
        } else {
          throw new ImportError('unsupported_source', isShortTikTok(u)
            ? 'Короткую ссылку TikTok раскрывает только сервер на компьютере (start.cmd). Откройте ссылку в браузере и вставьте полный адрес из адресной строки.'
            : '');
        }
      }
      // 2. Already in the project? Reuse that clip (also makes Retry idempotent).
      const key = keyOfUrl(canon.href);
      const existing = findByLink(key);
      if (existing && existing.kind !== 'link') {
        selectClip(existing.id); setImportCard({ phase: 'ok', text: 'Этот ролик уже в проекте — выбрал его.' });
        setTimeout(() => { if (IMP.card && IMP.card.phase === 'ok') setImportCard(null); }, 5000);
        $('#urlInput').value = ''; return;
      }
      linkClip = existing || null;

      // 3. Show the video right away in the platform's official embedded player (watching only).
      const emb = parseLink(canon);
      const embeddable = !!(emb && emb.type === 'iframe');
      if (embeddable && !linkClip) { linkClip = addLinkClip(canon, emb, ''); $('#urlInput').value = ''; }

      // 4. Try to get the real video file -> verify it really plays -> only then call it "loaded".
      let clip = null;
      if (canServerDownload(canon)) {
        step(isTikTok(canon) ? 'Скачиваю ролик из TikTok…' : 'Скачиваю ролик…');
        const file = await downloadViaServer(canon.href, ctrl);
        if (ctrl.signal.aborted) throw new ImportError('cancelled');
        step('Проверяю, что видео воспроизводится…');
        clip = await addFile(file, canon.href, linkClip);
        if (!clip) throw new ImportError('unplayable');
      } else if (/\.(mp4|webm|mov|m4v)$/i.test(canon.pathname)) {
        step('Скачиваю файл по ссылке…');
        let blob;
        try { const r = await fetch(canon.href, { cache: 'no-store', signal: ctrl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); blob = await r.blob(); }
        catch (e) { throw new ImportError(ctrl.signal.aborted ? 'cancelled' : 'cors', String(e && e.message || '')); }
        step('Проверяю, что видео воспроизводится…');
        clip = await addFile(new File([blob], decodeURIComponent(canon.pathname.split('/').pop()) || 'video.mp4', { type: blob.type || 'video/mp4' }), canon.href, linkClip);
        if (!clip) throw new ImportError('unplayable');
      } else if (embeddable) {
        // No way to get the file: this is an honest "watch only" state, not a success and not an error.
        const why = S.server.mode === 'server'
          ? `${emb.provider} не отдаёт видеофайл напрямую. Автоматически его можно скачать только программой yt-dlp (необязательна, не установлена).`
          : `Здесь нет сервера скачивания, а браузер не может скачать видео с ${emb.provider} напрямую.${isTikTok(canon) ? ' На компьютере через start.cmd будет попытка скачать ролик TikTok.' : ''}`;
        linkClip.linkReason = why; save();
        setImportCard({ phase: 'info', title: `${emb.provider}: ролик добавлен только для просмотра`, text: why, embedOnly: true, retryable: false, clipId: linkClip.id });
        return;
      } else {
        throw new ImportError(S.server.mode === 'server' ? 'no_ytdlp' : 'unsupported_source',
          S.server.mode === 'server' ? '' : `Сайт открыт без локального сервера: браузер не может скачать видео с ${canon.hostname} напрямую.`);
      }
      $('#urlInput').value = '';
      selectClip(clip.id);
      setImportCard({ phase: 'ok', text: `Загружено и воспроизводится: ${clip.fileName} · ${fmt(clip.srcDuration)}` });
      setTimeout(() => { if (IMP.card && IMP.card.phase === 'ok') setImportCard(null); }, 7000);
    } catch (err) {
      if (!(err instanceof ImportError)) { console.error(err); err = new ImportError('server_error', String(err && err.message || err), true); }
      if (err.code === 'cancelled') { if (seq === IMP.seq) setImportCard(null); toast('Загрузка отменена.', 'info', 2500); return; }
      const [title, text] = IMPORT_MSG[err.code] || IMPORT_MSG.server_error;
      reason = err.details && err.code === 'unsupported_source' ? err.details : text;
      // Keep the video watchable: add (or keep) a link clip with the right embedded player.
      const emb2 = parseLink(canon);
      if (emb2 && (isTikTok(canon) ? tiktokInfo(canon) : true)) {
        if (!linkClip) { linkClip = addLinkClip(canon, emb2, reason); $('#urlInput').value = ''; }
        else { linkClip.linkReason = reason; save(); }
      }
      setImportCard({
        phase: 'error', embedOnly: !!(linkClip && linkClip.kind === 'link'),
        title, text: err.code === 'unsupported_source' && err.details ? err.details : text, details: err.code === 'unsupported_source' ? '' : err.details,
        retryable: err.retryable, until: err.retryAfter ? Date.now() + err.retryAfter * 1000 : 0, clipId: linkClip ? linkClip.id : null,
      });
    } finally {
      if (seq === IMP.seq) { IMP.busy = false; IMP.ctrl = null; btn.disabled = false; btn.textContent = 'Импорт'; }
    }
  }

  /* ---------- watermark detection queue ---------- */
  function queueDetect(clip) {
    clip._wmBusy = true; clip._wmProgress = 0; renderClipList(); if (S.sel === clip.id && S.tab === 'clip') renderInspector();
    S.detectQ = S.detectQ.then(async () => {
      if (!S.p.clips.includes(clip)) return;
      const url = S.urls.get(clip.videoKey);
      try {
        if (!url) throw new Error('видео не загружено');
        const r = await WM.detect(url, clip.srcDuration, p => { clip._wmProgress = p; const b = $('#wmProg'); if (b && S.sel === clip.id) b.style.width = Math.round(p * 100) + '%'; });
        clip.watermarks = clip.watermarks.filter(x => x.source !== 'auto').concat(r.regions.map(g => ({
          id: uid(), ...g, method: 'inpaint', strength: 55, enabled: true, source: 'auto',
        })));
        clip.wm = r.regions.length
          ? { status: 'found', message: `Найдено областей: ${r.regions.length}. Проверьте результат в режиме «После» на разных кадрах.${r.lowMotion ? ' Видео почти статично — возможны ложные срабатывания.' : ''}` }
          : { status: 'notfound', message: 'Водяной знак не найден автоматически. Если он есть — отметьте область вручную, протянув мышью по кадру.' };
      } catch (e) {
        clip.wm = { status: 'error', message: 'Автопоиск не удался (' + (e.message || e) + '). Отметьте область вручную.' };
      }
      clip._wmBusy = false;
      save(); renderClipList(); if (S.sel === clip.id && S.tab === 'clip') renderInspector(); S.engine.redraw();
    });
  }

  /* ---------- preview engine ---------- */
  function refreshSegments(focusId, offset) {
    const eng = S.engine; const wasT = eng.time();
    eng.setSegments(buildSegments());
    const seg = focusId && eng.segs.find(s => s.clip.id === focusId);
    const t = seg ? seg.start + Math.min(offset != null ? offset : 0.001, Math.max(0, seg.dur - 0.02)) : Math.min(wasT, eng.total);
    eng.seek(t);
    updateTransport(eng.time(), eng.total);
  }
  /* Local time (in the clip) at which its caption is fully visible — used when selecting a clip in the editor. */
  function captionVisibleAt(c) {
    const i = S.engine.segs.findIndex(s => s.clip.id === c.id);
    const prev = i > 0 ? S.engine.segs[i - 1].clip : null;
    const hasPrev = !!(prev && prev.placeId && prev.placeId !== c.placeId);
    return R.captionStart(S.p.style, c, hasPrev) + R.transitionOf(S.p.style) + 0.05;
  }
  function seekToClip(c, local) { const seg = S.engine.segs.find(s => s.clip.id === c.id); if (seg) S.engine.seek(seg.start + clamp(local, 0, seg.dur - 0.02)); }

  function updateTransport(t, total) {
    if (!S.scrubbing) $('#scrub').value = total ? Math.round(t / total * 1000) : 0;
    $('#timeLabel').textContent = `${fmt(t)} / ${fmt(total)}`;
    const eng = S.engine; const seg = eng.cur >= 0 ? eng.segs[eng.cur] : null;
    let info = '';
    if (seg) {
      const i = placeIdx(seg.clip.placeId);
      info = `Клип ${eng.cur + 1} из ${eng.segs.length} · ${i >= 0 ? 'место ' + (i + 1) : 'без места'}${seg.clip.caption ? ' · «' + seg.clip.caption + '»' : ''}`;
    } else info = S.p.clips.length ? 'Клипы-ссылки смотрите в плеере справа; в сборку они попадут после загрузки файла' : 'Предпросмотр оформления — добавьте видео, чтобы собрать ролик';
    $('#nowInfo').textContent = info;
    const curId = seg ? seg.clip.id : null;
    $$('#clipList .clip').forEach(li => li.classList.toggle('playing', li.dataset.id === curId));
  }

  /* ---------- clip list ---------- */
  function placeOptions(selId, withNone = true) {
    return (withNone ? `<option value="">— без места —</option>` : '') + S.p.places.map((p, i) =>
      `<option value="${p.id}" ${p.id === selId ? 'selected' : ''}>${i + 1}${p.name ? '. ' + esc(p.name) : ''}</option>`).join('');
  }
  function wmBadge(c) {
    if (c._wmBusy) return `<span class="badge run">ищем знак ${Math.round((c._wmProgress || 0) * 100)}%</span>`;
    const n = c.watermarks.filter(r => r.enabled !== false).length;
    const errs = Object.keys(WM.validate(c)).length;
    if (errs) return '<span class="badge err">ошибка обработки</span>';
    if (n) return `<span class="badge ok">знак: ${n}</span>`;
    if (c.wm.status === 'notfound') return '<span class="badge warn">знак не найден</span>';
    return '';
  }
  function renderClipList() {
    const list = $('#clipList'); const clips = S.p.clips;
    $('#clipEmpty').style.display = clips.length ? 'none' : '';
    $('#clipCount').textContent = clips.length ? `${clips.length} · ${fmt(clips.reduce((a, c) => a + clipDur(c), 0))}` : '';
    list.innerHTML = clips.map((c, i) => `
      <li class="clip ${c.id === S.sel ? 'sel' : ''}" draggable="true" data-id="${c.id}">
        <span class="drag" title="Перетащите">⋮⋮</span>
        ${c.thumb ? `<img class="thumb" src="${esc(c.thumb)}" alt="">` : `<div class="thumb ph">${c.kind === 'link' ? '▶' : '?'}</div>`}
        <div class="meta">
          <div class="r1"><span class="ord">#${i + 1}</span><span class="cap ${c.caption ? '' : 'none'}">${c.caption ? esc(c.caption) : (c.kind === 'link' ? esc(c.embed.provider) + ' (ссылка)' : 'без подписи')}</span></div>
          <div class="r2">
            <select data-list-place title="Место в рейтинге">${placeOptions(c.placeId)}</select>
            ${c.kind === 'link' ? '<span class="badge warn" title="Видео не скачано — в итоговый ролик не попадёт">только ссылка</span>'
              : `<span>${clipDur(c).toFixed(1)} с</span>${wmBadge(c)}${S.urls.has(c.videoKey) ? '' : '<span class="badge err">нет файла</span>'}`}
          </div>
        </div>
        <div class="btns">
          <button data-act="up" title="Раньше" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button data-act="down" title="Позже" ${i === clips.length - 1 ? 'disabled' : ''}>▼</button>
          <button data-act="del" title="Удалить">✕</button>
        </div>
      </li>`).join('');
    updateTransport(S.engine.time(), S.engine.total);
  }

  function moveClip(id, toIndex) {
    const a = S.p.clips; const from = a.findIndex(c => c.id === id); if (from < 0) return;
    const [c] = a.splice(from, 1); a.splice(clamp(toIndex, 0, a.length), 0, c);
    save(); renderClipList(); if (S.tab === 'clip' || S.tab === 'places') renderInspector(); refreshSegments(id);
  }
  /* Deletes immediately (no browser dialog — embedded browsers may block confirm()) and offers "Undo".
     The video file is removed from storage only when the undo window has passed. */
  function deleteClip(id) {
    if (S.exp) { toast('Дождитесь окончания сборки, затем удаляйте клипы.', 'warn'); return; }
    const idx = S.p.clips.findIndex(x => x.id === id); if (idx < 0) return;
    const c = S.p.clips[idx];
    const placeNo = placeIdx(c.placeId);
    S.engine.pause();
    S.p.clips.splice(idx, 1);
    if (S.sel === id) S.sel = (S.p.clips[idx] || S.p.clips[idx - 1] || {}).id || null;
    if (S.wm.key === id) {
      if (S.wm.video) { S.wm.video.removeAttribute('src'); S.wm.video.load(); }
      S.wm.video = null; S.wm.key = null; S.wm.selRegion = null;
    }
    if (S.cleanExport && S.cleanExport.clipId === id) S.cleanExport = null;
    save(); renderClipList(); renderInspector(); refreshSegments(S.sel);
    let undone = false;
    const timer = setTimeout(() => { if (!undone) purgeVideo(c); }, 10000);
    toastAction(`Клип «${esc(c.caption || c.fileName)}» удалён${placeNo >= 0 ? `, место ${placeNo + 1} освобождено` : ''}.`, 'Отменить', () => {
      undone = true; clearTimeout(timer);
      S.p.clips.splice(Math.min(idx, S.p.clips.length), 0, c);
      S.sel = c.id; S.tab = 'clip';
      save(); renderTabs(); renderClipList(); renderInspector(); refreshSegments(c.id);
      toast('Клип восстановлен.', 'ok', 2000);
    }, 10000);
  }
  function purgeVideo(c) {
    if (!c.videoKey || S.p.clips.some(x => x.videoKey === c.videoKey)) return;
    DB.del('blobs', c.videoKey).catch(() => {});
    const u = S.urls.get(c.videoKey); if (u) URL.revokeObjectURL(u);
    S.urls.delete(c.videoKey);
  }

  function toastAction(html, label, onAction, ms = 8000) {
    const el = document.createElement('div'); el.className = 'toast warn has-action';
    el.innerHTML = `<span>${html}</span><button type="button" class="small">${esc(label)}</button>`;
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
    el.querySelector('button').onclick = e => { e.stopPropagation(); close(); onAction(); };
    $('#toasts').append(el); setTimeout(close, ms);
  }

  /* In-page confirmation dialog (works where window.confirm is blocked). Resolves true/false. */
  function ask(text, okLabel = 'Да') {
    return new Promise(res => {
      const wrap = document.createElement('div'); wrap.className = 'modal-wrap';
      wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p>${esc(text)}</p>
        <div class="actions"><button type="button" data-v="0">Отмена</button><button type="button" class="primary" data-v="1">${esc(okLabel)}</button></div></div>`;
      let finished = false;
      const done = v => { if (finished) return; finished = true; wrap.remove(); document.removeEventListener('keydown', key, true); res(v); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
      wrap.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); else if (e.target === wrap) done(false); });
      document.addEventListener('keydown', key, true);
      document.body.append(wrap); wrap.querySelector('[data-v="1"]').focus();
    });
  }
  function selectClip(id, seek = true) {
    S.sel = id; S.wm.selRegion = null;
    renderClipList();
    if (S.tab !== 'clip') S.tab = 'clip';
    renderTabs(); renderInspector();
    const c = clipById(id); if (c && seek) { S.engine.pause(); seekToClip(c, captionVisibleAt(c)); }
  }

  function bindClipList() {
    const list = $('#clipList');
    list.addEventListener('click', e => {
      const li = e.target.closest('.clip'); if (!li) return;
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      const id = li.dataset.id; const idx = S.p.clips.findIndex(c => c.id === id);
      if (act === 'up') moveClip(id, idx - 1);
      else if (act === 'down') moveClip(id, idx + 1);
      else if (act === 'del') deleteClip(id);
      else if (!e.target.closest('select')) selectClip(id);
    });
    list.addEventListener('change', e => {
      if (!e.target.matches('[data-list-place]')) return;
      const c = clipById(e.target.closest('.clip').dataset.id);
      c.placeId = e.target.value || null; save(); renderClipList(); renderInspector(); S.engine.redraw(); updateTransport(S.engine.time(), S.engine.total);
    });
    let dragId = null, drop = null;
    const clearMarks = () => $$('.drop-before,.drop-after', list).forEach(x => x.classList.remove('drop-before', 'drop-after'));
    list.addEventListener('dragstart', e => {
      const li = e.target.closest('.clip'); if (!li) return;
      dragId = li.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
      li.classList.add('dragging');
    });
    list.addEventListener('dragover', e => {
      if (!dragId) return; e.preventDefault(); clearMarks();
      const li = e.target.closest('.clip'); drop = null;
      if (li && li.dataset.id !== dragId) {
        const r = li.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
        li.classList.add(after ? 'drop-after' : 'drop-before'); drop = { id: li.dataset.id, after };
      }
    });
    list.addEventListener('drop', e => {
      if (!dragId) return; e.preventDefault(); e.stopPropagation();
      if (drop) {
        const ids = S.p.clips.map(c => c.id).filter(x => x !== dragId);
        let to = ids.indexOf(drop.id) + (drop.after ? 1 : 0);
        moveClip(dragId, to);
      }
    });
    list.addEventListener('dragend', () => { dragId = null; drop = null; clearMarks(); $$('.dragging', list).forEach(x => x.classList.remove('dragging')); });
  }

  /* ---------- inspector ---------- */
  function renderTabs() { $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab)); }
  function renderInspector() {
    const el = $('#inspector');
    if (S.tab === 'clip') { el.innerHTML = clipTabHTML(selClip()); afterClipTab(); }
    else if (S.tab === 'places') el.innerHTML = placesTabHTML();
    else if (S.tab === 'design') el.innerHTML = designTabHTML();
    else if (S.tab === 'export') { el.innerHTML = exportTabHTML(); renderExportState(); }
  }

  const rangeField = (label, attr, val, min, max, step) => `
    <div class="field"><label>${label}</label><div class="rangebox">
      <input type="range" ${attr} min="${min}" max="${max}" step="${step}" value="${val}">
      <input type="number" ${attr} min="${min}" max="${max}" step="${step}" value="${val}">
    </div></div>`;
  const segBtns = (attr, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" ${attr} data-val="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  function clipTabHTML(c) {
    if (!c) return '<div class="empty big">Выберите клип в очереди слева или добавьте видео.</div>';
    if (c.kind === 'link') return linkTabHTML(c);
    const order = S.p.clips.indexOf(c) + 1, n = S.p.clips.length, dur = clipDur(c), src = c.srcDuration || 0;
    const errs = WM.validate(c);
    const status = c._wmBusy ? `<span class="badge run">поиск…</span>` : ({ found: '<span class="badge ok">найден</span>', notfound: '<span class="badge warn">не найден</span>', error: '<span class="badge err">ошибка</span>' }[c.wm.status] || '');
    return `
      <div class="insp-head"><img src="${c.thumb || ''}" alt=""><div>
        <b title="${esc(c.fileName)}">${esc(c.fileName)}</b>
        <small>${c.width}×${c.height} · исходник ${fmt(src)} · показ ${order} из ${n}</small>
        ${S.urls.has(c.videoKey) ? '' : '<small class="err">Файл видео не найден в хранилище браузера — удалите клип и добавьте видео снова.</small>'}
      </div></div>
      ${S.urls.has(c.videoKey) ? `<details class="src" ${S.srcOpen !== false ? 'open' : ''}>
        <summary>Исходное видео${/^https?:/.test(c.source || '') ? ' — скачано по ссылке' : ''}</summary>
        <div class="player-box ${c.height >= c.width ? 'vertical' : 'wide'}"><video class="src-player" src="${S.urls.get(c.videoKey)}" controls playsinline preload="metadata"></video></div>
        ${/^https?:/.test(c.source || '') ? `<small><a href="${esc(c.source)}" target="_blank" rel="noopener noreferrer">Открыть источник</a></small>` : ''}
      </details>` : ''}
      <div class="field"><label>Подпись к клипу (видна только во время этого клипа)</label>
        <input type="text" data-cf="caption" value="${esc(c.caption)}" placeholder="Например: Крокодил 🐊" maxlength="80"></div>
      <div class="field"><label>Место в рейтинге</label><select data-cf="placeId">${placeOptions(c.placeId)}</select></div>
      <div class="group">
        <h3>Тайминг</h3>
        ${rangeField('Начало в исходнике, с', 'data-cf="trimStart"', r2(c.trimStart || 0), 0, r2(Math.max(0, src - 0.1)), 0.1)}
        ${rangeField('Длительность показа, с', 'data-cf="duration"', r2(dur), 0.1, r2(Math.max(0.1, src - (c.trimStart || 0))), 0.1)}
        ${rangeField('Подпись появляется через, с', 'data-cf="captionDelay"', r2(Math.min(c.captionDelay || 0, dur)), 0, r2(dur), 0.1)}
      </div>
      <div class="group">
        <h3>Кадр и звук</h3>
        <div class="field"><label>Размещение в 9:16</label>${segBtns('data-cf-set="fit"', c.fit, [['cover', 'Заполнить кадр'], ['contain', 'Вписать + размытый фон']])}</div>
        ${c.fit !== 'contain' ? `<div class="grid2">${rangeField('Сдвиг по X', 'data-cf="focusX"', c.focusX != null ? c.focusX : 0.5, 0, 1, 0.01)}${rangeField('Сдвиг по Y', 'data-cf="focusY"', c.focusY != null ? c.focusY : 0.5, 0, 1, 0.01)}</div>` : ''}
        <div class="field row"><label class="check"><input type="checkbox" data-cf="sound" ${c.muted ? '' : 'checked'}> Звук клипа</label>
          <input type="range" data-cf="volume" min="0" max="1.5" step="0.05" value="${c.volume != null ? c.volume : 1}" title="Громкость"></div>
      </div>
      <div class="group">
        <div class="sec-head"><h3>Водяной знак TikTok</h3>${status}</div>
        ${c.wm.message ? `<p class="hint" style="margin:0">${esc(c.wm.message)}</p>` : ''}
        ${c._wmBusy ? `<div class="progress"><div id="wmProg" style="width:${Math.round((c._wmProgress || 0) * 100)}%"></div></div>` : ''}
        <div class="sec-head">${segBtns('data-wm-view', S.wm.view, [['before', 'До (разметка)'], ['after', 'После']])}
          <button type="button" class="small" data-act="detect" ${c._wmBusy ? 'disabled' : ''}>Найти авто</button></div>
        <div class="wm-canvas-wrap"><canvas id="wmCanvas"></canvas></div>
        <div class="rangebox"><input type="range" id="wmTime" min="0" max="${r2(src)}" step="0.05" value="${r2(S.wm.time)}"><span id="wmTimeLbl" class="time">${fmt(S.wm.time)}</span></div>
        <p class="hint" style="margin:0">«До»: протяните мышью по кадру, чтобы отметить водяной знак; перетаскивайте область, за правый нижний угол — меняйте размер. «После»: так кадр будет выглядеть в итоговом ролике.</p>
        ${c.watermarks.map((r, i) => regionHTML(c, r, i, errs[r.id])).join('') || '<div class="empty">Областей нет.</div>'}
        <div class="actions"><button type="button" class="small" data-act="add-region">+ Добавить область</button>
          ${c.watermarks.length ? '<button type="button" class="small danger" data-act="clear-regions">Удалить все</button>' : ''}</div>
      </div>
      <div class="actions">
        <button type="button" data-act="clean-export" ${S.exp ? 'disabled' : ''}>Сохранить очищенный клип</button>
        <button type="button" class="danger" data-act="del-clip">Удалить клип</button>
      </div>
      <div id="cleanState"></div>`;
  }

  function linkTabHTML(c) {
    const e = c.embed, order = S.p.clips.indexOf(c) + 1, n = S.p.clips.length;
    let canDl = false; try { canDl = canServerDownload(new URL(c.url)); } catch (err) {}
    const player = e.type === 'video'
      ? `<video class="src-player" src="${esc(e.src)}" controls playsinline preload="metadata"></video>`
      : `<iframe src="${esc(e.src)}" title="${esc(e.provider)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    const fileNote = location.protocol === 'file:' && e.provider === 'YouTube' ? ' Если плеер YouTube показывает ошибку, запустите сайт через start.cmd: YouTube не всегда работает на страницах, открытых как файл.' : '';
    return `
      <div class="insp-head">${c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : ''}<div>
        <b title="${esc(c.url)}">${esc(c.fileName)}</b>
        <small><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Открыть источник</a> · показ ${order} из ${n}</small>
      </div></div>
      <div class="player-box ${e.vertical ? 'vertical' : 'wide'}">${player}</div>
      <p class="hint" style="margin:0">Это официальный плеер ${esc(e.provider)}: только просмотр. Если он пустой или пишет «видео недоступно», автор запретил встраивание, ролик удалён или закрыт — откройте источник по ссылке выше.${fileNote}</p>
      <div class="warnbox">Этот клип пока только ссылка — в итоговый ролик он не попадёт: браузер не может записывать кадры чужого плеера.
        ${c.linkReason ? '<br>' + esc(c.linkReason) : ''}
        <br>Чтобы включить его в сборку, ${canDl ? 'скачайте его в проект' : 'загрузите видеофайл этого ролика'} — подпись и место сохранятся.</div>
      <div class="actions">
        ${canDl ? '<button type="button" class="primary" data-act="link-download">Скачать в проект</button>' : ''}
        <button type="button" data-act="link-attach">Загрузить файл для этого клипа</button>
      </div>
      <div class="field"><label>Подпись к клипу</label>
        <input type="text" data-cf="caption" value="${esc(c.caption)}" placeholder="Например: Крокодил 🐊" maxlength="80"></div>
      <div class="field"><label>Место в рейтинге</label><select data-cf="placeId">${placeOptions(c.placeId)}</select></div>
      <div class="actions"><button type="button" class="danger" data-act="del-clip">Удалить клип</button></div>`;
  }

  // "Скачать в проект" on a link clip = the same isolated import flow (it finds this clip by its link).
  function downloadIntoClip(c) { importUrl(c.url); }

  function regionHTML(c, r, i, err) {
    const src = r2(c.srcDuration || 0);
    return `
      <div class="region ${r.id === S.wm.selRegion ? 'sel' : ''}" data-rid="${r.id}">
        <div class="r-head"><b>#${i + 1}</b><span class="badge">${r.source === 'auto' ? 'авто' : 'вручную'}</span><span class="sp"></span>
          <label class="check"><input type="checkbox" data-rf="enabled" ${r.enabled !== false ? 'checked' : ''}> вкл.</label>
          <button type="button" class="small danger" data-act="del-region" title="Удалить область">✕</button></div>
        ${segBtns('data-rf-set="method"', r.method, [['inpaint', 'Восстановить фон'], ['blur', 'Размыть'], ['crop', 'Кадрировать']])}
        ${rangeField('Сила эффекта', 'data-rf="strength"', r.strength != null ? r.strength : 50, 0, 100, 1)}
        <div class="r-time">
          <div class="field"><label>С, сек <a href="#" data-act="t0-now">← текущий кадр</a></label><input type="number" data-rf="t0" min="0" max="${src}" step="0.05" value="${r2(r.t0 || 0)}"></div>
          <div class="field"><label>До, сек <a href="#" data-act="t1-now">← текущий кадр</a></label><input type="number" data-rf="t1" min="0" max="${src}" step="0.05" value="${r2(r.t1 != null ? r.t1 : src)}"></div>
        </div>
        ${err ? `<div class="errbox">${esc(err.msg)}<button type="button" class="small" data-act="switch-method" data-val="${err.alt}">Переключить на «${err.alt === 'blur' ? 'Размытие' : 'Восстановление фона'}»</button></div>` : ''}
      </div>`;
  }

  function placesTabHTML() {
    const P = S.p;
    return `
      <p class="hint" style="margin:0">Место — это номер в рейтинге. Очередь показа задаётся слева и от номера не зависит: клип места №3 может идти первым.</p>
      ${P.places.map((p, i) => {
        const clips = P.clips.filter(c => c.placeId === p.id);
        return `<div class="place" data-pid="${p.id}">
          <div class="pnum" style="color:${placeColor(i)}">${i + 1}.</div>
          <div class="pbody">
            <input type="text" data-pf="name" value="${esc(p.name)}" placeholder="Название места (необязательно)" maxlength="60">
            <div class="chips">${clips.length ? clips.map(c => `<span class="chip" data-goto="${c.id}">#${P.clips.indexOf(c) + 1} ${esc(c.caption || c.fileName)}</span>`).join('') : '<small>клип не назначен</small>'}</div>
          </div>
          <div class="pbtns">
            <button type="button" data-act="p-up" ${i === 0 ? 'disabled' : ''} title="Выше">▲</button>
            <button type="button" data-act="p-down" ${i === P.places.length - 1 ? 'disabled' : ''} title="Ниже">▼</button>
            <button type="button" data-act="p-del" title="Удалить место">✕</button>
          </div></div>`;
      }).join('') || '<div class="empty">Мест нет — добавьте хотя бы одно.</div>'}
      <div class="actions">
        <button type="button" data-act="p-add">+ Добавить место</button>
        <button type="button" data-act="p-countdown" ${P.clips.length ? '' : 'disabled'} title="Первый клип в очереди — последнее место, последний — место №1">Назначить обратным отсчётом</button>
      </div>
      <p class="hint" style="margin:0">После показа клипа его место остаётся в списке полупрозрачным с названием места; если название пустое — с подписью клипа.</p>`;
  }

  function designTabHTML() {
    const s = S.p.style;
    const color = (label, key) => `<label class="colorrow">${label}<input type="color" data-style="${key}" value="${s[key]}"></label>`;
    const rng = (label, key, min, max, step) => rangeField(label, `data-style="${key}"`, s[key], min, max, step);
    const chk = (label, key) => `<label class="check"><input type="checkbox" data-style="${key}" ${s[key] ? 'checked' : ''}> ${label}</label>`;
    return `
      <div class="group">
        <h3>Заголовок</h3>
        <textarea data-proj="title" rows="3" placeholder="Заголовок рейтинга">${esc(S.p.title)}</textarea>
        <p class="hint" style="margin:0"><b>*слово*</b> — акцентный цвет 1, <b>{слово}</b> — акцентный цвет 2, Enter — новая строка.</p>
        <div class="field"><label>Шрифт</label><select data-style="font">${FONTS.map(f => `<option value="${f.id}" ${f.id === s.font ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
        ${rng('Размер заголовка', 'titleSize', 3, 12, 0.1)}
        <div class="grid2">${color('Текст', 'titleColor')}${color('Фон полосы', 'bandColor')}${color('Акцент 1', 'accent1')}${color('Акцент 2', 'accent2')}</div>
        ${chk('Заголовок поверх видео (без полосы)', 'titleOverVideo')}
        ${s.titleOverVideo ? rng('Положение заголовка по высоте, %', 'titleY', 3, 40, 0.5) : rng('Высота полосы заголовка, %', 'bandHeight', 6, 30, 0.5)}
      </div>
      <div class="group">
        <h3>Список мест</h3>
        <div class="grid2">${rng('Отступ слева, %', 'listX', 1, 60, 0.5)}${rng('Начало по высоте, %', 'listY', 5, 90, 0.5)}</div>
        <div class="grid2">${rng('Шаг между местами, %', 'listGap', 3, 15, 0.1)}${rng('Размер цифр', 'numberSize', 3, 12, 0.1)}</div>
        <div class="grid2">${color('Цвет цифр', 'numberColor')}${color('Текущее место', 'highlightColor')}</div>
        ${chk('Золото / серебро / бронза для 1–3 мест', 'medalColors')}
        ${rng('Прозрачность прошлых подписей (0 — скрывать)', 'revealedOpacity', 0, 1, 0.05)}
        ${rng('Длительность перехода между местами, с', 'transition', 0.1, 1.2, 0.05)}
        <p class="hint" style="margin:0">При смене клипа подпись прошлого места плавно становится полупрозрачной, затем появляется подпись нового места.</p>
      </div>
      <div class="group">
        <h3>Подпись клипа</h3>
        <div class="field"><label>Положение</label>${segBtns('data-style-set="captionPos"', s.captionPos, [['list', 'В списке у номера'], ['free', 'Свободно']])}</div>
        ${s.captionPos === 'free' ? `<div class="grid2">${rng('По горизонтали, %', 'captionX', 5, 95, 0.5)}${rng('По вертикали, %', 'captionY', 5, 95, 0.5)}</div>` : ''}
        ${rng('Размер подписи', 'captionSize', 2, 10, 0.1)}
        <div class="grid2">${color('Цвет текста', 'captionColor')}${color('Обводка', 'captionStrokeColor')}</div>
        ${rng('Толщина обводки', 'captionStrokeWidth', 0, 16, 0.5)}
        <div class="grid2">${color('Фон подписи', 'captionBg')}<span></span></div>
        ${rng('Прозрачность фона (0 — нет фона)', 'captionBgOpacity', 0, 1, 0.05)}
        ${chk('Анимация появления', 'captionAnim')}
      </div>
      <div class="group">
        <h3>Обводка заголовка и цифр</h3>
        <div class="grid2">${color('Цвет обводки', 'strokeColor')}<span></span></div>
        ${rng('Толщина', 'strokeWidth', 0, 16, 0.5)}
      </div>
      <div class="actions">
        <button type="button" data-act="style-reset">Сбросить оформление</button>
        <button type="button" data-act="settings-save">Скачать настройки</button>
        <button type="button" data-act="settings-load">Загрузить настройки</button>
      </div>
      <p class="hint" style="margin:0">Текст и оформление сохраняются автоматически в этом браузере. «Скачать настройки» — JSON-файл без видео, чтобы перенести оформление.</p>`;
  }

  /* ---------- export tab ---------- */
  function pickMime() {
    if (!window.MediaRecorder) return null;
    const list = ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) || null;
  }
  function exportIssues() {
    const errors = [], warns = [];
    const segs = buildSegments();
    if (!segs.length) errors.push('Добавьте хотя бы один клип с доступным видеофайлом.');
    if (!pickMime()) errors.push('Браузер не поддерживает запись видео (MediaRecorder). Откройте сайт в свежем Chrome, Edge или Firefox.');
    S.p.clips.forEach((c, i) => {
      const e = WM.validate(c);
      Object.values(e).forEach(x => errors.push(`Клип #${i + 1}: ${x.msg}`));
      if (c.kind === 'link') warns.push(`Клип #${i + 1} (${c.embed.provider}) — только ссылка, в ролик не попадёт. Скачайте его в проект или загрузите файл.`);
      else if (!S.urls.has(c.videoKey)) warns.push(`Клип #${i + 1}: нет видеофайла — он будет пропущен.`);
      else if (!c.placeId) warns.push(`Клип #${i + 1} не назначен ни одному месту — подпись будет показана в свободной позиции.`);
      if (c.wm.status === 'found' && c.watermarks.length) { /* ok */ }
    });
    return { errors, warns, segs };
  }
  function exportTabHTML() {
    const o = S.p.output; const mime = pickMime(); const iss = exportIssues();
    const total = iss.segs.reduce((a, s) => a + s.dur, 0);
    return `
      <div class="group">
        <h3>Параметры</h3>
        <div class="grid2">
          <div class="field"><label>Разрешение</label><select data-out="res"><option value="1080" ${o.res === '1080' ? 'selected' : ''}>1080×1920</option><option value="720" ${o.res === '720' ? 'selected' : ''}>720×1280</option></select></div>
          <div class="field"><label>Кадров/с</label><select data-out="fps"><option value="30" ${+o.fps === 30 ? 'selected' : ''}>30</option><option value="60" ${+o.fps === 60 ? 'selected' : ''}>60</option></select></div>
        </div>
        <label class="check"><input type="checkbox" data-out="audio" ${o.audio ? 'checked' : ''}> Оригинальный звук клипов</label>
        <p class="hint" style="margin:0">Формат: <b>${mime ? (mime.startsWith('video/mp4') ? 'MP4 (H.264)' : 'WebM') : 'не поддерживается'}</b> · длительность ${fmt(total)} · клипов: ${iss.segs.length}.
        ${mime && !mime.startsWith('video/mp4') ? '<br>Этот браузер пишет только WebM: YouTube его принимает, для TikTok/Reels может понадобиться конвертация в MP4 (в Chrome/Edge 126+ запись идёт сразу в MP4).' : ''}</p>
        <p class="hint" style="margin:0">Сборка идёт в реальном времени (ролик 40 с собирается ~40 с). Не сворачивайте и не переключайте вкладку — браузер замедляет фоновые вкладки. Музыка не добавляется — только звук ваших клипов.</p>
      </div>
      ${iss.errors.length ? `<div class="errbox"><b>Сборка невозможна:</b>${iss.errors.map(e => `<span>• ${esc(e)}</span>`).join('')}</div>` : ''}
      ${iss.warns.length ? `<div class="warnbox">${iss.warns.map(e => `• ${esc(e)}`).join('<br>')}</div>` : ''}
      <div class="actions">
        <button type="button" class="primary" data-act="export" ${iss.errors.length || S.exp ? 'disabled' : ''}>Собрать видео</button>
        <button type="button" data-act="preview-all" ${iss.segs.length ? '' : 'disabled'}>Предпросмотр с начала</button>
      </div>
      <div id="expState"></div>`;
  }
  function renderExportState() {
    const el = $('#expState'); if (!el) return;
    if (S.exp) {
      const p = S.exp.total ? S.exp.t / S.exp.total : 0;
      el.innerHTML = `<div class="group"><h3>${S.exp.kind === 'clean' ? 'Сохранение очищенного клипа' : 'Сборка ролика'}…</h3>
        <div class="progress"><div style="width:${Math.round(p * 100)}%"></div></div>
        <small>${fmt(S.exp.t)} из ${fmt(S.exp.total)} · ${Math.round(p * 100)}%${document.hidden ? ' · вкладка в фоне — запись замедлится!' : ''}</small>
        <button type="button" data-act="export-cancel" class="danger">Отменить</button></div>`;
    } else if (S.lastExport) {
      const L = S.lastExport;
      el.innerHTML = `<div class="group result"><h3>Готово: ${esc(L.name)}</h3>
        <video src="${L.url}" controls playsinline></video>
        <small>${(L.size / 1048576).toFixed(1)} МБ · ${esc(L.mime)}</small>
        <a class="download" href="${L.url}" download="${esc(L.name)}">Скачать видео</a></div>`;
    } else el.innerHTML = '';
  }

  /* ---------- export (whole video or cleaned clip) ---------- */
  async function runExport(kind, clip) {
    if (S.exp) return;
    const mime = pickMime();
    if (!mime) { toast('Браузер не поддерживает запись видео (MediaRecorder).', 'error'); return; }
    let W, H, segs, render;
    if (kind === 'clean') {
      const errs = WM.validate(clip);
      if (Object.keys(errs).length) { toast('Сначала исправьте ошибки обработки водяного знака у этого клипа.', 'error'); return; }
      const url = S.urls.get(clip.videoKey); if (!url) { toast('Видеофайл клипа не найден.', 'error'); return; }
      const cr = R.cropRect(clip, clip.width, clip.height);
      const sc = Math.min(1, 1920 / Math.max(cr.w, cr.h));
      W = Math.max(2, Math.round(cr.w * sc / 2) * 2); H = Math.max(2, Math.round(cr.h * sc / 2) * 2);
      segs = [{ clip, url, start: 0, dur: clipDur(clip) }];
      const solo = { ...clip, fit: 'cover', focusX: 0.5, focusY: 0.5 };
      render = (ctx, w, h, f) => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        if (f.seg && f.video && f.video.readyState >= 2) { Object.assign(solo, f.seg.clip, { fit: 'cover', focusX: 0.5, focusY: 0.5 }); R.drawClipVideo(ctx, f.video, solo, { x: 0, y: 0, w, h }, f.video.currentTime); }
      };
    } else {
      const iss = exportIssues();
      if (iss.errors.length) { toast(iss.errors.map(esc).join('<br>'), 'error', 10000); return; }
      segs = iss.segs; W = S.p.output.res === '720' ? 720 : 1080; H = W === 720 ? 1280 : 1920;
      render = (ctx, w, h, f) => R.drawFrame(ctx, w, h, S.p, f);
    }
    const fps = +S.p.output.fps || 30;
    const withAudio = !!S.p.output.audio;
    S.engine.pause();
    const actx = AudioHub.get();
    const dest = withAudio && actx ? actx.createMediaStreamDestination() : null;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const eng = new Engine(canvas, { render, monitor: false, recDest: dest, audio: withAudio });
    eng.setSegments(segs);
    const total = segs.reduce((a, s) => a + s.dur, 0);
    S.exp = { kind, t: 0, total, cancel: null };
    if (S.lastExport && kind === 'full') { /* keep old until replaced */ }
    document.body.classList.add('busy');
    if (kind === 'full') { S.tab = 'export'; renderTabs(); renderInspector(); } else renderCleanState();
    let rec = null, chunks = [], failed = null, cancelled = false;
    try {
      await loadFonts();
      await eng.seek(0);
      const stream = canvas.captureStream(fps);
      if (dest) dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: W >= 1080 ? 12e6 : 6e6, audioBitsPerSecond: 192000 });
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(res => { rec.onstop = res; });
      rec.onerror = e => { failed = e.error || new Error('MediaRecorder error'); };
      eng.on('time', t => { S.exp.t = t; kind === 'full' ? renderExportState() : renderCleanState(); });
      eng.on('error', (e, seg) => { failed = new Error(seg ? `не удалось воспроизвести «${seg.clip.caption || seg.clip.fileName}»` : (e.message || String(e))); });
      rec.start(1000);
      await new Promise(res => {
        eng.on('ended', res);
        S.exp.cancel = () => { cancelled = true; eng.pause(); res(); };
        const chk = setInterval(() => { if (failed) { clearInterval(chk); eng.pause(); res(); } if (!S.exp) clearInterval(chk); }, 300);
        eng.on('ended', () => clearInterval(chk));
        eng.play();
      });
      await new Promise(r => setTimeout(r, 300));
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getTracks().forEach(t => t.stop());
      if (cancelled) { toast('Сборка отменена.', 'warn'); return; }
      if (failed) throw failed;
      const type = mime.split(';')[0];
      const blob = new Blob(chunks, { type });
      if (!blob.size) throw new Error('записано 0 байт');
      const ext = type === 'video/mp4' ? 'mp4' : 'webm';
      const d = new Date(); const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const name = kind === 'clean' ? `${(clip.fileName || 'clip').replace(/\.[^.]+$/, '')}-clean.${ext}` : `rating-${stamp}.${ext}`;
      const out = { url: URL.createObjectURL(blob), name, size: blob.size, mime: type };
      if (kind === 'clean') {
        S.cleanExport = { ...out, clipId: clip.id };
        toast(`Очищенный клип готов: ${esc(name)}`, 'ok');
      } else {
        if (S.lastExport) URL.revokeObjectURL(S.lastExport.url);
        S.lastExport = out;
        toast('Видео собрано! Проверьте результат и скачайте.', 'ok', 6000);
      }
    } catch (e) {
      toast('Сборка не удалась: ' + esc(e.message || e) + '. Проверьте, что все клипы воспроизводятся в предпросмотре; если видео не открывается — перекодируйте его в MP4 (H.264).', 'error', 12000);
    } finally {
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {}
      eng.destroy();
      try { dest && dest.disconnect(); } catch (e) {}
      S.exp = null; document.body.classList.remove('busy');
      renderInspector();
    }
  }
  function renderCleanState() {
    const el = $('#cleanState'); if (!el) return;
    const c = selClip();
    if (S.exp && S.exp.kind === 'clean') {
      const p = S.exp.total ? S.exp.t / S.exp.total : 0;
      el.innerHTML = `<div class="group"><h3>Сохранение очищенного клипа…</h3><div class="progress"><div style="width:${Math.round(p * 100)}%"></div></div>
        <button type="button" data-act="export-cancel" class="danger small">Отменить</button></div>`;
    } else if (S.cleanExport && c && S.cleanExport.clipId === c.id) {
      const L = S.cleanExport;
      el.innerHTML = `<div class="group result"><h3>Очищенный клип</h3><video src="${L.url}" controls playsinline></video>
        <a class="download" href="${L.url}" download="${esc(L.name)}">Скачать ${esc(L.name)}</a></div>`;
    } else el.innerHTML = '';
  }

  /* ---------- watermark editor canvas ---------- */
  function afterClipTab() {
    const c = selClip(); if (!c) return;
    renderCleanState();
    const url = S.urls.get(c.videoKey);
    if (S.wm.key !== c.id) {
      if (S.wm.video) { S.wm.video.removeAttribute('src'); S.wm.video.load(); }
      S.wm.video = null; S.wm.key = c.id; S.wm.time = r2(Math.min((c.trimStart || 0) + 0.5, Math.max(0, (c.srcDuration || 0) - 0.05)));
      if (url) {
        const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
        v.addEventListener('seeked', drawWM); v.addEventListener('loadeddata', () => { seekVideo(v, S.wm.time).then(drawWM); });
        v.src = url; S.wm.video = v;
      }
    }
    const t = $('#wmTime'); if (t) t.value = S.wm.time; const lbl = $('#wmTimeLbl'); if (lbl) lbl.textContent = fmt(S.wm.time);
    bindWmCanvas();
    drawWM();
  }

  function drawWM() {
    const cv = $('#wmCanvas'); const c = selClip(); if (!cv || !c) return;
    const ctx = cv.getContext('2d'); const v = S.wm.video;
    const wrap = cv.parentElement; const maxW = Math.max(200, (wrap.clientWidth || 320) - 12), maxH = 380;
    const ar = (c.width || 9) / (c.height || 16); let w = maxW, h = w / ar; if (h > maxH) { h = maxH; w = h * ar; }
    const dpr = Math.min(2, window.devicePixelRatio || 1); const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!v || v.readyState < 2) { ctx.fillStyle = '#8a93a6'; ctx.font = `${13 * dpr}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.fillText(v ? 'Загрузка кадра…' : 'Нет видеофайла', W / 2, H / 2); return; }
    const t = v.currentTime;
    if (S.wm.view === 'after') {
      R.drawClipVideo(ctx, v, { ...c, fit: 'cover', focusX: 0.5, focusY: 0.5 }, { x: 0, y: 0, w: W, h: H }, t);
      const cr = R.cropRect(c, c.width, c.height);
      if (cr.error) { ctx.fillStyle = 'rgba(255,93,93,.85)'; ctx.fillRect(0, H - 26 * dpr, W, 26 * dpr); ctx.fillStyle = '#fff'; ctx.font = `600 ${12 * dpr}px Inter`; ctx.textAlign = 'center'; ctx.fillText('Кадрирование невозможно — см. ошибку ниже', W / 2, H - 9 * dpr); }
      return;
    }
    ctx.drawImage(v, 0, 0, W, H);
    c.watermarks.forEach((r, i) => {
      const act = WM.isActive(r, t), sel = r.id === S.wm.selRegion;
      const x = r.x * W, y = r.y * H, rw = r.w * W, rh = r.h * H;
      ctx.setLineDash(act ? [] : [6 * dpr, 4 * dpr]); ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = sel ? '#2ee6ff' : act ? '#ff3b5c' : '#8a93a6';
      ctx.fillStyle = sel ? 'rgba(46,230,255,.12)' : act ? 'rgba(255,59,92,.12)' : 'rgba(138,147,166,.08)';
      ctx.fillRect(x, y, rw, rh); ctx.strokeRect(x, y, rw, rh); ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = `700 ${11 * dpr}px Inter`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`#${i + 1}${act ? '' : ' (не в этот момент)'}`, x + 2 * dpr, Math.max(12 * dpr, y - 2 * dpr));
      if (sel) { const hs = 9 * dpr; ctx.fillStyle = '#2ee6ff'; ctx.fillRect(x + rw - hs / 2, y + rh - hs / 2, hs, hs); }
    });
    const d = S.wm.drag;
    if (d && d.type === 'new') {
      ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(Math.min(d.x0, d.x1) * W, Math.min(d.y0, d.y1) * H, Math.abs(d.x1 - d.x0) * W, Math.abs(d.y1 - d.y0) * H); ctx.setLineDash([]);
    }
  }

  function bindWmCanvas() {
    const cv = $('#wmCanvas'); if (!cv) return;
    const pt = e => { const r = cv.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), rw: r.width, rh: r.height }; };
    let raf = 0; const redrawAll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { drawWM(); S.engine.redraw(); }); };
    cv.onpointerdown = e => {
      const c = selClip(); if (!c) return;
      if (S.wm.view !== 'before') { S.wm.view = 'before'; renderInspector(); toast('Разметка доступна в режиме «До». Переключил.', 'info', 2500); return; }
      const p = pt(e);
      const sr = c.watermarks.find(r => r.id === S.wm.selRegion);
      if (sr && Math.abs(p.x - (sr.x + sr.w)) * p.rw < 12 && Math.abs(p.y - (sr.y + sr.h)) * p.rh < 12) S.wm.drag = { type: 'resize', r: sr };
      else {
        const hit = [...c.watermarks].reverse().find(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
        if (hit) { S.wm.selRegion = hit.id; S.wm.drag = { type: 'move', r: hit, ox: p.x - hit.x, oy: p.y - hit.y }; $$('.region').forEach(el => el.classList.toggle('sel', el.dataset.rid === hit.id)); }
        else S.wm.drag = { type: 'new', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      cv.setPointerCapture(e.pointerId); drawWM();
    };
    cv.onpointermove = e => {
      const d = S.wm.drag; if (!d) return; const p = pt(e);
      if (d.type === 'new') { d.x1 = p.x; d.y1 = p.y; drawWM(); return; }
      if (d.type === 'move') { d.r.x = clamp(p.x - d.ox, 0, 1 - d.r.w); d.r.y = clamp(p.y - d.oy, 0, 1 - d.r.h); }
      if (d.type === 'resize') { d.r.w = clamp(p.x - d.r.x, 0.01, 1 - d.r.x); d.r.h = clamp(p.y - d.r.y, 0.01, 1 - d.r.y); }
      d.moved = true; redrawAll();
    };
    cv.onpointerup = () => {
      const d = S.wm.drag; S.wm.drag = null; const c = selClip(); if (!d || !c) return;
      if (d.type === 'new') {
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        if (w < 0.02 || h < 0.01) { drawWM(); return; }
        const r = { id: uid(), x: r2v(x), y: r2v(y), w: r2v(w), h: r2v(h), t0: 0, t1: c.srcDuration, method: 'inpaint', strength: 55, enabled: true, source: 'manual' };
        c.watermarks.push(r); S.wm.selRegion = r.id; S.wm.view = 'before';
      }
      save(); renderInspector(); renderClipList(); S.engine.redraw();
    };
  }
  const r2v = n => Math.round(n * 10000) / 10000;

  /* ---------- inspector events ---------- */
  function onClipField(el, final) {
    const c = selClip(); if (!c) return;
    const f = el.dataset.cf; let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number' || el.type === 'range') { v = parseFloat(el.value); if (!isFinite(v)) return; }
    else v = el.value;
    const src = c.srcDuration || 0;
    switch (f) {
      case 'sound': c.muted = !v; break;
      case 'placeId': c.placeId = v || null; break;
      case 'trimStart': c.trimStart = r2(clamp(v, 0, Math.max(0, src - 0.1))); c.duration = r2(Math.min(c.duration || src, src - c.trimStart)); c.captionDelay = Math.min(c.captionDelay || 0, clipDur(c)); break;
      case 'duration': c.duration = r2(clamp(v, 0.1, Math.max(0.1, src - (c.trimStart || 0)))); c.captionDelay = Math.min(c.captionDelay || 0, c.duration); break;
      case 'captionDelay': c.captionDelay = r2(clamp(v, 0, clipDur(c))); break;
      default: c[f] = v;
    }
    if (el.type === 'range' || el.type === 'number') $$(`[data-cf="${f}"]`).forEach(o => { if (o !== el && o.type !== 'checkbox') o.value = f === 'duration' ? r2(clipDur(c)) : c[f]; });
    save(); renderClipList();
    if (f === 'trimStart' || f === 'duration') { refreshSegments(c.id, f === 'duration' ? Math.max(0, clipDur(c) - 0.05) : 0.001); if (final) renderInspector(); }
    else if (f === 'captionDelay') seekToClip(c, captionVisibleAt(c));
    else if (f === 'placeId') { S.engine.redraw(); updateTransport(S.engine.time(), S.engine.total); }
    else S.engine.redraw();
    if (f === 'volume' || f === 'sound') S.engine._applyGain();
  }
  function onRegionField(el, final) {
    const c = selClip(); const r = c && c.watermarks.find(x => x.id === el.closest('[data-rid]').dataset.rid); if (!r) return;
    const f = el.dataset.rf;
    if (f === 'enabled') r.enabled = el.checked;
    else { const v = parseFloat(el.value); if (!isFinite(v)) return; if (f === 't0' || f === 't1') r[f] = r2(clamp(v, 0, c.srcDuration)); else r[f] = v; }
    if (f === 'strength') $$(`[data-rid="${r.id}"] [data-rf="strength"]`).forEach(o => { if (o !== el) o.value = r.strength; });
    save(); drawWM(); S.engine.redraw();
    if (final && f !== 'strength') { renderInspector(); renderClipList(); }
  }
  function onStyleField(el, final) {
    const k = el.dataset.style; const s = S.p.style;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'range' || el.type === 'number') { const v = parseFloat(el.value); if (!isFinite(v)) return; s[k] = v; $$(`[data-style="${k}"]`).forEach(o => { if (o !== el) o.value = v; }); }
    else s[k] = el.value;
    save(); S.engine.redraw();
    if (k === 'font') loadFonts().then(() => S.engine.redraw());
    if (final && (k === 'titleOverVideo' || k === 'medalColors')) { renderInspector(); renderClipList(); }
  }

  function bindInspector() {
    const el = $('#inspector');
    const handle = (e, final) => {
      const t = e.target;
      if (t.dataset.cf) { if (!final && t.type === 'number') return; onClipField(t, final); }
      else if (t.dataset.rf) { if (!final && t.type === 'number') return; onRegionField(t, final); }
      else if (t.dataset.style) { if (!final && t.type === 'number') return; onStyleField(t, final); }
      else if (t.dataset.proj === 'title') { S.p.title = t.value; save(); S.engine.redraw(); }
      else if (t.dataset.pf === 'name') {
        const p = S.p.places.find(x => x.id === t.closest('[data-pid]').dataset.pid); p.name = t.value; save(); S.engine.redraw();
        if (final) renderClipList();
      }
      else if (t.dataset.out) { const o = S.p.output; o[t.dataset.out] = t.type === 'checkbox' ? t.checked : t.value; save(); if (final) renderInspector(); }
      else if (t.id === 'wmTime') {
        const v = parseFloat(t.value); S.wm.time = v; $('#wmTimeLbl').textContent = fmt(v);
        if (S.wm.video && S.wm.video.readyState >= 1) S.wm.video.currentTime = v;
      }
    };
    el.addEventListener('input', e => handle(e, false));
    el.addEventListener('change', e => handle(e, true));
    // Source player and the main preview should not play at the same time.
    el.addEventListener('play', e => { if (e.target.matches && e.target.matches('video.src-player')) S.engine.pause(); }, true);
    el.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('details.src')) S.srcOpen = e.target.open; }, true);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act],[data-cf-set],[data-rf-set],[data-style-set],[data-wm-view],[data-goto]'); if (!b) return;
      const c = selClip();
      if (b.dataset.goto) { selectClip(b.dataset.goto); return; }
      if (b.dataset.cfSet && c) { c[b.dataset.cfSet] = b.dataset.val; save(); renderInspector(); S.engine.redraw(); return; }
      if (b.dataset.styleSet) { S.p.style[b.dataset.styleSet] = b.dataset.val; save(); renderInspector(); S.engine.redraw(); return; }
      if (b.dataset.wmView) { S.wm.view = b.dataset.wmView; renderInspector(); return; }
      if (b.dataset.rfSet && c) {
        const r = c.watermarks.find(x => x.id === b.closest('[data-rid]').dataset.rid); r.method = b.dataset.val; S.wm.selRegion = r.id;
        save(); renderInspector(); renderClipList(); S.engine.redraw();
        const err = WM.validate(c)[r.id]; if (err) toast(esc(err.msg), 'error', 8000);
        return;
      }
      const act = b.dataset.act; e.preventDefault();
      const rid = b.closest('[data-rid]') && b.closest('[data-rid]').dataset.rid;
      const pid = b.closest('[data-pid]') && b.closest('[data-pid]').dataset.pid;
      switch (act) {
        case 'detect': if (c) queueDetect(c); break;
        case 'add-region': if (c) { const r = { id: uid(), x: 0.35, y: 0.45, w: 0.3, h: 0.08, t0: 0, t1: c.srcDuration, method: 'inpaint', strength: 55, enabled: true, source: 'manual' }; c.watermarks.push(r); S.wm.selRegion = r.id; S.wm.view = 'before'; save(); renderInspector(); renderClipList(); S.engine.redraw(); } break;
        case 'clear-regions': if (c) ask('Удалить все области водяного знака у этого клипа?', 'Удалить').then(ok => { if (!ok) return; c.watermarks = []; save(); renderInspector(); renderClipList(); S.engine.redraw(); }); break;
        case 'del-region': if (c) { c.watermarks = c.watermarks.filter(r => r.id !== rid); save(); renderInspector(); renderClipList(); S.engine.redraw(); } break;
        case 'switch-method': if (c) { const r = c.watermarks.find(x => x.id === rid); r.method = b.dataset.val; save(); renderInspector(); renderClipList(); S.engine.redraw(); } break;
        case 't0-now': case 't1-now': if (c) { const r = c.watermarks.find(x => x.id === rid); r[act === 't0-now' ? 't0' : 't1'] = r2(S.wm.time); save(); renderInspector(); S.engine.redraw(); } break;
        case 'del-clip': if (c) deleteClip(c.id); break;
        case 'link-download': if (c) downloadIntoClip(c); break;
        case 'link-attach': if (c) {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*,.mp4,.webm,.mov,.m4v,.mkv';
          inp.onchange = () => { if (inp.files[0]) addFile(inp.files[0], c.url, c); };
          inp.click();
        } break;
        case 'clean-export': if (c) runExport('clean', c); break;
        case 'export': runExport('full'); break;
        case 'export-cancel': if (S.exp && S.exp.cancel) S.exp.cancel(); break;
        case 'preview-all': S.engine.seek(0).then(() => S.engine.play()); break;
        case 'p-add': S.p.places.push({ id: uid(), name: '' }); save(); renderInspector(); renderClipList(); S.engine.redraw(); break;
        case 'p-up': case 'p-down': {
          const i = placeIdx(pid), j = act === 'p-up' ? i - 1 : i + 1; if (j < 0 || j >= S.p.places.length) break;
          const a = S.p.places; [a[i], a[j]] = [a[j], a[i]]; save(); renderInspector(); renderClipList(); S.engine.redraw(); updateTransport(S.engine.time(), S.engine.total); break;
        }
        case 'p-del': {
          const i = placeIdx(pid); const used = S.p.clips.filter(x => x.placeId === pid);
          ask(`Удалить место №${i + 1}?${used.length ? ` Клипы (${used.length}) останутся, но будут без места.` : ''}`, 'Удалить').then(ok => {
            if (!ok) return;
            S.p.places.splice(placeIdx(pid), 1); used.forEach(x => { x.placeId = null; });
            save(); renderInspector(); renderClipList(); S.engine.redraw(); updateTransport(S.engine.time(), S.engine.total);
          });
          break;
        }
        case 'p-countdown': {
          const n = S.p.places.length;
          const run = () => {
            S.p.clips.forEach((x, k) => { x.placeId = k < n ? S.p.places[n - 1 - (k + Math.max(0, n - S.p.clips.length))].id : null; });
            save(); renderInspector(); renderClipList(); S.engine.redraw(); updateTransport(S.engine.time(), S.engine.total);
          };
          if (S.p.clips.length > n) ask(`Клипов (${S.p.clips.length}) больше, чем мест (${n}). Лишние клипы останутся без места. Продолжить?`, 'Продолжить').then(ok => { if (ok) run(); });
          else run();
          break;
        }
        case 'style-reset': ask('Вернуть оформление по умолчанию? Тексты и клипы останутся.', 'Сбросить').then(ok => { if (!ok) return; S.p.style = { ...DEFAULT_STYLE }; save(); renderInspector(); loadFonts().then(() => S.engine.redraw()); }); break;
        case 'settings-save': {
          const data = { app: 'RankShorts', version: 1, title: S.p.title, style: S.p.style, places: S.p.places.map(p => ({ name: p.name })), output: S.p.output };
          const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          a.download = 'rankshorts-settings.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); break;
        }
        case 'settings-load': {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
          inp.onchange = async () => {
            try {
              const j = JSON.parse(await inp.files[0].text());
              if (j.app !== 'RankShorts') throw new Error('это не файл настроек RankShorts');
              if (typeof j.title === 'string') S.p.title = j.title;
              if (j.style) S.p.style = { ...DEFAULT_STYLE, ...j.style };
              if (j.output) S.p.output = { ...S.p.output, ...j.output };
              if (Array.isArray(j.places)) j.places.forEach((p, i) => { if (S.p.places[i]) S.p.places[i].name = p.name || ''; else S.p.places.push({ id: uid(), name: p.name || '' }); });
              save(); renderInspector(); renderClipList(); loadFonts().then(() => S.engine.redraw()); toast('Настройки загружены.', 'ok');
            } catch (err) { toast('Не удалось загрузить настройки: ' + esc(err.message), 'error'); }
          };
          inp.click(); break;
        }
      }
    });
  }

  /* ---------- fonts ---------- */
  function loadFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all(FONTS.filter(f => f.id !== 'Arial Black').map(f => document.fonts.load(`${f.weight} 40px "${f.id}"`, 'Аб12').catch(() => {}))).then(() => {});
  }

  /* ---------- global bindings ---------- */
  function bindGlobal() {
    const fi = $('#fileInput');
    fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dz.classList.add('over'); } }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('over')));
    window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', e => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault(); if (S.exp) return; addFiles(e.dataTransfer.files);
    });
    $('#urlForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#urlInput').value; if (v.trim()) importUrl(v); });
    const ad = $('#autoDetect'); ad.checked = !!S.p.autoDetect; ad.addEventListener('change', () => { S.p.autoDetect = ad.checked; save(); });

    $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.tab = b.dataset.tab; renderTabs(); renderInspector(); });

    $('#playBtn').addEventListener('click', togglePlay);
    const sc = $('#scrub');
    sc.addEventListener('input', () => { S.scrubbing = true; const t = sc.value / 1000 * S.engine.total; $('#timeLabel').textContent = `${fmt(t)} / ${fmt(S.engine.total)}`; S.engine.seek(t); });
    sc.addEventListener('change', () => { S.scrubbing = false; });
    $('#muteBtn').addEventListener('click', () => { const m = !S.engine.muted; S.engine.setMuted(m); $('#muteBtn').textContent = m ? '🔇' : '🔊'; });
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || S.exp) return;
      if (e.target.closest('input,textarea,select,button,[contenteditable]')) return;
      e.preventDefault(); togglePlay();
    });
    document.addEventListener('visibilitychange', () => { if (S.exp && document.hidden) toast('Вкладка ушла в фон во время сборки — запись может «застыть». Вернитесь на вкладку.', 'warn', 8000); });

    $('#newProject').addEventListener('click', async () => {
      if (S.exp) return;
      if (!(await ask('Начать новый проект? Все клипы и настройки текущего проекта будут удалены из браузера.', 'Удалить всё'))) return;
      S.engine.pause();
      S.urls.forEach(u => URL.revokeObjectURL(u)); S.urls.clear();
      try { await DB.clear('blobs'); } catch (e) {}
      S.p = defaultProject(); S.sel = null; S.wm.key = null; S.lastExport = null; S.cleanExport = null;
      $('#autoDetect').checked = true;
      save(); renderAll(); refreshSegments(null);
    });

    window.addEventListener('resize', () => { if (S.tab === 'clip') drawWM(); });
  }
  function togglePlay() {
    if (!S.engine.segs.length) { toast('Сначала добавьте видео.', 'info', 2500); return; }
    if (S.engine.playing) S.engine.pause();
    else { $$('video.src-player').forEach(v => v.pause()); S.engine.play(); }
  }

  function renderAll() { renderTabs(); renderClipList(); renderInspector(); }

  /* ---------- init ---------- */
  async function init() {
    try {
      const saved = await DB.get('kv', 'project');
      S.p = saved ? normalize(saved) : defaultProject();
    } catch (e) {
      S.p = defaultProject();
      toast('Хранилище браузера недоступно — проект не будет сохраняться между сессиями.', 'warn', 9000);
    }
    const missing = [];
    for (const c of S.p.clips) {
      if (c.kind === 'link') continue;
      try {
        const blob = await DB.get('blobs', c.videoKey);
        if (blob) { if (!S.urls.has(c.videoKey)) S.urls.set(c.videoKey, URL.createObjectURL(blob)); }
        else missing.push(c);
      } catch (e) { missing.push(c); }
    }
    // Remove stored videos that no clip refers to any more (e.g. page closed during the undo window).
    try {
      const keys = await DB.keys('blobs');
      keys.filter(k => !S.p.clips.some(c => c.videoKey === k)).forEach(k => DB.del('blobs', k).catch(() => {}));
    } catch (e) {}
    if (missing.length) toast(`Не найдено видеофайлов: ${missing.length}. Эти клипы помечены «нет файла» — добавьте видео заново.`, 'warn', 9000);
    S.sel = S.p.clips[0] ? S.p.clips[0].id : null;

    const cv = $('#preview');
    S.engine = new Engine(cv, { render: (ctx, W, H, f) => R.drawFrame(ctx, W, H, S.p, f) });
    S.engine.on('time', (t, total) => updateTransport(t, total));
    S.engine.on('state', () => { $('#playBtn').textContent = S.engine.playing ? '❚❚' : '▶'; });
    S.engine.on('error', (e, seg) => {
      const n = seg ? `«${esc(seg.clip.caption || seg.clip.fileName)}»` : '';
      if (e && e.name === 'NotAllowedError') toast('Браузер заблокировал воспроизведение — нажмите ▶ ещё раз.', 'warn');
      else toast(`Не удалось воспроизвести клип ${n}: ${esc(e && e.message || e)}. Возможно, формат не поддерживается — перекодируйте в MP4 (H.264).`, 'error', 9000);
    });

    bindGlobal(); bindClipList(); bindInspector(); bindImportCard();
    renderAll(); setSaved(saved_text());
    S.engine.setSegments(buildSegments());
    S.engine.draw();
    if (S.sel) refreshSegments(S.sel);
    loadFonts().then(() => S.engine.redraw());
    checkServer();
  }
  function saved_text() { return S.p.clips.length ? 'Проект загружен' : ''; }

  // test hooks (used for automated checks; harmless for users)
  S.addFile = addFile; S.importUrl = importUrl; S.runExport = runExport; S.selectClip = selectClip; S.moveClip = moveClip;
  S.render = () => { renderAll(); S.engine.redraw(); };

  init();
})();
