import { getInstrument } from '../instruments/registry.js';
import { ticksToSeconds, secondsToTicks, isAudible, songEndTick } from './song.js';

const LOOKAHEAD = 0.15;
const INTERVAL_MS = 25;

function buildMaster(ctx, song) {
  const input = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  const out = ctx.createGain();
  out.gain.value = 0.9;

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 2.2, 3.2);
  input.connect(dry).connect(comp);
  input.connect(conv).connect(wet).connect(comp);
  comp.connect(out).connect(ctx.destination);
  const setReverb = (amount) => {
    dry.gain.value = 1 - amount * 0.35;
    wet.gain.value = amount * 0.9;
  };
  setReverb(song.reverb);
  return { input, setReverb };
}

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.playing = false;
    this.trackGains = new Map();
    this.voices = new Set();
    this.segments = [];
    this.timer = null;
    this.onStop = null;
  }

  ensureContext(song) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = buildMaster(this.ctx, song);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  endTick(song) {
    return songEndTick(song);
  }

  setReverb(amount) {
    this.master?.setReverb(amount);
  }

  updateMix(song) {
    for (const track of song.tracks) {
      const g = this.trackGains.get(track.id);
      if (g) g.gain.setTargetAtTime(isAudible(song, track) ? track.volume : 0, this.ctx.currentTime, 0.015);
    }
  }

  trackGain(song, track) {
    let g = this.trackGains.get(track.id);
    if (!g) {
      g = this.ctx.createGain();
      g.connect(this.master.input);
      this.trackGains.set(track.id, g);
    }
    g.gain.value = isAudible(song, track) ? track.volume : 0;
    return g;
  }

  preview(song, track, pitch, velocity = 0.8) {
    const def = getInstrument(track.instrument);
    if (!def) return;
    const ctx = this.ensureContext(song);
    const v = def.play({ ctx, destination: this.trackGain(song, track), pitch, velocity, when: ctx.currentTime + 0.01, duration: 0.35, params: track.params });
    this.voices.add(v);
    setTimeout(() => this.voices.delete(v), 1500);
  }

  play(song, fromTick) {
    this.stop();
    const ctx = this.ensureContext(song);
    this.song = song;
    this.playing = true;
    const startTime = ctx.currentTime + 0.06;
    this.cursorTick = fromTick;
    this.cursorTime = startTime;
    this.segments = [{ time: startTime, tick: fromTick }];
    this.endAt = null;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), INTERVAL_MS);
  }

  loopRange() {
    const { loop } = this.song;
    return loop.enabled && loop.end > loop.start ? loop : null;
  }

  schedule() {
    if (!this.playing) return;
    const song = this.song;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    const endTick = this.endTick(song);
    while (this.cursorTime < horizon) {
      const loop = this.loopRange();
      let toTick = this.cursorTick + secondsToTicks(song, horizon - this.cursorTime);
      const wraps = loop && this.cursorTick < loop.end && toTick >= loop.end;
      if (wraps) toTick = loop.end;
      this.scheduleNotes(this.cursorTick, toTick, this.cursorTime);
      this.cursorTime += ticksToSeconds(song, toTick - this.cursorTick);
      this.cursorTick = toTick;
      if (wraps) {
        this.cursorTick = loop.start;
        this.segments.push({ time: this.cursorTime, tick: loop.start });
      } else if (!loop && this.cursorTick >= endTick && this.endAt === null) {
        this.endAt = this.cursorTime;
      }
    }
    if (this.endAt !== null && this.ctx.currentTime > this.endAt + 0.3) {
      this.stop();
      this.onStop?.();
    }
  }

  scheduleNotes(fromTick, toTick, baseTime) {
    const song = this.song;
    for (const track of song.tracks) {
      const def = getInstrument(track.instrument);
      if (!def) continue;
      const dest = this.trackGain(song, track);
      for (const n of track.notes) {
        if (n.tick < fromTick || n.tick >= toTick) continue;
        const when = baseTime + ticksToSeconds(song, n.tick - fromTick);
        const v = def.play({ ctx: this.ctx, destination: dest, pitch: n.pitch, velocity: n.vel, when, duration: ticksToSeconds(song, n.len), params: track.params });
        this.voices.add(v);
        const ms = (when - this.ctx.currentTime + ticksToSeconds(song, n.len) + 1) * 1000;
        setTimeout(() => this.voices.delete(v), ms);
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) v.stop(now);
    this.voices.clear();
    this.playing = false;
  }

  positionTick() {
    if (!this.playing) return null;
    const now = this.ctx.currentTime;
    let seg = this.segments[0];
    for (const s of this.segments) if (s.time <= now) seg = s;
    if (now < seg.time) return seg.tick;
    return seg.tick + secondsToTicks(this.song, now - seg.time);
  }

  async renderOffline(song, sampleRate = 44100) {
    const seconds = ticksToSeconds(song, this.endTick(song)) + 2.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const master = buildMaster(ctx, song);
    for (const track of song.tracks) {
      if (!isAudible(song, track)) continue;
      const def = getInstrument(track.instrument);
      if (!def) continue;
      const gain = ctx.createGain();
      gain.gain.value = track.volume;
      gain.connect(master.input);
      for (const n of track.notes) {
        def.play({ ctx, destination: gain, pitch: n.pitch, velocity: n.vel, when: ticksToSeconds(song, n.tick), duration: ticksToSeconds(song, n.len), params: track.params });
      }
    }
    return ctx.startRendering();
  }
}

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const view = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + len * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, len * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
