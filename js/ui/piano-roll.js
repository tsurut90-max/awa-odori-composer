import { TPB, ticksPerBar } from '../core/song.js';
import { getInstrument } from '../instruments/registry.js';

const ROW_H = 18;
const TOUCH_ROW_H = 28;
const EDGE = 7;
const TAP_SLOP = 10;

const cssCache = new Map();
const css = (name) => {
  if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return cssCache.get(name);
};

function sizeCanvas(canvas, w, h, dpr, { styleWidth = true } = {}) {
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (styleWidth) canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export class PianoRoll {
  constructor(app, { ruler, keys, grid, scroller, spacer }) {
    this.app = app;
    Object.assign(this, { ruler, keys, grid, scroller, spacer });
    this.pxPerBeat = 90;
    this.snap = TPB / 4;
    this.selection = new Set();
    this.lastLen = null;
    this.drag = null;
    this.box = null;
    this.follow = true;
    this.pending = false;
    this.touch = null;
    this.lastPointerType = 'mouse';
    this.rowH = matchMedia('(pointer: coarse)').matches ? TOUCH_ROW_H : ROW_H;
    this.bindEvents();
    new ResizeObserver(() => this.invalidate()).observe(scroller);
  }

  get track() { return this.app.editTrack(); }
  get pxPerTick() { return this.pxPerBeat / TPB; }

  refreshRows() {
    const track = this.track;
    const def = track && getInstrument(track.instrument);
    this.def = def;
    this.rows = def ? def.rows(track.params) : [];
    this.rowOf = new Map(this.rows.map((r, i) => [r.pitch, i]));
  }

  invalidate() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  scrollToPitchCenter() {
    this.refreshRows();
    const notes = this.track?.notes ?? [];
    if (!notes.length) return;
    const idx = notes.map((n) => this.rowOf.get(n.pitch)).filter((i) => i !== undefined);
    const mid = (Math.min(...idx) + Math.max(...idx)) / 2;
    this.scroller.scrollTop = mid * this.rowH - this.scroller.clientHeight / 2;
  }

  // ---- coordinates -------------------------------------------------------
  tickToX(tick) { return tick * this.pxPerTick - this.scroller.scrollLeft; }
  xToTick(x) { return (x + this.scroller.scrollLeft) / this.pxPerTick; }
  rowToY(row) { return row * this.rowH - this.scroller.scrollTop; }
  yToRow(y) { return Math.floor((y + this.scroller.scrollTop) / this.rowH); }
  snapTick(t, mode = 'round') { return Math[mode](t / this.snap) * this.snap; }

  noteLen(n) {
    return this.def?.kind === 'percussion' ? Math.min(n.len, this.snap) : n.len;
  }

  hitNote(x, y, slop = 0) {
    const track = this.track;
    if (!track) return null;
    const row = this.yToRow(y);
    for (let i = track.notes.length - 1; i >= 0; i--) {
      const n = track.notes[i];
      if (this.rowOf.get(n.pitch) !== row) continue;
      const right = this.tickToX(n.tick + this.noteLen(n));
      if (x >= this.tickToX(n.tick) - slop && x < right + slop) {
        const canResize = this.def.kind !== 'percussion';
        return { note: n, edge: canResize && right - x <= EDGE && right - this.tickToX(n.tick) > EDGE * 2 };
      }
    }
    return null;
  }

  // ---- events -------------------------------------------------------------
  bindEvents() {
    const sc = this.scroller;
    sc.addEventListener('scroll', () => this.invalidate());
    sc.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tick = this.xToTick(x);
      this.setZoom(this.pxPerBeat * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      sc.scrollLeft = tick * this.pxPerTick - x;
    }, { passive: false });
    sc.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    sc.addEventListener('pointermove', (e) => this.onPointerMove(e));
    sc.addEventListener('pointerup', (e) => this.onPointerUp(e));
    sc.addEventListener('pointercancel', () => { this.touch = null; });
    sc.addEventListener('dblclick', (e) => {
      if (this.lastPointerType === 'touch') return;
      const { x, y } = this.localPos(e);
      const hit = this.hitNote(x, y);
      if (!hit) return;
      this.app.checkpoint();
      this.track.notes.splice(this.track.notes.indexOf(hit.note), 1);
      this.selection.delete(hit.note);
      this.app.changed();
    });
    sc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.lastPointerType === 'touch') return;
      const { x, y } = this.localPos(e);
      const hit = this.hitNote(x, y);
      if (!hit) return;
      this.app.checkpoint();
      const targets = this.selection.has(hit.note) ? [...this.selection] : [hit.note];
      this.track.notes = this.track.notes.filter((n) => !targets.includes(n));
      targets.forEach((n) => this.selection.delete(n));
      this.app.changed();
    });

    this.keys.addEventListener('pointerdown', (e) => {
      const rect = this.keys.getBoundingClientRect();
      const row = this.rows[this.yToRow(e.clientY - rect.top)];
      if (row && this.track) this.app.engine.preview(this.app.song, this.track, row.pitch);
    });
    this.keys.addEventListener('wheel', (e) => { sc.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });

    this.ruler.addEventListener('pointerdown', (e) => {
      const rect = this.ruler.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      this.ruler.setPointerCapture(e.pointerId);
      const startTick = Math.max(0, this.xToTick(x0));
      let dragging = false;
      const move = (ev) => {
        const x = ev.clientX - rect.left;
        if (!dragging && Math.abs(x - x0) < 4) return;
        dragging = true;
        const a = Math.max(0, Math.round(startTick / TPB) * TPB);
        const b = Math.max(0, Math.round(this.xToTick(x) / TPB) * TPB);
        if (a !== b) this.app.setLoop(Math.min(a, b), Math.max(a, b), true);
      };
      const up = (ev) => {
        this.ruler.removeEventListener('pointermove', move);
        this.ruler.removeEventListener('pointerup', up);
        if (!dragging) this.app.seek(Math.max(0, this.snapTick(this.xToTick(ev.clientX - rect.left), 'floor')));
      };
      this.ruler.addEventListener('pointermove', move);
      this.ruler.addEventListener('pointerup', up);
    });
  }

  localPos(e) {
    const rect = this.scroller.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Touch: one finger scrolls natively; a touch that ends without moving is a tap.
  tap(x, y) {
    const hit = this.hitNote(x, y, TAP_SLOP);
    if (hit) {
      this.selection = new Set([hit.note]);
      this.app.selectionChanged();
      this.app.engine.preview(this.app.song, this.track, hit.note.pitch, hit.note.vel);
      return;
    }
    if (this.selection.size) {
      this.selection.clear();
      this.app.selectionChanged();
      return;
    }
    if (this.createNote(this.xToTick(x), this.yToRow(y))) this.app.changed();
  }

  createNote(tick, row) {
    const rowInfo = this.rows[row];
    if (!rowInfo || tick < 0) return null;
    this.app.checkpoint();
    const note = {
      tick: Math.max(0, this.snapTick(tick, 'floor')),
      len: this.lastLen ?? this.def.defaultLength,
      pitch: rowInfo.pitch,
      vel: 0.8,
    };
    this.track.notes.push(note);
    this.track.notes.sort((a, b) => a.tick - b.tick);
    this.selection = new Set([note]);
    this.app.selectionChanged();
    this.app.engine.preview(this.app.song, this.track, note.pitch, note.vel);
    return note;
  }

  onPointerDown(e) {
    this.lastPointerType = e.pointerType;
    if (e.button !== 0 || !this.track) return;
    const { x, y } = this.localPos(e);
    if (x > this.scroller.clientWidth || y > this.scroller.clientHeight) return;
    if (e.pointerType === 'touch') {
      this.touch = { id: e.pointerId, x, y, moved: false };
      return;
    }
    this.scroller.setPointerCapture(e.pointerId);
    const hit = this.hitNote(x, y);
    const tick = this.xToTick(x);
    const row = this.yToRow(y);

    if (e.shiftKey && !hit) {
      this.box = { x0: x + this.scroller.scrollLeft, y0: y + this.scroller.scrollTop, x1: x + this.scroller.scrollLeft, y1: y + this.scroller.scrollTop };
      this.drag = { mode: 'box' };
      return;
    }
    if (hit) {
      if (e.shiftKey) {
        this.selection.has(hit.note) ? this.selection.delete(hit.note) : this.selection.add(hit.note);
        this.app.selectionChanged();
        this.invalidate();
        return;
      }
      if (!this.selection.has(hit.note)) {
        this.selection = new Set([hit.note]);
        this.app.selectionChanged();
      }
      this.startDrag(hit.edge ? 'resize' : 'move', tick, row, hit.note, false, x);
      if (!hit.edge) this.app.engine.preview(this.app.song, this.track, hit.note.pitch, hit.note.vel);
      return;
    }

    const note = this.createNote(tick, row);
    if (!note) return;
    this.startDrag(this.def.kind === 'percussion' ? 'move' : 'resize', tick, row, note, true, x);
    this.app.changed();
  }

  startDrag(mode, tick, row, anchor, created, x0) {
    if (!created) this.app.checkpoint();
    this.drag = {
      mode,
      tick,
      row,
      anchor,
      created,
      x0,
      moved: false,
      orig: new Map([...this.selection].map((n) => [n, { tick: n.tick, len: n.len, pitch: n.pitch }])),
      lastPitch: anchor.pitch,
    };
  }

  onPointerMove(e) {
    const { x, y } = this.localPos(e);
    if (this.touch?.id === e.pointerId) {
      if (Math.hypot(x - this.touch.x, y - this.touch.y) > TAP_SLOP) this.touch.moved = true;
      return;
    }
    if (e.pointerType === 'touch') return;
    if (!this.drag) {
      const hit = this.hitNote(x, y);
      this.scroller.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair';
      return;
    }
    const d = this.drag;
    if (d.mode === 'box') {
      this.box.x1 = x + this.scroller.scrollLeft;
      this.box.y1 = y + this.scroller.scrollTop;
      this.invalidate();
      return;
    }
    const dTick = this.xToTick(x) - d.tick;
    const dRow = this.yToRow(y) - d.row;
    const a = d.orig.get(d.anchor);
    if (d.mode === 'move') {
      const minTick = Math.min(...[...d.orig.values()].map((o) => o.tick));
      let shift = this.snapTick(a.tick + dTick) - a.tick;
      shift = Math.max(shift, -minTick);
      for (const [n, o] of d.orig) {
        n.tick = o.tick + shift;
        const r = this.rowOf.get(o.pitch);
        const target = this.rows[Math.min(this.rows.length - 1, Math.max(0, r + dRow))];
        n.pitch = target ? target.pitch : o.pitch;
      }
      if (d.anchor.pitch !== d.lastPitch) {
        d.lastPitch = d.anchor.pitch;
        this.app.engine.preview(this.app.song, this.track, d.anchor.pitch, d.anchor.vel);
      }
    } else {
      if (d.created && Math.abs(x - d.x0) < 4) return;
      const pointer = this.xToTick(x);
      for (const [n, o] of d.orig) {
        n.len = d.created
          ? Math.max(this.snap, this.snapTick(pointer - o.tick, 'ceil'))
          : Math.max(this.snap, this.snapTick(o.tick + o.len + dTick) - o.tick);
      }
    }
    d.moved = true;
    this.app.changed(false);
  }

  onPointerUp(e) {
    if (this.touch?.id === e.pointerId) {
      const t = this.touch;
      this.touch = null;
      if (!t.moved) this.tap(t.x, t.y);
      return;
    }
    if (!this.drag) return;
    this.onPointerMove(e);
    const d = this.drag;
    this.drag = null;
    if (d.mode === 'box') {
      const b = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
      const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
      for (const n of this.track.notes) {
        const nx0 = n.tick * this.pxPerTick;
        const nx1 = (n.tick + this.noteLen(n)) * this.pxPerTick;
        const ny0 = (this.rowOf.get(n.pitch) ?? -99) * this.rowH;
        if (nx1 >= x0 && nx0 <= x1 && ny0 + this.rowH >= y0 && ny0 <= y1) this.selection.add(n);
      }
      this.app.selectionChanged();
      this.invalidate();
      return;
    }
    if (d.mode === 'resize' || d.created) this.lastLen = d.anchor.len;
    this.track.notes.sort((a, b) => a.tick - b.tick);
    this.app.changed();
    this.app.dropCheckpointIfUnchanged();
  }

  setZoom(px) {
    this.pxPerBeat = Math.min(400, Math.max(10, px));
    this.invalidate();
  }

  ensureVisible(tick) {
    const x = this.tickToX(tick);
    const w = this.scroller.clientWidth;
    if (x > w - 60 || x < 0) this.scroller.scrollLeft = Math.max(0, tick * this.pxPerTick - w * 0.2);
  }

  // ---- drawing ------------------------------------------------------------
  drawVerticalLines(g, width, height) {
    const song = this.app.song;
    const bar = ticksPerBar(song);
    const t0 = this.xToTick(0);
    const t1 = this.xToTick(width);
    const step = this.snap * this.pxPerTick >= 7 ? this.snap : this.pxPerBeat >= 10 ? TPB : bar;
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(this.tickToX(t)) + 0.5;
      g.strokeStyle = t % bar === 0 ? css('--line-bar') : t % TPB === 0 ? css('--line-beat') : css('--line-sub');
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
  }

  drawPlayhead(g, height) {
    const tick = this.app.currentTick();
    const x = Math.round(this.tickToX(tick)) + 0.5;
    g.strokeStyle = css('--playhead');
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
    g.lineWidth = 1;
  }

  drawLoopShade(g, height) {
    const loop = this.app.song.loop;
    if (!loop.enabled) return;
    const x0 = this.tickToX(loop.start);
    const x1 = this.tickToX(loop.end);
    g.fillStyle = css('--loop-shade');
    g.fillRect(x0, 0, x1 - x0, height);
  }

  render() {
    cssCache.clear();
    this.refreshRows();
    const dpr = window.devicePixelRatio || 1;
    const song = this.app.song;
    const width = this.scroller.clientWidth;
    const height = this.scroller.clientHeight;
    const endTick = this.app.engine.endTick(song) + ticksPerBar(song) * 8;
    this.spacer.style.width = `${endTick * this.pxPerTick}px`;
    this.spacer.style.height = `${this.rows.length * this.rowH}px`;

    if (this.follow && this.app.engine.playing) this.ensureVisible(this.app.currentTick());

    this.renderRuler(width, dpr);
    this.renderKeys(height, dpr);

    const g = sizeCanvas(this.grid, width, height, dpr);
    g.fillStyle = css('--grid-bg');
    g.fillRect(0, 0, width, height);
    if (!this.track) {
      g.fillStyle = css('--text-dim');
      g.font = '14px sans-serif';
      g.fillText('楽器トラックを追加すると、ここで音符を編集できます', 20, 30);
      return;
    }
    const r0 = Math.max(0, this.yToRow(0));
    const r1 = Math.min(this.rows.length - 1, this.yToRow(height));
    for (let r = r0; r <= r1; r++) {
      const row = this.rows[r];
      const y = this.rowToY(r);
      g.fillStyle = row.inScale ? css('--row-in') : css('--row-out');
      g.fillRect(0, y, width, this.rowH);
      g.fillStyle = row.accent ? css('--line-bar') : css('--line-sub');
      g.fillRect(0, y + this.rowH - 1, width, 1);
    }
    this.drawLoopShade(g, height);
    this.drawVerticalLines(g, width, height);

    const color = this.def.color;
    const t0 = this.xToTick(-50);
    const t1 = this.xToTick(width);
    g.font = '11px sans-serif';
    g.textBaseline = 'middle';
    for (const n of this.track.notes) {
      const len = this.noteLen(n);
      if (n.tick + len < t0 || n.tick > t1) continue;
      const r = this.rowOf.get(n.pitch);
      if (r === undefined || r < r0 - 1 || r > r1 + 1) continue;
      const x = this.tickToX(n.tick);
      const w = Math.max(3, len * this.pxPerTick - 1);
      const y = this.rowToY(r) + 1;
      const sel = this.selection.has(n);
      g.globalAlpha = 0.45 + 0.55 * n.vel;
      g.fillStyle = sel ? css('--note-selected') : color;
      g.fillRect(x, y, w, this.rowH - 2);
      g.globalAlpha = 1;
      g.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.45)';
      g.strokeRect(x + 0.5, y + 0.5, w - 1, this.rowH - 3);
      if (w > 30) {
        g.fillStyle = sel ? '#111' : '#fff';
        g.fillText(this.rows[r].label, x + 4, y + this.rowH / 2 - 1, w - 6);
      }
    }
    if (this.box) {
      const b = this.box;
      g.fillStyle = 'rgba(120,170,255,0.15)';
      g.strokeStyle = 'rgba(150,190,255,0.9)';
      const bx = Math.min(b.x0, b.x1) - this.scroller.scrollLeft;
      const by = Math.min(b.y0, b.y1) - this.scroller.scrollTop;
      g.fillRect(bx, by, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(bx + 0.5, by + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    this.drawPlayhead(g, height);
  }

  renderRuler(width, dpr) {
    const H = 30;
    const g = sizeCanvas(this.ruler, width, H, dpr);
    const song = this.app.song;
    g.fillStyle = css('--panel');
    g.fillRect(0, 0, width, H);
    const loop = song.loop;
    if (loop.end > loop.start) {
      g.fillStyle = loop.enabled ? css('--loop') : css('--loop-off');
      g.fillRect(this.tickToX(loop.start), 0, (loop.end - loop.start) * this.pxPerTick, 6);
    }
    const bar = ticksPerBar(song);
    const barPx = bar * this.pxPerTick;
    const labelEvery = Math.max(1, Math.ceil(36 / barPx));
    const t0 = Math.max(0, Math.floor(this.xToTick(0) / TPB) * TPB);
    const t1 = this.xToTick(width);
    g.font = '11px sans-serif';
    g.textBaseline = 'top';
    for (let t = t0; t <= t1; t += TPB) {
      const x = Math.round(this.tickToX(t)) + 0.5;
      const isBar = t % bar === 0;
      g.strokeStyle = isBar ? css('--text-dim') : css('--line-beat');
      g.beginPath();
      g.moveTo(x, isBar ? 10 : 20);
      g.lineTo(x, H);
      g.stroke();
      const barNo = t / bar;
      if (isBar && barNo % labelEvery === 0) {
        g.fillStyle = css('--text');
        g.fillText(String(barNo + 1), x + 3, 10);
      }
    }
    const px = this.tickToX(this.app.currentTick());
    g.fillStyle = css('--playhead');
    g.beginPath();
    g.moveTo(px - 6, H - 9);
    g.lineTo(px + 6, H - 9);
    g.lineTo(px, H);
    g.closePath();
    g.fill();
  }

  renderKeys(height, dpr) {
    const W = this.keys.clientWidth;
    const g = sizeCanvas(this.keys, W, height, dpr, { styleWidth: false });
    g.fillStyle = css('--panel');
    g.fillRect(0, 0, W, height);
    if (!this.track) return;
    g.textBaseline = 'middle';
    const r0 = Math.max(0, this.yToRow(0));
    const r1 = Math.min(this.rows.length - 1, this.yToRow(height));
    for (let r = r0; r <= r1; r++) {
      const row = this.rows[r];
      const y = this.rowToY(r);
      g.fillStyle = row.inScale ? css('--key-in') : css('--key-out');
      g.fillRect(0, y, W, this.rowH - 1);
      g.fillStyle = row.inScale ? css('--text') : css('--text-dim');
      g.font = row.accent ? 'bold 12px sans-serif' : '12px sans-serif';
      g.fillText(row.label, 8, y + this.rowH / 2);
      if (row.sub && W >= 90) {
        g.fillStyle = css('--text-dim');
        g.font = '10px sans-serif';
        g.textAlign = 'right';
        g.fillText(row.sub, W - 6, y + this.rowH / 2);
        g.textAlign = 'left';
      }
    }
  }
}
