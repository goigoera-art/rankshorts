'use strict';
/* Watermark removal (applied per frame on canvas) and heuristic TikTok watermark detection. */

const WM = (() => {
  function blurH(src, dst, w, h, r) {
    const div = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4; let rs = 0, gs = 0, bs = 0;
      for (let i = -r; i <= r; i++) { const k = row + clamp(i, 0, w - 1) * 4; rs += src[k]; gs += src[k + 1]; bs += src[k + 2]; }
      for (let x = 0; x < w; x++) {
        const k = row + x * 4;
        dst[k] = rs / div; dst[k + 1] = gs / div; dst[k + 2] = bs / div; dst[k + 3] = 255;
        const ka = row + Math.min(w - 1, x + r + 1) * 4, ks = row + Math.max(0, x - r) * 4;
        rs += src[ka] - src[ks]; gs += src[ka + 1] - src[ks + 1]; bs += src[ka + 2] - src[ks + 2];
      }
    }
  }
  function blurV(src, dst, w, h, r) {
    const div = 2 * r + 1, stride = w * 4;
    for (let x = 0; x < w; x++) {
      const col = x * 4; let rs = 0, gs = 0, bs = 0;
      for (let i = -r; i <= r; i++) { const k = col + clamp(i, 0, h - 1) * stride; rs += src[k]; gs += src[k + 1]; bs += src[k + 2]; }
      for (let y = 0; y < h; y++) {
        const k = col + y * stride;
        dst[k] = rs / div; dst[k + 1] = gs / div; dst[k + 2] = bs / div; dst[k + 3] = 255;
        const ka = col + Math.min(h - 1, y + r + 1) * stride, ks = col + Math.max(0, y - r) * stride;
        rs += src[ka] - src[ks]; gs += src[ka + 1] - src[ks + 1]; bs += src[ka + 2] - src[ks + 2];
      }
    }
  }
  function boxBlur(d, w, h, r, passes = 3) {
    r = Math.round(r); if (r < 1) return;
    const t = new Uint8ClampedArray(d.length);
    for (let i = 0; i < passes; i++) { blurH(d, t, w, h, r); blurV(t, d, w, h, r); }
  }

  /* Region (normalized to source) -> canvas pixel rect, clipped to visible video area. */
  function toCanvasRect(r, T, vw, vh, box) {
    const kx = T.dw / T.sw, ky = T.dh / T.sh;
    let x0 = T.dx + (r.x * vw - T.sx) * kx, y0 = T.dy + (r.y * vh - T.sy) * ky;
    let x1 = T.dx + ((r.x + r.w) * vw - T.sx) * kx, y1 = T.dy + ((r.y + r.h) * vh - T.sy) * ky;
    const bx0 = Math.ceil(Math.max(box.x, T.dx)), by0 = Math.ceil(Math.max(box.y, T.dy));
    const bx1 = Math.floor(Math.min(box.x + box.w, T.dx + T.dw)), by1 = Math.floor(Math.min(box.y + box.h, T.dy + T.dh));
    x0 = Math.floor(Math.max(x0, bx0)); y0 = Math.floor(Math.max(y0, by0));
    x1 = Math.ceil(Math.min(x1, bx1)); y1 = Math.ceil(Math.min(y1, by1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, b: { x0: bx0, y0: by0, x1: bx1, y1: by1 } };
  }

  function blur(ctx, rr, strength) {
    const s = (strength != null ? strength : 50) / 100;
    const rad = Math.max(2, Math.round(2 + s * Math.max(8, Math.min(rr.w, rr.h) * 0.45)));
    const b = rr.b;
    const ex0 = Math.max(b.x0, rr.x - rad), ey0 = Math.max(b.y0, rr.y - rad);
    const ex1 = Math.min(b.x1, rr.x + rr.w + rad), ey1 = Math.min(b.y1, rr.y + rr.h + rad);
    const ew = ex1 - ex0, eh = ey1 - ey0; if (ew < 2 || eh < 2) return false;
    const img = ctx.getImageData(ex0, ey0, ew, eh);
    boxBlur(img.data, ew, eh, rad, 3);
    ctx.putImageData(img, ex0, ey0, rr.x - ex0, rr.y - ey0, rr.w, rr.h);
    return true;
  }

  /* "Background restoration": fill the region by interpolating from its border, then soften. */
  function inpaint(ctx, rr, strength) {
    const s = (strength != null ? strength : 50) / 100; const b = rr.b; const m = 3;
    const ex0 = Math.max(b.x0, rr.x - m), ey0 = Math.max(b.y0, rr.y - m);
    const ex1 = Math.min(b.x1, rr.x + rr.w + m), ey1 = Math.min(b.y1, rr.y + rr.h + m);
    const ew = ex1 - ex0, eh = ey1 - ey0; if (ew < 2 || eh < 2) return false;
    const img = ctx.getImageData(ex0, ey0, ew, eh); const d = img.data;
    const ix0 = rr.x - ex0, iy0 = rr.y - ey0, iw = rr.w, ih = rr.h, ix1 = ix0 + iw, iy1 = iy0 + ih;
    const hasL = ix0 > 0, hasR = ix1 < ew, hasT = iy0 > 0, hasB = iy1 < eh;
    if (!hasL && !hasR && !hasT && !hasB) return false;
    const avg = (xa, xb, ya, yb, out, o) => {
      let r = 0, g = 0, bb = 0, n = 0;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const k = (y * ew + x) * 4; r += d[k]; g += d[k + 1]; bb += d[k + 2]; n++; }
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = bb / n;
    };
    const Lc = new Float32Array(ih * 3), Rc = new Float32Array(ih * 3), Tc = new Float32Array(iw * 3), Bc = new Float32Array(iw * 3);
    for (let y = 0; y < ih; y++) {
      const yy = iy0 + y;
      if (hasL) avg(Math.max(0, ix0 - 2), ix0 - 1, yy, yy, Lc, y * 3);
      if (hasR) avg(ix1, Math.min(ew - 1, ix1 + 1), yy, yy, Rc, y * 3);
    }
    for (let x = 0; x < iw; x++) {
      const xx = ix0 + x;
      if (hasT) avg(xx, xx, Math.max(0, iy0 - 2), iy0 - 1, Tc, x * 3);
      if (hasB) avg(xx, xx, iy1, Math.min(eh - 1, iy1 + 1), Bc, x * 3);
    }
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const wl = hasL ? 1 / (x + 1) : 0, wr = hasR ? 1 / (iw - x) : 0, wt = hasT ? 1 / (y + 1) : 0, wb = hasB ? 1 / (ih - y) : 0;
        const ws = wl + wr + wt + wb; const k = ((iy0 + y) * ew + ix0 + x) * 4;
        for (let c = 0; c < 3; c++) {
          d[k + c] = (wl * Lc[y * 3 + c] + wr * Rc[y * 3 + c] + wt * Tc[x * 3 + c] + wb * Bc[x * 3 + c]) / ws;
        }
      }
    }
    boxBlur(d, ew, eh, Math.round(1 + s * Math.max(2, Math.min(iw, ih) * 0.25)), 2);
    const grain = 5 * s;
    if (grain > 0.5) {
      for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) {
        const k = (y * ew + x) * 4, n = (Math.random() - 0.5) * grain * 2;
        d[k] += n; d[k + 1] += n; d[k + 2] += n;
      }
    }
    ctx.putImageData(img, ex0, ey0, ix0, iy0, iw, ih);
    return true;
  }

  function isActive(r, tSrc) {
    return r.enabled !== false && tSrc >= (r.t0 || 0) - 0.001 && tSrc <= (r.t1 != null ? r.t1 : 1e9) + 0.001;
  }

  function apply(ctx, clip, T, vw, vh, tSrc, box) {
    for (const r of clip.watermarks || []) {
      if (r.method === 'crop' || !isActive(r, tSrc)) continue;
      const rr = toCanvasRect(r, T, vw, vh, box);
      if (!rr) continue;
      if (r.method === 'blur') blur(ctx, rr, r.strength);
      else if (!inpaint(ctx, rr, r.strength)) blur(ctx, rr, r.strength);
    }
  }

  /* Problems that make a chosen method unusable; keyed by region id. */
  function validate(clip) {
    const errs = {};
    const crop = R.cropRect(clip, clip.width || 1080, clip.height || 1920);
    for (const r of clip.watermarks || []) {
      if (r.enabled === false) continue;
      if (r.method === 'crop' && crop.error) errs[r.id] = { msg: crop.error, alt: 'inpaint' };
      if (r.method === 'inpaint' && r.w * r.h > 0.2) errs[r.id] = { msg: 'Восстановление фона не сработает: область больше 20% кадра, заливка будет заметна. Уменьшите область или выберите «Размытие».', alt: 'blur' };
      if (r.method === 'inpaint' && r.x <= 0.001 && r.y <= 0.001 && r.x + r.w >= 0.999 && r.y + r.h >= 0.999) errs[r.id] = { msg: 'Область закрывает весь кадр — восстанавливать не из чего. Выберите «Размытие».', alt: 'blur' };
    }
    return errs;
  }

  /* ---------- Detection ---------- */
  async function detect(url, dur, onProgress) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    try {
      await waitEvent(v, 'loadeddata', 20000);
      if (!dur || !isFinite(dur)) dur = await fixDuration(v);
      const vw = v.videoWidth, vh = v.videoHeight;
      const sw = 240, sh = Math.max(24, Math.round(sw * vh / vw)), n = sw * sh;
      const c = document.createElement('canvas'); c.width = sw; c.height = sh;
      const cx = c.getContext('2d', { willReadFrequently: true });
      const N = clamp(Math.round(dur * 2), 8, 24);
      const L = [], G = [], times = [];
      for (let i = 0; i < N; i++) {
        const t = Math.min(dur - 0.05, dur * (i + 0.5) / N);
        await seekVideo(v, Math.max(0, t));
        cx.drawImage(v, 0, 0, sw, sh);
        const d = cx.getImageData(0, 0, sw, sh).data;
        const lum = new Uint8Array(n), g = new Uint8Array(n);
        for (let p = 0; p < n; p++) lum[p] = (d[p * 4] * 77 + d[p * 4 + 1] * 150 + d[p * 4 + 2] * 29) >> 8;
        for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
          const p = y * sw + x;
          g[p] = Math.min(255, Math.abs(lum[p + 1] - lum[p - 1]) + Math.abs(lum[p + sw] - lum[p - sw]));
        }
        L.push(lum); G.push(g); times.push(t);
        if (onProgress) onProgress((i + 1) / N);
      }

      // Overall motion: average per-pixel std over the whole clip.
      let motion = 0;
      for (let p = 0; p < n; p += 7) {
        let s1 = 0, s2 = 0; for (let i = 0; i < N; i++) { s1 += L[i][p]; s2 += L[i][p] * L[i][p]; }
        const m = s1 / N; motion += Math.sqrt(Math.max(0, s2 / N - m * m));
      }
      motion /= Math.ceil(n / 7);

      const analyze = idx => {
        const k = idx.length, mask = new Uint8Array(n);
        for (let p = 0; p < n; p++) {
          let minG = 255, s1 = 0, s2 = 0;
          for (const i of idx) { const gv = G[i][p]; if (gv < minG) minG = gv; const l = L[i][p]; s1 += l; s2 += l * l; }
          const m = s1 / k, sd = Math.sqrt(Math.max(0, s2 / k - m * m));
          if (minG >= 20 && m >= 100 && sd <= 30) mask[p] = 1;
        }
        // dilate (radius 3) so letters merge into one blob
        const dil = new Uint8Array(n); const rad = 3;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          if (!mask[y * sw + x]) continue;
          for (let dy = -rad; dy <= rad; dy++) { const yy = y + dy; if (yy < 0 || yy >= sh) continue;
            for (let dx = -rad; dx <= rad; dx++) { const xx = x + dx; if (xx >= 0 && xx < sw) dil[yy * sw + xx] = 1; } }
        }
        const seen = new Uint8Array(n), boxes = [], stack = [];
        for (let p0 = 0; p0 < n; p0++) {
          if (!dil[p0] || seen[p0]) continue;
          let x0 = sw, y0 = sh, x1 = 0, y1 = 0, cnt = 0; stack.push(p0); seen[p0] = 1;
          while (stack.length) {
            const p = stack.pop(); const x = p % sw, y = (p / sw) | 0;
            if (mask[p]) cnt++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
            for (const q of nb) if (q >= 0 && dil[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
          }
          const bw = x1 - x0 + 1, bh = y1 - y0 + 1, area = bw * bh / n;
          // TikTok places its mark near the frame edges; ignore static text in the middle of the frame.
          const cxn = (x0 + bw / 2) / sw, cyn = (y0 + bh / 2) / sh;
          const nearEdge = cxn < 0.4 || cxn > 0.6 || cyn < 0.25 || cyn > 0.75;
          if (nearEdge && cnt >= 15 && bw >= 8 && area >= 0.001 && area <= 0.12 && bw <= sw * 0.75 && cnt / (bw * bh) >= 0.04) {
            boxes.push({ x: x0 / sw, y: y0 / sh, w: bw / sw, h: bh / sh, score: cnt });
          }
        }
        return boxes.sort((a, b) => b.score - a.score);
      };
      const iou = (a, b) => {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const I = ix * iy; return I / (a.w * a.h + b.w * b.h - I);
      };

      const all = [...Array(N).keys()];
      const found = analyze(all).map(b => ({ ...b, t0: 0, t1: dur }));
      // Moving watermark (TikTok switches position during the video): analyze time windows.
      const nw = N >= 16 ? 4 : 2, per = Math.floor(N / nw), half = dur / N / 2;
      const tracks = [];
      for (let w = 0; w < nw; w++) {
        const idx = all.slice(w * per, w === nw - 1 ? N : (w + 1) * per);
        for (const b of analyze(idx)) {
          if (found.some(f => iou(f, b) > 0.3)) continue;
          const t0 = Math.max(0, times[idx[0]] - half), t1 = Math.min(dur, times[idx[idx.length - 1]] + half);
          const tr = tracks.find(t => t.lastW === w - 1 && iou(t, b) > 0.3);
          if (tr) { tr.t1 = t1; tr.lastW = w; tr.score += b.score; tr.x = Math.min(tr.x, b.x); tr.y = Math.min(tr.y, b.y); }
          else tracks.push({ ...b, t0, t1, lastW: w });
        }
      }
      const regions = found.concat(tracks).sort((a, b) => b.score - a.score).slice(0, 4).map(b => {
        const mx = b.w * 0.06 + 0.01, my = b.h * 0.25 + 0.006;
        const x = clamp(b.x - mx, 0, 1), y = clamp(b.y - my, 0, 1);
        return { x, y, w: Math.min(1 - x, b.w + 2 * mx), h: Math.min(1 - y, b.h + 2 * my), t0: Math.round(b.t0 * 100) / 100, t1: Math.round(b.t1 * 100) / 100 };
      });
      return { regions, lowMotion: motion < 6, samples: N };
    } finally {
      v.removeAttribute('src'); v.load();
    }
  }

  return { apply, validate, detect, isActive, toCanvasRect };
})();
