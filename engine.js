'use strict';
/* Sequential playback of clip segments onto a canvas (used for preview and export). */

const AudioHub = {
  ctx: null,
  get() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
};

class Engine {
  /* opts: { render(ctx, W, H, frame), monitor: bool, recDest: MediaStreamAudioDestinationNode, audio: bool } */
  constructor(canvas, opts) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.opts = opts || {};
    this.pool = [this._mk(), this._mk()];
    this.segs = []; this.total = 0; this.cur = -1; this.playing = false;
    this.ls = {}; this.token = 0; this.pre = null; this.master = null; this.muted = false;
    this.loop = this.loop.bind(this);
  }
  _mk() { const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v._url = null; return v; }
  on(e, f) { (this.ls[e] || (this.ls[e] = [])).push(f); }
  emit(e, ...a) { (this.ls[e] || []).forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }

  setSegments(segs) { this.segs = segs; this.total = segs.reduce((a, s) => a + s.dur, 0); this.pre = null; if (this.cur >= segs.length) this.cur = -1; }

  _audio() {
    const ctx = AudioHub.get(); if (!ctx) return;
    if (!this.master) {
      this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 1;
      if (this.opts.monitor !== false) this.master.connect(ctx.destination);
      if (this.opts.recDest) this.master.connect(this.opts.recDest);
    }
    for (const v of this.pool) if (!v._gain) {
      try { const src = ctx.createMediaElementSource(v); const g = ctx.createGain(); src.connect(g); g.connect(this.master); v._gain = g; }
      catch (e) { console.warn('audio routing failed', e); }
    }
  }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 1; this.pool.forEach(v => { if (!v._gain) v.muted = m; }); }
  _applyGain() {
    if (this.cur < 0) return;
    const seg = this.segs[this.cur], v = this.pool[this.cur % 2];
    const vol = (seg.clip.muted || this.opts.audio === false) ? 0 : (seg.clip.volume != null ? seg.clip.volume : 1);
    if (v._gain) v._gain.gain.value = vol; else v.volume = clamp(vol, 0, 1);
  }

  local() {
    if (this.cur < 0) return 0;
    const seg = this.segs[this.cur], v = this.pool[this.cur % 2];
    return clamp(v.currentTime - (seg.clip.trimStart || 0), 0, seg.dur);
  }
  time() { return this.cur < 0 ? 0 : this.segs[this.cur].start + this.local(); }

  async _load(v, seg, local) {
    if (v._url !== seg.url) { v._url = seg.url; v.src = seg.url; await waitEvent(v, 'loadeddata', 20000); }
    await seekVideo(v, (seg.clip.trimStart || 0) + local);
  }
  _preload(i) {
    if (i >= this.segs.length) { this.pre = null; return; }
    const v = this.pool[i % 2];
    const p = this._load(v, this.segs[i], 0).catch(e => { this.emit('error', e, this.segs[i]); });
    this.pre = { i, p };
  }

  async seek(t) {
    const tok = ++this.token; const was = this.playing;
    this._stop();
    if (this.pre) { await this.pre.p; this.pre = null; }
    if (tok !== this.token) return;
    if (!this.segs.length) { this.cur = -1; this.draw(); this.emit('time', 0, 0); return; }
    t = clamp(t, 0, Math.max(0, this.total - 0.001));
    let i = this.segs.findIndex(s => t < s.start + s.dur); if (i < 0) i = this.segs.length - 1;
    const seg = this.segs[i], v = this.pool[i % 2];
    try { await this._load(v, seg, t - seg.start); }
    catch (e) { if (tok === this.token) this.emit('error', e, seg); return; }
    if (tok !== this.token) return;
    this.cur = i; this._applyGain(); this.draw(); this.emit('time', this.time(), this.total);
    this._preload(i + 1);
    if (was) this.play();
  }

  async play() {
    if (!this.segs.length || this.playing) return;
    this._audio();
    if (this.cur < 0 || this.time() >= this.total - 0.03) await this.seek(0);
    if (this.cur < 0) return;
    const tok = this.token;
    this.playing = true; this._applyGain();
    try { await this.pool[this.cur % 2].play(); }
    catch (e) { if (tok === this.token) { this.playing = false; this.emit('error', e); this.emit('state'); } return; }
    if (tok !== this.token || !this.playing) return;
    this.emit('state');
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop);
    this._scheduleEnd();
  }

  _stop() { this.playing = false; cancelAnimationFrame(this.raf); clearTimeout(this.endTimer); this.pool.forEach(v => v.pause()); }

  /* The end of a fragment is detected by an exact timer as well as by the render loop: on a slow device the
     loop may run at only a few frames per second, and the video would otherwise play past the out point. */
  _scheduleEnd() {
    clearTimeout(this.endTimer);
    if (!this.playing || this.cur < 0) return;
    const seg = this.segs[this.cur], v = this.pool[this.cur % 2], tok = this.token;
    const remain = seg.dur - (v.currentTime - (seg.clip.trimStart || 0));
    this.endTimer = setTimeout(() => { if (this.playing && tok === this.token && !this._adv) this._advance(); }, Math.max(0, remain * 1000 - 6));
  }
  pause() { this.token++; this._stop(); this.emit('state'); this.emit('time', this.time(), this.total); }

  loop() {
    if (!this.playing) return;
    const seg = this.segs[this.cur], v = this.pool[this.cur % 2];
    const local = v.currentTime - (seg.clip.trimStart || 0);
    if (local >= seg.dur - 0.001 || v.ended) { this._advance(); return; }
    this.draw(); this.emit('time', this.time(), this.total);
    this.raf = requestAnimationFrame(this.loop);
  }

  async _advance() {
    if (this._adv) return;            // the timer and the render loop may both notice the end of a fragment
    this._adv = true;
    try { await this._advanceInner(); } finally { this._adv = false; }
  }

  async _advanceInner() {
    clearTimeout(this.endTimer);
    const tok = this.token;
    this.pool[this.cur % 2].pause();
    if (this.cur + 1 >= this.segs.length) {
      this.playing = false; this.draw(); this.emit('time', this.total, this.total); this.emit('state'); this.emit('ended'); return;
    }
    const ni = this.cur + 1, nv = this.pool[ni % 2];
    try {
      if (this.pre && this.pre.i === ni) await this.pre.p; else await this._load(nv, this.segs[ni], 0);
      if (nv._url !== this.segs[ni].url) await this._load(nv, this.segs[ni], 0);
    } catch (e) { this.emit('error', e, this.segs[ni]); }
    if (tok !== this.token || !this.playing) return;
    this.cur = ni; this._applyGain();
    try { await nv.play(); } catch (e) { this.emit('error', e); }
    if (tok !== this.token || !this.playing) return;
    this.emit('clip', ni);
    this._preload(ni + 1);
    this.raf = requestAnimationFrame(this.loop);
    this._scheduleEnd();
  }

  draw() {
    const W = this.canvas.width, H = this.canvas.height;
    const f = this.cur >= 0 ? { seg: this.segs[this.cur], index: this.cur, video: this.pool[this.cur % 2], segs: this.segs } : { segs: this.segs };
    this.opts.render(this.ctx, W, H, f);
  }
  redraw() { this.draw(); }

  destroy() {
    this.token++; this._stop();
    this.pool.forEach(v => { try { v._gain && v._gain.disconnect(); } catch (e) {} v.removeAttribute('src'); v.load(); });
    try { this.master && this.master.disconnect(); } catch (e) {}
  }
}
