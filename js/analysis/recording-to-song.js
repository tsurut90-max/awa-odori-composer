import { transcribe, pickChoshi } from './transcriber.js';
import { choshiTonic } from '../instruments/shinobue.js';
import { SONG_VERSION, TPB, createInstrumentTrack } from '../core/song.js';

export function songFromRecording(buffer, { title }) {
  const result = transcribe(buffer, { beatsPerBar: 2 });
  const choshi = pickChoshi(result.rawNotes, choshiTonic);
  return {
    version: SONG_VERSION,
    title,
    bpm: result.bpm,
    beatsPerBar: 2,
    reverb: 0.2,
    loop: { enabled: false, start: 0, end: TPB * 2 * 8 },
    tracks: [
      createInstrumentTrack('shinobue', {
        params: { choshi, tune: result.tuneCents },
        notes: result.notes,
      }),
    ],
  };
}
