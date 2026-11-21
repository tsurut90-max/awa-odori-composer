import { TPB } from '../core/song.js';

const TARGET_RATE = 22050;

export async function decodeAudio(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(arrayBuffer);
}

export function toMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

function downsample(data, rate) {
  const factor = Math.max(1, Math.round(rate / TARGET_RATE));
  if (factor === 1) return { data, rate };
  const n = Math.floor(data.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += data[i * factor + k];
    out[i] = s / factor;
  }
  return { data: out, rate: rate / factor };
}

// YIN (de Cheveigné & Kawahara, 2002) restricted to the shinobue range.
export function detectPitch(input, inputRate, { fmin = 380, fmax = 3200, hopSec = 0.0058 } = {}) {
  const { data, rate } = downsample(input, inputRate);
  const W = 512;
  const hop = Math.max(1, Math.round(hopSec * rate));
  const tauMin = Math.max(2, Math.floor(rate / fmax));
  const tauMax = Math.ceil(rate / fmin);
  const d = new Float32Array(tauMax + 2);
  const frames = [];
  for (let start = 0; start + W + tauMax + 1 < data.length; start += hop) {
    let energy = 0;
    for (let j = 0; j < W; j++) energy += data[start + j] * data[start + j];
    const rms = Math.sqrt(energy / W);
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = data[start + j] - data[start + j + tau];
        s += diff * diff;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    // A strict threshold keeps a strong 2nd harmonic of 呂 notes from being read as 甲.
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < 0.06) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let min = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < min) min = d[tau];
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (d[tau] <= min + 0.05 && d[tau] <= d[tau - 1] && d[tau] <= d[tau + 1]) { best = tau; break; }
      }
    }
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const tau = best + Math.max(-1, Math.min(1, shift));
    frames.push({ t: (start + W / 2) / rate, f0: rate / tau, aperiodicity: b, rms });
  }
  return frames;
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function percentile(values, p) {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export function segmentNotes(frames, { minNoteSec = 0.045, maxAperiodicity = 0.3, floorDb = 32 } = {}) {
  const hop = frames.length > 1 ? frames[1].t - frames[0].t : 0.0058;
  const refRms = percentile(frames.map((f) => f.rms), 0.95) || 1e-9;
  const gate = refRms * 10 ** (-floorDb / 20);
  const voiced = frames.map((f) => f.rms > gate && f.aperiodicity < maxAperiodicity);
  const midi = frames.map((f) => 69 + 12 * Math.log2(f.f0 / 440));

  // Global tuning offset: circular mean of the deviation from equal temperament.
  let sx = 0, sy = 0;
  frames.forEach((f, i) => {
    if (!voiced[i]) return;
    const ang = 2 * Math.PI * (midi[i] - Math.round(midi[i]));
    sx += Math.cos(ang) * f.rms;
    sy += Math.sin(ang) * f.rms;
  });
  const tuneCents = Math.round((Math.atan2(sy, sx) / (2 * Math.PI)) * 100);

  const raw = midi.map((m, i) => (voiced[i] ? Math.round(m - tuneCents / 100) : null));
  const semis = raw.map((v, i) => {
    if (v === null) return null;
    const win = [];
    for (let k = i - 2; k <= i + 2; k++) if (raw[k] != null) win.push(raw[k]);
    return median(win);
  });

  const runs = [];
  for (let i = 0; i < semis.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.pitch === semis[i]) last.end = i;
    else runs.push({ pitch: semis[i], start: i, end: i });
  }

  // Bridge tiny unvoiced dropouts inside a sustained note.
  const merged = [];
  for (let i = 0; i < runs.length; i++) {
    const r = { ...runs[i] };
    const prev = merged[merged.length - 1];
    if (r.pitch === null && prev && runs[i + 1] && runs[i + 1].pitch === prev.pitch && r.end - r.start < 2) {
      prev.end = runs[i + 1].end;
      i++;
      continue;
    }
    if (prev && prev.pitch !== null && prev.pitch === r.pitch) { prev.end = r.end; continue; }
    merged.push(r);
  }

  const minFrames = Math.ceil(minNoteSec / hop);
  const notes = [];
  for (const r of merged) {
    if (r.pitch === null || r.end - r.start + 1 < minFrames) continue;
    let peak = 0;
    for (let i = r.start; i <= r.end; i++) peak = Math.max(peak, frames[i].rms);
    const db = 20 * Math.log10(peak / refRms);
    const dur = (r.end - r.start + 1) * hop;
    if (db < -20 && dur < 0.15) continue;
    notes.push({
      start: frames[r.start].t - hop / 2,
      end: frames[r.end].t + hop / 2,
      pitch: r.pitch,
      vel: Math.max(0.35, Math.min(1, 1 + db / 30)),
    });
  }
  return { notes, tuneCents };
}

export function estimateTempo(notes, { minBpm = 70, maxBpm = 200, preferBpm = 130 } = {}) {
  if (notes.length < 4) return { bpm: 120, beatTime: notes[0]?.start ?? 0 };
  const sigma = 0.025;
  const score = (bpm, phase, onsets) => {
    const spb = 60 / bpm;
    let s = 0;
    for (const o of onsets) {
      const x = (o.t - phase) / spb;
      const dBeat = (x - Math.round(x)) * spb;
      const dHalf = (x * 2 - Math.round(x * 2)) * (spb / 2);
      s += o.w * (Math.exp(-(dBeat * dBeat) / (2 * sigma * sigma)) + 0.4 * Math.exp(-(dHalf * dHalf) / (2 * sigma * sigma)));
    }
    return s;
  };
  const onsets = notes.map((n) => ({ t: n.start, w: n.vel }));

  let best = { s: -Infinity, bpm: 120, phase: 0 };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const spb = 60 / bpm;
    const prior = Math.exp(-(Math.log2(bpm / preferBpm) ** 2) / (2 * 0.4 * 0.4));
    for (let phase = 0; phase < spb; phase += 0.01) {
      const s = score(bpm, phase, onsets) * prior;
      if (s > best.s) best = { s, bpm, phase };
    }
  }
  let fine = best;
  for (let bpm = best.bpm - 0.6; bpm <= best.bpm + 0.6; bpm += 0.05) {
    const spb = 60 / bpm;
    for (let phase = best.phase - 0.02; phase <= best.phase + 0.02; phase += 0.002) {
      const s = score(bpm, ((phase % spb) + spb) % spb, onsets);
      if (s > fine.s || fine === best) fine = { s, bpm, phase: ((phase % spb) + spb) % spb };
    }
  }
  return { bpm: Math.round(fine.bpm * 10) / 10, beatTime: fine.phase };
}

export function pickChoshi(notes, keyOfChoshi) {
  const major = [0, 2, 4, 5, 7, 9, 11];
  let best = { choshi: 6, score: -Infinity };
  for (let c = 1; c <= 12; c++) {
    const tonic = keyOfChoshi(c);
    let s = 0;
    for (const n of notes) {
      const pc = (((n.pitch - tonic) % 12) + 12) % 12;
      s += (major.includes(pc) ? 1 : -1) * (n.end - n.start);
    }
    if (s > best.score + 1e-6) best = { choshi: c, score: s };
  }
  return best.choshi;
}

export function transcribe(buffer, { beatsPerBar = 2, quantizeTicks = TPB / 24 } = {}) {
  const frames = detectPitch(toMono(buffer), buffer.sampleRate);
  const { notes, tuneCents } = segmentNotes(frames);
  const { bpm, beatTime } = estimateTempo(notes);
  const spb = 60 / bpm;
  const first = notes[0]?.start ?? 0;
  const barSec = spb * beatsPerBar;
  let t0 = beatTime + Math.floor((first - beatTime) / barSec) * barSec;
  if (first - t0 < 0.02) t0 -= barSec;

  const q = (sec) => Math.round(((sec - t0) / spb) * TPB / quantizeTicks) * quantizeTicks;
  const out = notes.map((n) => {
    const tick = q(n.start);
    return { tick, len: Math.max(quantizeTicks, q(n.end) - tick), pitch: n.pitch, vel: Math.round(n.vel * 100) / 100 };
  });
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].tick + out[i].len > out[i + 1].tick) out[i].len = Math.max(quantizeTicks, out[i + 1].tick - out[i].tick);
  }
  return { bpm, tuneCents, notes: out, rawNotes: notes };
}
