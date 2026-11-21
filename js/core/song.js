import { getInstrument, defaultParams } from '../instruments/registry.js';

export const TPB = 480;
export const SONG_VERSION = 1;

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createInstrumentTrack(instrumentId, overrides = {}) {
  const def = getInstrument(instrumentId);
  const { params, ...rest } = overrides;
  return {
    id: uid('trk'),
    type: 'instrument',
    instrument: instrumentId,
    name: def.name,
    volume: 0.8,
    mute: false,
    solo: false,
    notes: [],
    ...rest,
    params: { ...defaultParams(def), ...(params || {}) },
  };
}

export function createEmptySong() {
  return {
    version: SONG_VERSION,
    title: '新しい曲',
    bpm: 140,
    beatsPerBar: 2,
    reverb: 0.25,
    loop: { enabled: false, start: 0, end: TPB * 8 },
    tracks: [createInstrumentTrack('shinobue')],
  };
}

// Suffixes older versions of the tool added to titles and track names.
const LEGACY_LABELS = /（録音より）|（録音から採譜）/g;
const stripLegacy = (s) => String(s ?? '').replace(LEGACY_LABELS, '').trim();

export function normalizeSong(raw) {
  if (!raw || !Array.isArray(raw.tracks)) throw new Error('曲データの形式が正しくありません');
  const song = {
    version: SONG_VERSION,
    title: stripLegacy(raw.title) || '無題',
    bpm: clamp(Number(raw.bpm) || 140, 30, 300),
    beatsPerBar: clamp(Math.round(Number(raw.beatsPerBar) || 2), 1, 12),
    reverb: clamp(Number(raw.reverb ?? 0.25), 0, 1),
    loop: {
      enabled: !!raw.loop?.enabled,
      start: Math.max(0, Math.round(raw.loop?.start ?? 0)),
      end: Math.max(TPB, Math.round(raw.loop?.end ?? TPB * 8)),
    },
    tracks: [],
  };
  for (const t of raw.tracks) {
    if (t.type !== 'instrument') continue;
    const base = { id: t.id || uid('trk'), name: stripLegacy(t.name), volume: clamp(Number(t.volume ?? 0.8), 0, 1), mute: !!t.mute, solo: !!t.solo };
    const def = getInstrument(t.instrument);
    if (!def) {
      console.warn(`未登録の楽器のためスキップしました: ${t.instrument}`);
      continue;
    }
    song.tracks.push({
      ...base,
      type: 'instrument',
      instrument: def.id,
      name: base.name || def.name,
      params: { ...defaultParams(def), ...(t.params || {}) },
      notes: (t.notes || []).map((n) => ({
        tick: Math.max(0, Math.round(n.tick)),
        len: Math.max(1, Math.round(n.len)),
        pitch: Math.round(n.pitch),
        vel: clamp(Number(n.vel ?? 0.8), 0, 1),
      })).sort((a, b) => a.tick - b.tick),
    });
  }
  return song;
}

export function serializeSong(song) {
  return JSON.parse(JSON.stringify(song));
}

export const ticksToSeconds = (song, ticks) => (ticks / TPB) * (60 / song.bpm);
export const secondsToTicks = (song, sec) => (sec * song.bpm * TPB) / 60;
export const ticksPerBar = (song) => TPB * song.beatsPerBar;

export function songEndTick(song) {
  let end = 0;
  for (const t of song.tracks) for (const n of t.notes) end = Math.max(end, n.tick + n.len);
  const bar = ticksPerBar(song);
  return Math.max(bar * 4, Math.ceil(end / bar) * bar);
}

export function isAudible(song, track) {
  const anySolo = song.tracks.some((t) => t.solo);
  return !track.mute && (!anySolo || track.solo);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
