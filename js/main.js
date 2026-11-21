import './instruments/index.js';
import { listInstruments, getInstrument } from './instruments/registry.js';
import {
  TPB, createEmptySong, normalizeSong, serializeSong, createInstrumentTrack,
  isAudible, ticksPerBar, ticksToSeconds,
} from './core/song.js';
import { AudioEngine, encodeWav } from './core/audio-engine.js';
import { PianoRoll } from './ui/piano-roll.js';
import { decodeAudio } from './analysis/transcriber.js';
import { songFromRecording } from './analysis/recording-to-song.js';

const AUTOSAVE_KEY = 'awa-odori-composer:autosave';
const DEFAULT_SONG_URL = 'songs/default-song.json';
const HISTORY_LIMIT = 200;
const SNAPS = [
  [TPB, '1拍'], [TPB / 2, '1/2拍'], [TPB / 3, '1/3拍（三連）'], [TPB / 4, '1/4拍'],
  [TPB / 6, '1/6拍'], [TPB / 8, '1/8拍'], [TPB / 24, '細かく（1/24拍）'],
];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (s) => (s || '無題').replace(/[\\/:*?"<>|]/g, '_');

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.engine.onStop = () => this.onEngineStopped();
    this.song = createEmptySong();
    this.editTrackId = null;
    this.selectedTrackId = null;
    this.playhead = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = null;
    this.paramEditing = false;
    this.roll = new PianoRoll(this, {
      ruler: $('ruler'), keys: $('keys'), grid: $('grid'), scroller: $('scroller'), spacer: $('spacer'),
    });
    this.bindUI();
  }

  async init() {
    let song = null;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) song = normalizeSong(JSON.parse(raw));
    } catch {
      song = null;
    }
    if (!song) song = await this.fetchDefault();
    this.setSong(song, { resetView: true });
    this.setStatus(song.title ? `「${song.title}」を開きました` : '準備完了');
  }

  async fetchDefault() {
    try {
      const res = await fetch(DEFAULT_SONG_URL, { cache: 'no-store' });
      return normalizeSong(await res.json());
    } catch (err) {
      console.error(err);
      this.setStatus('デフォルト曲を読み込めませんでした。空の曲で開始します', 'warn');
      return createEmptySong();
    }
  }

  // ---- song state ---------------------------------------------------------
  setSong(song, { resetView = false, keepHistory = false } = {}) {
    this.engine.stop();
    this.song = song;
    if (!keepHistory) { this.undoStack = []; this.redoStack = []; }
    if (!song.tracks.some((t) => t.id === this.editTrackId)) this.editTrackId = song.tracks.find((t) => t.type === 'instrument')?.id ?? null;
    if (!song.tracks.some((t) => t.id === this.selectedTrackId)) this.selectedTrackId = this.editTrackId ?? song.tracks[0]?.id ?? null;
    this.roll.selection.clear();
    if (resetView) {
      this.playhead = 0;
      this.roll.scroller.scrollLeft = 0;
    }
    this.engine.setReverb(song.reverb);
    this.renderAll();
    if (resetView) requestAnimationFrame(() => this.roll.scrollToPitchCenter());
  }

  editTrack() {
    return this.song.tracks.find((t) => t.id === this.editTrackId && t.type === 'instrument') ?? null;
  }

  isAudible(track) {
    return isAudible(this.song, track);
  }

  currentTick() {
    return this.engine.positionTick() ?? this.playhead;
  }

  checkpoint() {
    this.undoStack.push(JSON.stringify(this.song));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateToolbar();
  }

  dropCheckpointIfUnchanged() {
    if (this.undoStack[this.undoStack.length - 1] === JSON.stringify(this.song)) this.undoStack.pop();
    this.updateToolbar();
  }

  restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(this.song));
    const wasPlaying = this.engine.playing;
    const tick = this.currentTick();
    this.setSong(JSON.parse(from.pop()), { keepHistory: true });
    this.scheduleAutosave();
    if (wasPlaying) {
      this.engine.play(this.song, tick);
      this.startAnimation();
      this.updateTransport();
    }
  }

  undo() { this.restore(this.undoStack, this.redoStack); this.setStatus('元に戻しました'); }
  redo() { this.restore(this.redoStack, this.undoStack); this.setStatus('やり直しました'); }

  changed(full = true) {
    this.roll.invalidate();
    this.renderNoteInfo();
    this.updateToolbar();
    if (full) {
      this.scheduleAutosave();
      this.engine.updateMix(this.song);
    }
  }

  selectionChanged() {
    this.renderNoteInfo();
    this.updateToolbar();
    this.roll.invalidate();
  }

  updateToolbar() {
    const count = this.selectedNotes().length;
    const percussion = getInstrument(this.editTrack()?.instrument)?.kind === 'percussion';
    for (const id of ['tbUp', 'tbDown', 'tbLeft', 'tbRight', 'tbDup', 'tbDelete']) $(id).disabled = !count;
    for (const id of ['tbShorter', 'tbLonger']) $(id).disabled = !count || percussion;
    $('tbUndo').disabled = !this.undoStack.length;
    $('tbRedo').disabled = !this.redoStack.length;
    $('tbInfo').textContent = count ? `${count}個選択中` : '';
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeSong(this.song)));
      } catch {
        // storage unavailable (private mode etc.): autosave is a convenience only
      }
    }, 600);
  }

  // ---- transport ----------------------------------------------------------
  async togglePlay() {
    if (this.engine.playing) {
      this.playhead = this.currentTick();
      this.engine.stop();
      this.updateTransport();
      this.roll.invalidate();
      return;
    }
    const loop = this.song.loop;
    let from = this.playhead;
    if (loop.enabled && (from < loop.start || from >= loop.end)) from = loop.start;
    if (!loop.enabled && from >= this.engine.endTick(this.song)) from = 0;
    this.engine.play(this.song, from);
    this.startAnimation();
    this.updateTransport();
  }

  startAnimation() {
    const step = () => {
      if (!this.engine.playing) return;
      this.updatePosition();
      this.roll.invalidate();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  onEngineStopped() {
    this.playhead = 0;
    this.updateTransport();
    this.roll.invalidate();
  }

  seek(tick) {
    this.playhead = tick;
    if (this.engine.playing) this.engine.play(this.song, tick);
    this.updatePosition();
    this.roll.invalidate();
  }

  setLoop(start, end, enabled) {
    this.song.loop = { start, end, enabled };
    this.updateTransport();
    this.roll.invalidate();
    this.scheduleAutosave();
  }

  restartIfPlaying() {
    if (!this.engine.playing) return;
    const tick = this.currentTick();
    this.engine.play(this.song, tick);
  }

  // ---- editing commands ---------------------------------------------------
  selectedNotes() {
    const track = this.editTrack();
    return track ? track.notes.filter((n) => this.roll.selection.has(n)) : [];
  }

  editNotes(label, fn) {
    const track = this.editTrack();
    if (!track) return;
    this.checkpoint();
    fn(track);
    track.notes.sort((a, b) => a.tick - b.tick);
    this.dropCheckpointIfUnchanged();
    this.changed();
    if (label) this.setStatus(label);
  }

  deleteSelection() {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    this.editNotes(`${sel.length}個の音符を削除しました`, (track) => {
      track.notes = track.notes.filter((n) => !this.roll.selection.has(n));
      this.roll.selection.clear();
    });
  }

  transposeSelection(semitones) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const pitches = new Set(this.roll.rows.map((r) => r.pitch));
    if (!sel.every((n) => pitches.has(n.pitch + semitones))) return;
    this.editNotes(null, () => sel.forEach((n) => { n.pitch += semitones; }));
    this.engine.preview(this.song, this.editTrack(), sel[0].pitch, sel[0].vel);
  }

  shiftSelection(ticks) {
    const sel = this.selectedNotes();
    if (!sel.length || Math.min(...sel.map((n) => n.tick)) + ticks < 0) return;
    this.editNotes(null, () => sel.forEach((n) => { n.tick += ticks; }));
  }

  resizeSelection(ticks) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const min = this.roll.snap;
    this.editNotes(null, () => sel.forEach((n) => { n.len = Math.max(min, n.len + ticks); }));
  }

  quantize() {
    const track = this.editTrack();
    if (!track) return;
    const targets = this.selectedNotes().length ? this.selectedNotes() : track.notes;
    const q = this.roll.snap;
    this.editNotes(`${targets.length}個の音符をグリッドに揃えました`, () => {
      for (const n of targets) {
        const end = Math.round((n.tick + n.len) / q) * q;
        n.tick = Math.round(n.tick / q) * q;
        n.len = Math.max(q, end - n.tick);
      }
    });
  }

  copySelection(cut = false) {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const base = Math.min(...sel.map((n) => n.tick));
    this.clipboard = sel.map((n) => ({ ...n, tick: n.tick - base }));
    if (cut) this.deleteSelection();
    this.setStatus(`${sel.length}個の音符を${cut ? '切り取り' : 'コピー'}しました`);
  }

  paste(at = this.roll.snapTick(this.currentTick(), 'floor')) {
    if (!this.clipboard?.length) return;
    this.editNotes(`${this.clipboard.length}個の音符を貼り付けました`, (track) => {
      const added = this.clipboard.map((n) => ({ ...n, tick: n.tick + at }));
      track.notes.push(...added);
      this.roll.selection = new Set(added);
    });
  }

  duplicateSelection() {
    const sel = this.selectedNotes();
    if (!sel.length) return;
    const start = Math.min(...sel.map((n) => n.tick));
    const end = Math.max(...sel.map((n) => n.tick + n.len));
    this.copySelection();
    this.paste(start + Math.ceil((end - start) / this.roll.snap) * this.roll.snap);
  }

  selectAll() {
    const track = this.editTrack();
    if (!track) return;
    this.roll.selection = new Set(track.notes);
    this.selectionChanged();
  }

  // ---- tracks -------------------------------------------------------------
  addInstrumentTrack(instrumentId) {
    this.checkpoint();
    const track = createInstrumentTrack(instrumentId);
    this.song.tracks.push(track);
    this.editTrackId = track.id;
    this.selectedTrackId = track.id;
    this.roll.selection.clear();
    this.renderAll();
    this.scheduleAutosave();
    this.setStatus(`「${track.name}」トラックを追加しました`);
  }

  removeTrack(track) {
    if (!confirm(`トラック「${track.name}」を削除しますか？`)) return;
    this.checkpoint();
    this.song.tracks = this.song.tracks.filter((t) => t !== track);
    if (this.editTrackId === track.id) this.editTrackId = this.song.tracks.find((t) => t.type === 'instrument')?.id ?? null;
    if (this.selectedTrackId === track.id) this.selectedTrackId = this.editTrackId ?? this.song.tracks[0]?.id ?? null;
    this.roll.selection.clear();
    this.renderAll();
    this.scheduleAutosave();
  }

  selectTrack(track) {
    this.selectedTrackId = track.id;
    if (track.type === 'instrument' && this.editTrackId !== track.id) {
      this.editTrackId = track.id;
      this.roll.selection.clear();
      requestAnimationFrame(() => this.roll.scrollToPitchCenter());
    }
    this.renderAll();
  }

  // ---- file operations ----------------------------------------------------
  saveJson() {
    const data = serializeSong(this.song);
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${safeName(this.song.title)}.json`);
    this.setStatus('曲データを保存しました');
  }

  async openJson(file) {
    try {
      const song = normalizeSong(JSON.parse(await file.text()));
      this.setSong(song, { resetView: true });
      this.scheduleAutosave();
      this.setStatus(`「${song.title}」を開きました`);
    } catch (err) {
      this.setStatus(`開けませんでした: ${err.message}`, 'error');
    }
  }

  async transcribeFile(file) {
    if (!confirm('現在の曲を閉じて、この音源から新しい曲を作りますか？（現在の曲は「保存」で書き出せます）')) return;
    this.setStatus('採譜中…（少し時間がかかります）');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const buffer = await decodeAudio(await file.arrayBuffer());
      const song = normalizeSong(songFromRecording(buffer, { title: file.name.replace(/\.[^.]+$/, '') }));
      this.setSong(song, { resetView: true });
      this.scheduleAutosave();
      const notes = song.tracks[0].notes.length;
      this.setStatus(`採譜しました：音符 ${notes} 個、推定テンポ ${song.bpm} BPM`);
    } catch (err) {
      console.error(err);
      this.setStatus(`採譜できませんでした: ${err.message}`, 'error');
    }
  }

  async exportWav() {
    this.setStatus('WAVを書き出し中…');
    $('btnExport').disabled = true;
    try {
      const buffer = await this.engine.renderOffline(this.song);
      download(encodeWav(buffer), `${safeName(this.song.title)}.wav`);
      this.setStatus(`WAVを書き出しました（${buffer.duration.toFixed(1)}秒）`);
    } catch (err) {
      console.error(err);
      this.setStatus(`書き出しに失敗しました: ${err.message}`, 'error');
    } finally {
      $('btnExport').disabled = false;
    }
  }

  // ---- rendering ----------------------------------------------------------
  renderAll() {
    $('title').value = this.song.title;
    $('bpm').value = this.song.bpm;
    $('beats').value = String(this.song.beatsPerBar);
    $('reverb').value = this.song.reverb;
    this.renderTrackList();
    this.renderTrackSettings();
    this.renderNoteInfo();
    this.updateTransport();
    this.updateToolbar();
    this.roll.invalidate();
  }

  renderTrackList() {
    const list = $('trackList');
    list.replaceChildren();
    for (const track of this.song.tracks) {
      const def = getInstrument(track.instrument);
      const li = el('li', { className: 'track' });
      li.classList.toggle('selected', track.id === this.selectedTrackId);
      li.classList.toggle('editing', track.id === this.editTrackId);
      li.classList.toggle('muted', !this.isAudible(track));
      li.style.setProperty('--track-color', def.color);
      li.addEventListener('click', (e) => {
        if (e.target.closest('button, input')) return;
        this.selectTrack(track);
      });

      const name = el('input', { className: 'track-name', value: track.name, title: 'トラック名' });
      name.addEventListener('change', () => { this.checkpoint(); track.name = name.value; this.scheduleAutosave(); this.roll.invalidate(); });
      name.addEventListener('focus', () => { if (this.selectedTrackId !== track.id) this.selectTrack(track); });

      const toggle = (key, label, title) => {
        const b = el('button', { className: `mini ${key}`, textContent: label, title });
        b.classList.toggle('on', track[key]);
        b.addEventListener('click', () => {
          track[key] = !track[key];
          this.engine.updateMix(this.song);
          this.renderTrackList();
          this.roll.invalidate();
          this.scheduleAutosave();
        });
        return b;
      };
      const vol = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: track.volume, className: 'vol', title: '音量' });
      vol.addEventListener('input', () => { track.volume = Number(vol.value); this.engine.updateMix(this.song); });
      vol.addEventListener('change', () => this.scheduleAutosave());

      li.append(
        el('div', { className: 'track-top' },
          el('span', { className: 'chip' }),
          name,
          toggle('mute', 'M', 'ミュート'),
          toggle('solo', 'S', 'ソロ')),
        el('div', { className: 'track-bottom' },
          el('span', { className: 'kind', textContent: def.name }),
          vol),
      );
      list.append(li);
    }
  }

  renderTrackSettings() {
    const box = $('trackSettings');
    box.replaceChildren();
    const track = this.song.tracks.find((t) => t.id === this.selectedTrackId);
    if (!track) { box.hidden = true; return; }
    box.hidden = false;
    box.append(el('div', { className: 'panel-head' }, el('h2', { textContent: `設定：${track.name}` })));
    const body = el('div', { className: 'settings' });
    box.append(body);

    const def = getInstrument(track.instrument);
    for (const p of def.params) body.append(this.paramControl(track, p));
    const q = el('button', { textContent: 'グリッドに揃える', title: '選択中（未選択なら全部）の音符をグリッドに揃えます (Q)' });
    q.addEventListener('click', () => this.quantize());
    body.append(el('div', { className: 'row-actions' }, q));
    const del = el('button', { className: 'danger', textContent: 'トラックを削除' });
    del.addEventListener('click', () => this.removeTrack(track));
    body.append(el('div', { className: 'row-actions' }, del));
  }

  paramControl(track, p) {
    const field = el('label', { className: 'field' });
    const title = el('span', { textContent: p.label });
    field.append(title);
    const apply = (value) => {
      if (!this.paramEditing) { this.checkpoint(); this.paramEditing = true; }
      track.params[p.id] = value;
      this.roll.invalidate();
      this.renderNoteInfo();
    };
    const done = () => { this.paramEditing = false; this.dropCheckpointIfUnchanged(); this.scheduleAutosave(); };
    if (p.type === 'select') {
      const sel = el('select');
      for (const o of p.options) sel.append(el('option', { value: String(o.value), textContent: o.label }));
      sel.value = String(track.params[p.id]);
      sel.addEventListener('change', () => {
        const opt = p.options.find((o) => String(o.value) === sel.value);
        apply(opt.value);
        done();
      });
      field.append(sel);
    } else {
      const out = el('output', { textContent: this.formatParam(p, track.params[p.id]) });
      title.append(' ', out);
      const range = el('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: track.params[p.id] });
      range.addEventListener('input', () => {
        apply(Number(range.value));
        out.textContent = this.formatParam(p, Number(range.value));
      });
      range.addEventListener('change', done);
      field.append(range);
    }
    return field;
  }

  formatParam(p, v) {
    if (p.unit) return `${v > 0 && p.min < 0 ? '+' : ''}${v} ${p.unit}`;
    return p.max <= 1 ? `${Math.round(v * 100)}%` : String(v);
  }

  renderNoteInfo() {
    const box = $('noteInfo');
    const sel = this.selectedNotes();
    box.replaceChildren(el('div', { className: 'panel-head' }, el('h2', { textContent: '選択中の音符' })));
    if (!sel.length) {
      box.append(el('p', { className: 'hint', textContent: 'グリッドをクリックで音符を追加、音符をクリックで選択します。Shift+ドラッグで範囲選択。' }));
      return;
    }
    const rows = new Map(this.roll.rows.map((r) => [r.pitch, r]));
    const bar = ticksPerBar(this.song);
    const fmtPos = (tick) => `${Math.floor(tick / bar) + 1}小節 ${Math.floor((tick % bar) / TPB) + 1}拍目${tick % TPB ? ` +${tick % TPB}` : ''}`;
    const body = el('div', { className: 'settings' });
    if (sel.length === 1) {
      const n = sel[0];
      const r = rows.get(n.pitch);
      body.append(
        el('div', { className: 'kv' }, el('span', { textContent: '音' }), el('b', { textContent: r ? `${r.label}（${r.sub}）` : String(n.pitch) })),
        el('div', { className: 'kv' }, el('span', { textContent: '位置' }), el('b', { textContent: fmtPos(n.tick) })),
        el('div', { className: 'kv' }, el('span', { textContent: '長さ' }), el('b', { textContent: `${+(n.len / TPB).toFixed(3)}拍（${ticksToSeconds(this.song, n.len).toFixed(2)}秒）` })),
      );
    } else {
      body.append(el('div', { className: 'kv' }, el('span', { textContent: '個数' }), el('b', { textContent: `${sel.length}個` })));
    }
    const avg = sel.reduce((s, n) => s + n.vel, 0) / sel.length;
    const out = el('output', { textContent: `${Math.round(avg * 100)}%` });
    const vel = el('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: avg });
    vel.addEventListener('pointerdown', () => this.checkpoint());
    vel.addEventListener('input', () => {
      sel.forEach((n) => { n.vel = Number(vel.value); });
      out.textContent = `${Math.round(vel.value * 100)}%`;
      this.roll.invalidate();
    });
    vel.addEventListener('change', () => { this.dropCheckpointIfUnchanged(); this.scheduleAutosave(); });
    body.append(el('label', { className: 'field' }, el('span', {}, '強さ ', out), vel));
    const del = el('button', { className: 'danger', textContent: '削除' });
    del.addEventListener('click', () => this.deleteSelection());
    body.append(el('div', { className: 'row-actions' }, del));
    box.append(body);
  }

  updateTransport() {
    const playing = this.engine.playing;
    $('btnPlay').textContent = playing ? '■' : '▶';
    $('btnPlay').classList.toggle('on', playing);
    $('btnLoop').classList.toggle('on', this.song.loop.enabled);
    this.updatePosition();
  }

  updatePosition() {
    const tick = Math.max(0, this.currentTick());
    const bar = ticksPerBar(this.song);
    const sec = ticksToSeconds(this.song, tick);
    $('pos').textContent = `${Math.floor(tick / bar) + 1} : ${Math.floor((tick % bar) / TPB) + 1}`;
    $('time').textContent = `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
  }

  setStatus(text, kind = 'info') {
    const s = $('status');
    s.textContent = text;
    s.dataset.kind = kind;
  }

  pickFile(accept, handler) {
    const input = el('input', { type: 'file', accept });
    input.addEventListener('change', () => { if (input.files[0]) handler(input.files[0]); });
    input.click();
  }

  // ---- UI wiring ----------------------------------------------------------
  bindUI() {
    const add = $('addTrack');
    for (const def of listInstruments()) add.append(el('option', { value: def.id, textContent: `${def.name}トラック` }));
    add.addEventListener('change', () => {
      const v = add.value;
      add.value = '';
      if (v) this.addInstrumentTrack(v);
    });

    const snap = $('snap');
    for (const [ticks, label] of SNAPS) snap.append(el('option', { value: ticks, textContent: label }));
    snap.value = String(this.roll.snap);
    snap.addEventListener('change', () => { this.roll.snap = Number(snap.value); this.roll.invalidate(); });

    $('title').addEventListener('change', (e) => { this.checkpoint(); this.song.title = e.target.value; this.scheduleAutosave(); });
    $('bpm').addEventListener('change', (e) => {
      const v = Math.min(300, Math.max(30, Number(e.target.value) || this.song.bpm));
      this.checkpoint();
      this.song.bpm = Math.round(v * 10) / 10;
      e.target.value = this.song.bpm;
      this.restartIfPlaying();
      this.roll.invalidate();
      this.renderNoteInfo();
      this.scheduleAutosave();
    });
    $('beats').addEventListener('change', (e) => { this.checkpoint(); this.song.beatsPerBar = Number(e.target.value); this.roll.invalidate(); this.scheduleAutosave(); });
    $('reverb').addEventListener('input', (e) => { this.song.reverb = Number(e.target.value); this.engine.setReverb(this.song.reverb); });
    $('reverb').addEventListener('change', () => this.scheduleAutosave());
    $('follow').addEventListener('change', (e) => { this.roll.follow = e.target.checked; });

    $('btnPlay').addEventListener('click', () => this.togglePlay());
    $('btnToStart').addEventListener('click', () => this.seek(this.song.loop.enabled ? this.song.loop.start : 0));
    $('btnLoop').addEventListener('click', () => this.toggleLoop());
    $('zoomIn').addEventListener('click', () => this.roll.setZoom(this.roll.pxPerBeat * 1.25));
    $('zoomOut').addEventListener('click', () => this.roll.setZoom(this.roll.pxPerBeat / 1.25));

    $('btnNew').addEventListener('click', () => {
      if (!confirm('現在の曲を閉じて新しい曲を作りますか？（現在の曲は「保存」で書き出せます）')) return;
      this.setSong(createEmptySong(), { resetView: true });
      this.scheduleAutosave();
      this.setStatus('新しい曲を作りました');
    });
    $('btnOpen').addEventListener('click', () => this.pickFile('.json,application/json', (f) => this.openJson(f)));
    $('btnSave').addEventListener('click', () => this.saveJson());
    $('btnImportAudio').addEventListener('click', () => this.pickFile('audio/*', (f) => this.transcribeFile(f)));
    $('btnExport').addEventListener('click', () => this.exportWav());
    $('btnDefault').addEventListener('click', async () => {
      if (!confirm('デフォルト曲（録音した篠笛の曲）を開きますか？ 現在の曲は閉じます。')) return;
      this.setSong(await this.fetchDefault(), { resetView: true });
      this.scheduleAutosave();
      this.setStatus('デフォルト曲を開きました');
    });
    $('btnHelp').addEventListener('click', () => $('help').showModal());

    const toolbar = {
      tbUndo: () => this.undo(),
      tbRedo: () => this.redo(),
      tbUp: () => this.transposeSelection(1),
      tbDown: () => this.transposeSelection(-1),
      tbLeft: () => this.shiftSelection(-this.roll.snap),
      tbRight: () => this.shiftSelection(this.roll.snap),
      tbShorter: () => this.resizeSelection(-this.roll.snap),
      tbLonger: () => this.resizeSelection(this.roll.snap),
      tbDup: () => this.duplicateSelection(),
      tbDelete: () => this.deleteSelection(),
    };
    for (const [id, fn] of Object.entries(toolbar)) $(id).addEventListener('click', fn);

    $('btnMenu').addEventListener('click', () => this.setMenu(!$('fileActions').classList.contains('open')));
    $('fileActions').addEventListener('click', (e) => { if (e.target.closest('button')) this.setMenu(false); });
    document.addEventListener('pointerdown', (e) => {
      if (!$('fileActions').classList.contains('open') || e.target.closest('#fileActions, #btnMenu')) return;
      this.setMenu(false);
      if (e.target.closest('.editor')) e.stopPropagation();
    }, true);
    $('btnMore').addEventListener('click', () => {
      const open = $('transportMore').classList.toggle('open');
      $('btnMore').setAttribute('aria-expanded', String(open));
    });
    $('btnPanel').addEventListener('click', () => this.setDrawer(true));
    $('btnPanelClose').addEventListener('click', () => this.setDrawer(false));
    $('drawerBackdrop').addEventListener('click', () => this.setDrawer(false));

    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  setMenu(open) {
    $('fileActions').classList.toggle('open', open);
    $('btnMenu').setAttribute('aria-expanded', String(open));
  }

  setDrawer(open) {
    $('sidebar').classList.toggle('open', open);
    $('drawerBackdrop').hidden = !open;
    $('btnPanel').setAttribute('aria-expanded', String(open));
  }

  toggleLoop() {
    const loop = this.song.loop;
    if (!loop.enabled && loop.end <= loop.start) loop.end = loop.start + ticksPerBar(this.song) * 4;
    this.setLoop(loop.start, loop.end, !loop.enabled);
  }

  onKey(e) {
    const t = e.target;
    if (t.closest?.('dialog')) return;
    if (e.key === 'Escape' && ($('sidebar').classList.contains('open') || $('fileActions').classList.contains('open'))) {
      this.setDrawer(false);
      this.setMenu(false);
      return;
    }
    const typing = (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); };
    if (e.code === 'Space') { handled(); t.blur?.(); this.togglePlay(); return; }
    if (mod && key === 'z') { handled(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && key === 'y') { handled(); this.redo(); return; }
    if (mod && key === 'a') { handled(); this.selectAll(); return; }
    if (mod && key === 'c') { handled(); this.copySelection(); return; }
    if (mod && key === 'x') { handled(); this.copySelection(true); return; }
    if (mod && key === 'v') { handled(); this.paste(); return; }
    if (mod && key === 'd') { handled(); this.duplicateSelection(); return; }
    if (mod) return;
    switch (e.key) {
      case 'Delete': case 'Backspace': handled(); this.deleteSelection(); break;
      case 'ArrowUp': handled(); this.transposeSelection(e.shiftKey ? 12 : 1); break;
      case 'ArrowDown': handled(); this.transposeSelection(e.shiftKey ? -12 : -1); break;
      case 'ArrowLeft': handled(); this.shiftSelection(-this.roll.snap); break;
      case 'ArrowRight': handled(); this.shiftSelection(this.roll.snap); break;
      case 'Home': case 'Enter': handled(); this.seek(0); break;
      case 'Escape': this.roll.selection.clear(); this.selectionChanged(); break;
      default:
        if (key === 'l') this.toggleLoop();
        else if (key === 'q') this.quantize();
    }
  }
}

const app = new App();
window.awaApp = app;
app.init();
