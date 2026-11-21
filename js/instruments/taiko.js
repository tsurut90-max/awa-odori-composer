import { registerInstrument } from './registry.js';

// Row ids are stored in note.pitch; they only need to be unique within this instrument.
const STROKES = [
  { pitch: 4, label: 'テン', sub: '締太鼓', voice: 'shime', level: 1 },
  { pitch: 3, label: 'ツ', sub: '締太鼓（弱）', voice: 'shime', level: 0.45 },
  { pitch: 2, label: 'カッ', sub: '大太鼓（縁）', voice: 'rim', level: 1 },
  { pitch: 1, label: 'ドン', sub: '大太鼓', voice: 'odaiko', level: 1 },
];
const BY_PITCH = new Map(STROKES.map((s) => [s.pitch, s]));

const noiseBuffers = new WeakMap();
function noiseFor(ctx) {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

function tone(ctx, out, { type = 'sine', from, to, glide, when, peak, decay }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(to, when + glide);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.004);
  g.gain.setTargetAtTime(0, when + 0.004, decay / 4);
  osc.connect(g).connect(out);
  osc.start(when);
  osc.stop(when + decay * 1.5 + 0.05);
  return osc;
}

function burst(ctx, out, { when, peak, decay, filter, freq, q = 1 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseFor(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.setTargetAtTime(0, when, decay / 4);
  src.connect(f).connect(g).connect(out);
  src.start(when, Math.random() * 0.5);
  src.stop(when + decay * 1.5 + 0.05);
  return src;
}

function play({ ctx, destination, pitch, velocity, when, params }) {
  const stroke = BY_PITCH.get(pitch);
  const out = ctx.createGain();
  out.connect(destination);
  if (!stroke) return { stop() {} };
  const v = (0.25 + 0.75 * velocity) * stroke.level;
  const ring = params.ring;
  const sources = [];

  if (stroke.voice === 'odaiko') {
    const f = params.odaikoPitch;
    sources.push(
      tone(ctx, out, { from: f * 1.9, to: f, glide: 0.07, when, peak: 0.9 * v, decay: 0.35 + 1.1 * ring }),
      tone(ctx, out, { from: f * 3.2, to: f * 1.6, glide: 0.05, when, peak: 0.25 * v, decay: 0.18 + 0.3 * ring }),
      burst(ctx, out, { when, peak: 0.35 * v, decay: 0.05, filter: 'lowpass', freq: 900 }),
    );
  } else if (stroke.voice === 'rim') {
    sources.push(
      tone(ctx, out, { type: 'triangle', from: 1250, to: 950, glide: 0.02, when, peak: 0.35 * v, decay: 0.05 }),
      burst(ctx, out, { when, peak: 0.45 * v, decay: 0.035, filter: 'bandpass', freq: 2600, q: 1.5 }),
    );
  } else {
    const f = params.shimePitch;
    sources.push(
      tone(ctx, out, { type: 'triangle', from: f * 1.25, to: f, glide: 0.025, when, peak: 0.45 * v, decay: 0.08 + 0.17 * ring }),
      tone(ctx, out, { from: f * 2.3, to: f * 2.1, glide: 0.02, when, peak: 0.12 * v, decay: 0.06 }),
      burst(ctx, out, { when, peak: 0.4 * v, decay: 0.03, filter: 'highpass', freq: 3000 }),
    );
  }

  return {
    stop(at) {
      out.gain.cancelScheduledValues(at);
      out.gain.setValueAtTime(out.gain.value, at);
      out.gain.linearRampToValueAtTime(0, at + 0.03);
      for (const s of sources) { try { s.stop(at + 0.05); } catch { /* already ended */ } }
    },
  };
}

registerInstrument({
  id: 'taiko',
  name: '太鼓',
  color: '#d9a441',
  kind: 'percussion',
  defaultLength: 120,
  rowHeight: 40,
  params: [
    { id: 'odaikoPitch', label: '大太鼓の音の高さ', type: 'range', min: 40, max: 110, step: 1, default: 62, unit: 'Hz' },
    { id: 'shimePitch', label: '締太鼓の音の高さ', type: 'range', min: 250, max: 700, step: 5, default: 420, unit: 'Hz' },
    { id: 'ring', label: '響きの長さ', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  rows: () => STROKES.map(({ pitch, label, sub }) => ({ pitch, label, sub, inScale: true, accent: false })),
  play,
});
