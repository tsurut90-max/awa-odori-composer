import { registerInstrument } from './registry.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const KANSUJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const CHOSHI_KEY = ['', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B', 'C', 'D♭', 'D', 'E♭', 'E'];
const DEGREE = { 0: '1', 1: '1♯', 2: '2', 3: '2♯', 4: '3', 5: '4', 6: '4♯', 7: '5', 8: '5♯', 9: '6', 10: '6♯', 11: '7' };
const MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);
const OCTAVE_PREFIX = { '-1': '低', 0: '呂', 1: '甲', 2: '大甲' };

// 唄用(ドレミ調)篠笛: 八本調子の「呂の1」= C5。一本下がるごとに半音下がる。
export const choshiTonic = (choshi) => 64 + choshi;
export const noteName = (pitch) => `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;

export function numberLabel(pitch, choshi) {
  const rel = pitch - choshiTonic(choshi);
  if (rel === -5) return '筒音';
  const octave = Math.floor(rel / 12);
  return `${OCTAVE_PREFIX[octave] ?? ''}${DEGREE[((rel % 12) + 12) % 12]}`;
}

const resources = new WeakMap();
function getResources(ctx) {
  let r = resources.get(ctx);
  if (!r) {
    const real = new Float32Array([0, 1, 0.24, 0.1, 0.04, 0.015, 0.006]);
    const wave = ctx.createPeriodicWave(real, new Float32Array(real.length));
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    r = { wave, noise };
    resources.set(ctx, r);
  }
  return r;
}

function play({ ctx, destination, pitch, velocity, when, duration, params }) {
  const { wave, noise } = getResources(ctx);
  const f = 440 * 2 ** ((pitch - 69 + (params.tune || 0) / 100) / 12);
  const vel = 0.35 + 0.65 * velocity;
  const end = when + Math.max(0.03, duration);
  const release = 0.06;
  const tail = end + release * 6;
  const settle = Math.min(when + 0.03, end);

  const out = ctx.createGain();
  out.connect(destination);

  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.setValueAtTime(f * 2 ** (-(params.attackBend || 0) / 1200), when);
  osc.frequency.exponentialRampToValueAtTime(f, Math.min(when + 0.06, end));

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.min(16000, f * 5);

  const amp = ctx.createGain();
  const peak = 0.3 * vel;
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, Math.min(when + 0.016, end));
  amp.gain.setTargetAtTime(peak * 0.8, settle, 0.08);
  amp.gain.setTargetAtTime(0, end, release / 3);
  osc.connect(tone).connect(amp).connect(out);

  if (params.vibrato > 0 && duration > 0.28) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, when + 0.2);
    depth.gain.linearRampToValueAtTime(f * (2 ** (params.vibrato / 1200) - 1), when + Math.min(duration, 0.65));
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(when);
    lfo.stop(tail);
  }

  const breath = (params.breath ?? 0.35) * vel;
  const ns = ctx.createBufferSource();
  ns.buffer = noise;
  ns.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = f;
  band.Q.value = 5;
  const hiss = ctx.createBiquadFilter();
  hiss.type = 'highpass';
  hiss.frequency.value = 2500;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.18;
  // Breath is only a short puff at the attack; a sustained hiss sounds like background noise on earphones.
  const nAmp = ctx.createGain();
  nAmp.gain.setValueAtTime(0, when);
  nAmp.gain.linearRampToValueAtTime(0.55 * breath, when + 0.01);
  nAmp.gain.setTargetAtTime(0, when + 0.012, 0.035);
  ns.connect(band).connect(nAmp);
  ns.connect(hiss).connect(hissGain).connect(nAmp);
  nAmp.connect(out);

  osc.start(when);
  osc.stop(tail);
  ns.start(when, Math.random() * 1.5);
  ns.stop(Math.min(tail, when + 0.3));

  return {
    stop(at) {
      out.gain.cancelScheduledValues(at);
      out.gain.setValueAtTime(out.gain.value, at);
      out.gain.linearRampToValueAtTime(0, at + 0.03);
      try { osc.stop(at + 0.05); ns.stop(at + 0.05); } catch { /* already ended */ }
    },
  };
}

registerInstrument({
  id: 'shinobue',
  name: '篠笛',
  color: '#e2553b',
  kind: 'melodic',
  defaultLength: 240,
  params: [
    {
      id: 'choshi', label: '調子', type: 'select', default: 6,
      options: Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${KANSUJI[i + 1]}本調子（${CHOSHI_KEY[i + 1]}）` })),
    },
    { id: 'notation', label: '表記', type: 'select', default: 'number', options: [{ value: 'number', label: '数字譜（呂・甲）' }, { value: 'western', label: '音名（C4…）' }] },
    { id: 'tune', label: 'ピッチ微調整', type: 'range', min: -50, max: 50, step: 1, default: 0, unit: 'セント' },
    { id: 'breath', label: '息の音（吹き始め）', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35 },
    { id: 'vibrato', label: 'ビブラート', type: 'range', min: 0, max: 40, step: 1, default: 12, unit: 'セント' },
    { id: 'attackBend', label: '当たり（立ち上がりのしゃくり）', type: 'range', min: 0, max: 80, step: 1, default: 30, unit: 'セント' },
  ],
  rows(params) {
    const tonic = choshiTonic(Number(params.choshi));
    const rows = [];
    for (let p = tonic + 31; p >= tonic - 7; p--) {
      const rel = p - tonic;
      const pc = ((rel % 12) + 12) % 12;
      const number = numberLabel(p, Number(params.choshi));
      const western = noteName(p);
      rows.push({
        pitch: p,
        label: params.notation === 'western' ? western : number,
        sub: params.notation === 'western' ? number : western,
        inScale: MAJOR.has(pc),
        accent: pc === 0,
      });
    }
    return rows;
  },
  play,
});
