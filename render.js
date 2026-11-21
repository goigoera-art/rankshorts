'use strict';
/* Frame composition: video + title band + places list + caption. All sizes scale with canvas width. */

const FONTS = [
  { id: 'Montserrat', label: 'Montserrat', weight: 900 },
  { id: 'Rubik', label: 'Rubik', weight: 800 },
  { id: 'Oswald', label: 'Oswald', weight: 700 },
  { id: 'Russo One', label: 'Russo One', weight: 400 },
  { id: 'Unbounded', label: 'Unbounded', weight: 800 },
  { id: 'Roboto Condensed', label: 'Roboto Condensed', weight: 800 },
  { id: 'Arial Black', label: 'Arial Black (системный)', weight: 900 },
];

const DEFAULT_STYLE = {
  font: 'Montserrat',
  titleSize: 7.4, titleColor: '#ffffff', accent1: '#ff2b2b', accent2: '#2ee6ff',
  bandHeight: 13, bandColor: '#000000', titleOverVideo: false, titleY: 8,
  strokeColor: '#000000', strokeWidth: 6,
  listX: 7, listY: 33, listGap: 7.6, numberSize: 6.2, numberColor: '#ffffff',
  medalColors: true, highlightColor: '#ffe14d', revealedOpacity: 0.45, transition: 0.35,
  captionPos: 'list', captionX: 50, captionY: 78, captionSize: 4.8,
  captionColor: '#ffffff', captionStrokeColor: '#000000', captionStrokeWidth: 6,
  captionBg: '#000000', captionBgOpacity: 0, captionAnim: true,
};

const MEDAL = ['#FFD12E', '#FF8A1F', '#FF3434'];

const R = (() => {
  const tmp = document.createElement('canvas');

  function hexA(hex, a) {
    const n = parseInt((hex || '#000000').slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function fontOf(s, px) {
    const f = FONTS.find(x => x.id === s.font) || FONTS[0];
    return `${f.weight} ${Math.max(1, Math.round(px))}px "${f.id}", "Arial Black", Arial, sans-serif`;
  }
  function layout(W, H, s) {
    const band = s.titleOverVideo ? 0 : Math.round(H * s.bandHeight / 100);
    return { band, video: { x: 0, y: band, w: W, h: H - band } };
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(ctx, t, x, y, o) {
    if (o.align) ctx.textAlign = o.align;
    if (o.sw > 0) {
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.lineWidth = o.sw * 2; ctx.strokeStyle = o.stroke;
      ctx.strokeText(t, x, y);
    }
    ctx.fillStyle = o.fill;
    ctx.fillText(t, x, y);
  }
  function parseRich(line) {
    const out = []; const re = /\*([^*]+)\*|\{([^}]+)\}/g; let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push({ t: line.slice(last, m.index), c: 0 });
      out.push({ t: m[1] != null ? m[1] : m[2], c: m[1] != null ? 1 : 2 });
      last = re.lastIndex;
    }
    if (last < line.length) out.push({ t: line.slice(last), c: 0 });
    return out;
  }
  const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

  /* Source rectangle after "crop" watermark regions are cut away. */
  function cropRect(clip, vw, vh) {
    let L = 0, T = 0, Rr = vw, B = vh;
    const regs = (clip.watermarks || []).filter(r => r.method === 'crop' && r.enabled !== false);
    for (const r of regs) {
      const m = 0.01 + (r.strength != null ? r.strength : 50) / 100 * 0.04;
      const x0 = Math.max(0, r.x - m) * vw, x1 = Math.min(1, r.x + r.w + m) * vw;
      const y0 = Math.max(0, r.y - m) * vh, y1 = Math.min(1, r.y + r.h + m) * vh;
      if (x1 <= L || x0 >= Rr || y1 <= T || y0 >= B) continue;
      const cands = [
        { L: Math.max(L, x1), T, R: Rr, B }, { L, T, R: Math.min(Rr, x0), B },
        { L, T: Math.max(T, y1), R: Rr, B }, { L, T, R: Rr, B: Math.min(B, y0) },
      ];
      let best = null, ba = -1;
      for (const q of cands) { const a = Math.max(0, q.R - q.L) * Math.max(0, q.B - q.T); if (a > ba) { ba = a; best = q; } }
      L = best.L; T = best.T; Rr = best.R; B = best.B;
    }
    const frac = Math.max(0, Rr - L) * Math.max(0, B - T) / (vw * vh);
    if (regs.length && frac < 0.5) {
      return { x: 0, y: 0, w: vw, h: vh, frac, error: 'Кадрирование не сработало: чтобы убрать эту область, пришлось бы обрезать больше половины кадра (водяной знак далеко от края). Выберите «Восстановление фона» или «Размытие».' };
    }
    return { x: L, y: T, w: Rr - L, h: B - T, frac, error: null };
  }

  function fitTransform(src, box, fit, fx = 0.5, fy = 0.5) {
    const { x: sx, y: sy, w: sw, h: sh } = src;
    if (fit === 'contain') {
      const s = Math.min(box.w / sw, box.h / sh); const dw = sw * s, dh = sh * s;
      return { sx, sy, sw, sh, dx: box.x + (box.w - dw) / 2, dy: box.y + (box.h - dh) / 2, dw, dh };
    }
    const s = Math.max(box.w / sw, box.h / sh); const vw2 = box.w / s, vh2 = box.h / s;
    return { sx: sx + (sw - vw2) * fx, sy: sy + (sh - vh2) * fy, sw: vw2, sh: vh2, dx: box.x, dy: box.y, dw: box.w, dh: box.h };
  }

  function blurredDraw(ctx, video, T, box) {
    const w = Math.max(8, Math.round(box.w / 24)), h = Math.max(8, Math.round(box.h / 24));
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(video, T.sx, T.sy, T.sw, T.sh, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, w, h, box.x, box.y, box.w, box.h);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(box.x, box.y, box.w, box.h);
  }

  function drawClipVideo(ctx, video, clip, box, tSrc, opts = {}) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const crop = cropRect(clip, vw, vh);
    const fit = clip.fit || 'cover';
    const T = fitTransform(crop, box, fit, clip.focusX != null ? clip.focusX : 0.5, clip.focusY != null ? clip.focusY : 0.5);
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    if (fit === 'contain') blurredDraw(ctx, video, fitTransform(crop, box, 'cover'), box);
    ctx.drawImage(video, T.sx, T.sy, T.sw, T.sh, T.dx, T.dy, T.dw, T.dh);
    if (!opts.raw && typeof WM !== 'undefined') WM.apply(ctx, clip, T, vw, vh, tSrc, box);
    ctx.restore();
    return T;
  }

  function drawPlaceholder(ctx, box, k, msg) {
    const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
    g.addColorStop(0, '#1a1f2b'); g.addColorStop(1, '#0c0f15');
    ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
    if (!msg) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([18 * k, 14 * k]); ctx.lineWidth = 4 * k;
    roundRect(ctx, box.x + 60 * k, box.y + box.h * 0.66, box.w - 120 * k, box.h * 0.2, 40 * k); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(46 * k)}px Inter, Arial, sans-serif`;
    ctx.fillText(msg, box.x + box.w / 2, box.y + box.h * 0.76);
    ctx.restore();
  }

  function drawTitle(ctx, W, H, P, lay, k) {
    const s = P.style;
    if (lay.band > 0) { ctx.fillStyle = s.bandColor; ctx.fillRect(0, 0, W, lay.band); }
    const lines = String(P.title || '').split('\n');
    if (!lines.join('').trim()) return;
    const parsed = lines.map(parseRich);
    let size = W * s.titleSize / 100;
    ctx.font = fontOf(s, size);
    const widthOf = segs => segs.reduce((a, g) => a + ctx.measureText(g.t).width, 0);
    const maxw = Math.max(...parsed.map(widthOf));
    if (maxw > W * 0.92) size *= W * 0.92 / maxw;
    let lh = size * 1.12;
    if (lay.band > 0 && lh * lines.length > lay.band * 0.9) { size *= lay.band * 0.9 / (lh * lines.length); lh = size * 1.12; }
    ctx.font = fontOf(s, size);
    const total = lh * lines.length;
    const cy = lay.band > 0 ? lay.band / 2 : H * s.titleY / 100;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    parsed.forEach((segs, i) => {
      const y = cy - total / 2 + lh * (i + 0.5);
      let x = (W - widthOf(segs)) / 2;
      for (const g of segs) {
        text(ctx, g.t, x, y, { fill: g.c === 1 ? s.accent1 : g.c === 2 ? s.accent2 : s.titleColor, stroke: s.strokeColor, sw: s.strokeWidth * k });
        x += ctx.measureText(g.t).width;
      }
    });
  }

  const easeInOut = x => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  const transitionOf = s => Math.max(0.05, s.transition != null ? s.transition : 0.35);

  /* When the current caption starts to fade in (after the previous one has dimmed). */
  function captionStart(s, clip, hasPrev) {
    return Math.max(clip.captionDelay || 0, hasPrev ? transitionOf(s) : 0);
  }

  /* o: { alpha: 0..1, pop: 0..1 progress for the scale-in (or null) } */
  function drawCaption(ctx, W, P, k, txt, x, y, align, o) {
    const s = P.style;
    if (!(o.alpha > 0.001)) return;
    let size = W * s.captionSize / 100;
    ctx.save();
    ctx.font = fontOf(s, size);
    let tw = ctx.measureText(txt).width;
    const avail = align === 'left' ? W * 0.97 - x : W * 0.94;
    if (tw > avail) { size *= Math.max(0.45, avail / tw); ctx.font = fontOf(s, size); tw = ctx.measureText(txt).width; }
    const sc = o.pop != null && s.captionAnim ? 0.85 + 0.15 * easeOutBack(clamp(o.pop, 0, 1)) : 1;
    ctx.globalAlpha = clamp(o.alpha, 0, 1);
    ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.textBaseline = 'middle';
    if (s.captionBgOpacity > 0) {
      const pad = size * 0.32, h = size * 1.35;
      const bx = align === 'left' ? -pad : -tw / 2 - pad;
      ctx.fillStyle = hexA(s.captionBg, s.captionBgOpacity);
      roundRect(ctx, bx, -h / 2, tw + pad * 2, h, size * 0.3); ctx.fill();
    }
    text(ctx, txt, 0, 0, { fill: s.captionColor, stroke: s.captionStrokeColor, sw: s.captionStrokeWidth * k, align });
    ctx.restore();
  }

  function drawList(ctx, W, H, P, k, o) {
    const s = P.style; const n = P.places.length;
    if (!n) return;
    const x = W * s.listX / 100, y0 = H * s.listY / 100, gap = H * s.listGap / 100, size = W * s.numberSize / 100;
    const T = transitionOf(s);
    const dimP = easeInOut(clamp(o.local / T, 0, 1));          // 0 → 1 during the first T seconds of a clip
    const hiP = o.curPlaceId ? easeInOut(clamp(o.local / T, 0, 1)) : 0;
    const dim = clamp(s.revealedOpacity != null ? s.revealedOpacity : 0.45, 0, 1);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    P.places.forEach((pl, i) => {
      const y = y0 + i * gap; const isCur = pl.id === o.curPlaceId;
      const color = s.medalColors && i < 3 ? MEDAL[i] : s.numberColor;
      const label = `${i + 1}.`;
      ctx.font = fontOf(s, size);
      const tx = x + ctx.measureText(label).width + size * 0.18;   // caption x does not move when the number grows
      if (isCur) {
        ctx.font = fontOf(s, size * (1 + 0.18 * hiP));
        ctx.save(); ctx.shadowColor = s.highlightColor; ctx.shadowBlur = 28 * k * hiP;
        text(ctx, label, x, y, { fill: hiP > 0.5 ? s.highlightColor : color, stroke: s.strokeColor, sw: s.strokeWidth * k, align: 'left' });
        ctx.restore();
      } else {
        text(ctx, label, x, y, { fill: color, stroke: s.strokeColor, sw: s.strokeWidth * k, align: 'left' });
      }
      if (isCur) {
        if (o.caption) drawCaption(ctx, W, P, k, o.caption, tx, y, 'left', { alpha: o.capAlpha, pop: o.capAlpha });
      } else if (o.revealed.has(pl.id) && dim > 0) {
        // Already shown places keep their caption, semi-transparent; the place that just ended dims smoothly.
        const t = pl.name || o.revealed.get(pl.id);
        const a = pl.id === o.prevPlaceId ? 1 - (1 - dim) * dimP : dim;
        if (t) drawCaption(ctx, W, P, k, t, tx, y, 'left', { alpha: a, pop: null });
      }
    });
  }

  /* frame: { seg, index, video, segs } (seg may be undefined for empty project) */
  function drawFrame(ctx, W, H, P, f) {
    const s = P.style; const k = W / 1080; const lay = layout(W, H, s);
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const seg = f && f.seg;
    let local = 0;
    if (seg && f.video && f.video.readyState >= 2) {
      local = clamp(f.video.currentTime - (seg.clip.trimStart || 0), 0, seg.dur);
      drawClipVideo(ctx, f.video, seg.clip, lay.video, f.video.currentTime);
    } else {
      drawPlaceholder(ctx, lay.video, k, seg ? '' : (f && f.segs && f.segs.length ? 'Загрузка видео…' : (P.clips && P.clips.length ? 'Видео ещё не скачано' : 'Добавьте видео')));
    }
    drawTitle(ctx, W, H, P, lay, k);

    const curPlaceId = seg && P.places.some(p => p.id === seg.clip.placeId) ? seg.clip.placeId : null;
    const revealed = new Map();
    if (seg && f.segs) for (let i = 0; i < f.index; i++) {
      const c = f.segs[i].clip;
      if (c.placeId && !revealed.has(c.placeId)) revealed.set(c.placeId, c.caption || '');
    }
    // Previous clip in the queue: its place caption dims while this clip's caption fades in.
    const prevClip = seg && f.index > 0 ? f.segs[f.index - 1].clip : null;
    const prevPlaceId = prevClip && prevClip.placeId !== curPlaceId ? prevClip.placeId : null;
    const start = seg ? captionStart(s, seg.clip, !!prevPlaceId) : 0;
    const capAlpha = seg && seg.clip.caption ? easeInOut(clamp((local - start) / transitionOf(s), 0, 1)) : 0;
    const inList = s.captionPos === 'list' && curPlaceId;
    drawList(ctx, W, H, P, k, { curPlaceId, prevPlaceId, revealed, local, caption: inList && seg.clip.caption ? seg.clip.caption : null, capAlpha });
    if (seg && seg.clip.caption && !inList) drawCaption(ctx, W, P, k, seg.clip.caption, W * s.captionX / 100, H * s.captionY / 100, 'center', { alpha: capAlpha, pop: capAlpha });
    ctx.restore();
  }

  return { hexA, fontOf, layout, roundRect, text, parseRich, cropRect, fitTransform, drawClipVideo, drawFrame, drawPlaceholder, captionStart, transitionOf };
})();
