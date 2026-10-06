// A video's sound: a soft «tic» on every click, music underneath, and the
// narration on top, the music ducking while the voice speaks. The tics and
// the default music are made here, sample by sample: no file to license,
// nothing to download. The mix is ffmpeg's.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const RATE = 44_100;

/** Write 16-bit PCM WAV: one Float32Array per channel, samples in [-1, 1]. */
export function writeWav(file, channels) {
  const n = channels[0].length;
  const ch = channels.length;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(v * 32_767), (i * ch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * ch * 2, 28);
  header.writeUInt16LE(ch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/**
 * The tics: 30 ms at 2.4 kHz with a little air above, at each click. Heard
 * even when nobody is looking at the cursor.
 * @param {number[]} times seconds
 * @param {number} duration seconds
 */
export function ticks(times, duration) {
  const out = new Float32Array(Math.ceil(duration * RATE));
  const len = Math.round(0.03 * RATE);
  for (const t of times) {
    const start = Math.round(t * RATE);
    for (let i = 0; i < len && start + i < out.length; i += 1) {
      const s = i / RATE;
      const env = Math.min(1, s / 0.002) * Math.exp(-s / 0.007);
      out[start + i] += 0.24 * env * (Math.sin(2 * Math.PI * 2400 * s) + 0.3 * Math.sin(2 * Math.PI * 3600 * s));
    }
  }
  return [out, out];
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * The default music: C–G–Am–F at 88 beats a minute, a soft pad, a low root
 * and a quiet arpeggio. Something under the voice that does not ask to be
 * listened to.
 * @param {number} duration seconds
 */
export function music(duration) {
  const n = Math.ceil(duration * RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const beat = 60 / 88;
  const bar = 4 * beat;
  // Voicings that move as little as possible from one chord to the next.
  const chords = [
    { pad: [60, 64, 67], bass: 36 },
    { pad: [59, 62, 67], bass: 43 },
    { pad: [60, 64, 69], bass: 45 },
    { pad: [60, 65, 69], bass: 41 },
  ];
  const bars = Math.ceil(duration / bar) + 1;
  for (let b = 0; b < bars; b += 1) {
    const chord = chords[b % chords.length];
    const t0 = b * bar;
    // The pad: slow in, overlapping into the next bar, slightly apart in
    // each ear so it sounds wide.
    for (const note of chord.pad) {
      const f = hz(note);
      addNote(left, right, t0, bar + 1.4, (s, len) => {
        const env = Math.min(1, s / 0.9) * Math.min(1, Math.max(0, (len - s) / 1.4));
        return 0.055 * env;
      }, (s) => [voice(f - 0.4, s), voice(f + 0.4, s)]);
    }
    // The root, low and round.
    const fb = hz(chord.bass);
    addNote(left, right, t0, bar, (s, len) => 0.09 * Math.min(1, s / 0.04) * (0.55 + 0.45 * Math.exp(-s / 1.2)) * Math.min(1, (len - s) / 0.3), (s) => {
      const v = Math.sin(2 * Math.PI * fb * s) + 0.15 * Math.sin(4 * Math.PI * fb * s);
      return [v, v];
    });
    // The arpeggio: eighth notes over the chord, an octave up, plucked.
    const tones = [...chord.pad, chord.pad[0] + 12].map((m) => m + 12);
    const pattern = [0, 1, 2, 3, 2, 1, 2, 1];
    for (let i = 0; i < 8; i += 1) {
      const f = hz(tones[pattern[i]]);
      const pan = i % 2 ? 0.75 : 1;
      addNote(left, right, t0 + (i * beat) / 2, 1.2, (s) => 0.035 * Math.min(1, s / 0.004) * Math.exp(-s / 0.32), (s) => {
        const v = Math.sin(2 * Math.PI * f * s) + 0.2 * Math.sin(4 * Math.PI * f * s);
        return [v * pan, v * (1.75 - pan)];
      });
    }
  }
  // In over 2 s, out over 3 s.
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const g = Math.min(1, t / 2) * Math.min(1, Math.max(0, (duration - t) / 3));
    left[i] *= g;
    right[i] *= g;
  }
  return [left, right];
}

function voice(f, s) {
  return Math.sin(2 * Math.PI * f * s) + 0.22 * Math.sin(4 * Math.PI * f * s) + 0.06 * Math.sin(6 * Math.PI * f * s);
}

function addNote(left, right, start, len, envelope, wave) {
  const i0 = Math.round(start * RATE);
  const count = Math.round(len * RATE);
  for (let i = 0; i < count; i += 1) {
    const k = i0 + i;
    if (k >= left.length) break;
    const s = i / RATE;
    const g = envelope(s, len);
    if (g <= 0) continue;
    const [l, r] = wave(s);
    left[k] += g * l;
    right[k] += g * r;
  }
}

/** How long a media file plays, in seconds, from ffmpeg's own report. */
export function mediaDuration(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${r.stderr}${r.stdout}`);
  if (!m) throw new Error(`Cannot read how long ${file} plays (is it audio?).`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Tracks added together as they are. amix divides each by how many there
// are, and `normalize=0`, which says not to, is ffmpeg 4.4's: 4.2 and 4.3
// refuse the word (ImageMagick still brings 4.2.3 to Windows). Every track
// here lasts the whole video, so the division is the same from start to
// end, and a volume after it takes it back.
const sum = (labels) => `${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:duration=longest,volume=${labels.length}`;

/**
 * ffmpeg's arguments for the sound of a video: the tics (a WAV made here),
 * the music (made here, or the project's file, looped and faded), and each
 * narration at its moment, the music ducking under it.
 * @param {{ duration: number, ticksWav: string, music: { file: string, loop: boolean } | null, musicVolume: number, voices: { file: string, at: number }[], out: string }} o
 */
export function mixArgs(o) {
  const D = o.duration.toFixed(3);
  const inputs = ['-i', o.ticksWav];
  const filters = [];
  const fmt = 'aformat=sample_rates=44100:channel_layouts=stereo';
  filters.push(`[0:a]${fmt},apad=whole_dur=${D},atrim=0:${D}[tics]`);
  let index = 1;
  let musicLabel = null;
  if (o.music) {
    if (o.music.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', o.music.file);
    const fades = o.music.loop ? `,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, o.duration - 3).toFixed(3)}:d=3` : '';
    filters.push(`[${index}:a]${fmt},apad=whole_dur=${D},atrim=0:${D},asetpts=N/SR/TB${fades},volume=${o.musicVolume.toFixed(3)}[music]`);
    musicLabel = 'music';
    index += 1;
  }
  const voiceLabels = [];
  for (const v of o.voices) {
    inputs.push('-i', v.file);
    const ms = Math.max(0, Math.round(v.at * 1000));
    // A delay for each of the two channels: `all=1` is ffmpeg 4.3's.
    filters.push(`[${index}:a]${fmt},adelay=delays=${ms}|${ms},apad=whole_dur=${D},atrim=0:${D}[v${voiceLabels.length}]`);
    voiceLabels.push(`v${voiceLabels.length}`);
    index += 1;
  }
  const finals = ['tics'];
  if (voiceLabels.length) {
    filters.push(`${sum(voiceLabels)},asplit=2[voice][key]`);
    if (musicLabel) {
      // The music steps back while somebody speaks, and comes back after.
      filters.push(`[${musicLabel}][key]sidechaincompress=threshold=0.015:ratio=8:attack=20:release=450[ducked]`);
      finals.push('ducked');
    } else {
      filters.push('[key]anullsink');
    }
    finals.push('voice');
  } else if (musicLabel) {
    finals.push(musicLabel);
  }
  filters.push(`${sum(finals)},alimiter=limit=0.95[out]`);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-t',
    D,
    '-c:a',
    'pcm_s16le',
    o.out,
  ];
}
