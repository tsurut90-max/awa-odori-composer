// Instrument contract (see shinobue.js for a complete example):
//   id, name, color, kind: 'melodic' | 'percussion'
//   params: [{ id, label, type: 'select'|'range', default, options?|min/max/step }]
//   rows(params) -> [{ pitch, label, sub?, inScale?, accent? }] ordered top to bottom
//   defaultLength: ticks for a newly drawn note
//   rowHeight?: pixel height of one editor row (default 18)
//   play({ ctx, destination, pitch, velocity, when, duration, params }) -> { stop(at) }
const instruments = new Map();

const REQUIRED = ['id', 'name', 'kind', 'params', 'rows', 'play'];

export function registerInstrument(def) {
  for (const key of REQUIRED) {
    if (def[key] === undefined) throw new Error(`楽器定義 "${def.id ?? '?'}" に ${key} がありません`);
  }
  instruments.set(def.id, Object.freeze({ color: '#e2553b', defaultLength: 240, ...def }));
}

export function getInstrument(id) {
  return instruments.get(id);
}

export function listInstruments() {
  return [...instruments.values()];
}

export function defaultParams(def) {
  return Object.fromEntries(def.params.map((p) => [p.id, p.default]));
}
