// A video from a capture: the plan (plan.mjs) says what each frame shows,
// Chromium draws it on the stage (stage.html), ffmpeg encodes the frames and
// mixes the sound (audio.mjs). The browser is the project's own Playwright
// Chromium, the one its runs use: nothing to install but ffmpeg.
//
// What it leaves in the capture's folder:
//   <suite>.mp4         1280×840 (720 of screens, 120 of subtitles), H.264
//                       and AAC, ready for a browser or a shared drive
//   <suite>-sheet.jpg   the contact sheet: each press just before it lands,
//                       each step's end; what to check before showing it
//   <suite>-poster.jpg  the finished cover, which is also the video's first
//                       frame: what a player shows before play
//   clips/              (--clips) each step of each person as it really
//                       played, without cursor or subtitles, and the
//                       pointer's path beside it as JSON: for an editor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { playwrightOf } from '../playwright.mjs';
import { mediaDuration, mixArgs, music, RATE, ticks, writeWav } from './audio.mjs';
import { BAND, buildPlan, frameAt, H, loadCapture, pageLoads, W } from './plan.mjs';
import { readScript, readSuite, scriptPath, stepParts, testIdOf } from './script.mjs';

const STAGE = fileURLToPath(new URL('./stage.html', import.meta.url));

const statuses = new Map();

/**
 * ffmpeg, as the config names it, when it answers; with what it lacks. It
 * mixes a few seconds of sound as a video's is mixed: its version alone says
 * too little (4.2.3 passed here, and then could not mix a video's sound).
 */
export function ffmpegStatus(config) {
  const bin = config.video.ffmpeg;
  if (!statuses.has(bin)) statuses.set(bin, status(bin));
  return statuses.get(bin);
}

function status(bin) {
  const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { ok: false, bin, detail: `not found (${bin}): install ffmpeg, or name it in the config's \`video.ffmpeg\`` };
  const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? '?';
  const enc = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  if (!/\blibx264\b/.test(enc)) return { ok: false, bin, detail: `${version}, without libx264: a full build of ffmpeg is needed` };
  const sound = soundFails(bin);
  if (sound) {
    return {
      ok: false,
      bin,
      detail: `${version}, which cannot mix a video's sound (${sound}): another ffmpeg is needed, a recent and full build (winget install ffmpeg, brew install ffmpeg, apt install ffmpeg), or one named in the config's \`video.ffmpeg\``,
    };
  }
  return { ok: true, bin, detail: `${version}, with libx264, and it mixed a test of a video's sound` };
}

/**
 * A video's sound in miniature, with every filter and option of the real
 * one: tics, a looped music faded in and out, two narrations (one channel
 * each, as a system voice writes them) with the music ducking under them,
 * then brought to a loudness. What went wrong, in ffmpeg's first words, or
 * null.
 */
function soundFails(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cockpit-ffmpeg-'));
  const file = (name) => path.join(dir, name);
  try {
    const D = 4;
    writeWav(file('tics.wav'), ticks([0.5, 2.5], D));
    writeWav(file('music.wav'), music(D));
    const voice = new Float32Array(RATE);
    for (let i = 0; i < voice.length; i += 1) voice[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    writeWav(file('voice.wav'), [voice]);
    run(
      bin,
      mixArgs({
        duration: D,
        ticksWav: file('tics.wav'),
        music: { file: file('music.wav'), loop: true },
        musicVolume: 0.3,
        voices: [
          { file: file('voice.wav'), at: 0.4 },
          { file: file('voice.wav'), at: 2 },
        ],
        out: file('sound.wav'),
      }),
      'mix the sound',
    );
    normalize(bin, file('sound.wav'), file('sound-normalized.wav'), -16);
    return null;
  } catch (e) {
    // «[Parsed_adelay_9 @ 0000…] Option 'all' not found»: the filter and
    // what it lacks, without the address.
    const lines = String(e instanceof Error ? e.message : e)
      .replace(/^ffmpeg failed to [^:]*: */, '')
      .split('\n')
      .map((l) => l.replace(/ @ [0-9a-fx]+\]/i, ']').trim())
      .filter(Boolean);
    return lines.slice(0, 2).join('; ') || 'no word why';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Bring a mix to `target` LUFS with ffmpeg's loudnorm (EBU R128), in two
 * passes: one to measure, one to apply, with a linear gain where the true
 * peak allows (the mix keeps its dynamics). Returns the measured loudness.
 */
function normalize(bin, input, output, target) {
  if (typeof target !== 'number' || !Number.isFinite(target) || target > -5 || target < -40) {
    throw new Error(`video.loudness is a loudness in LUFS (−16 is usual for the web), or null to leave the sound as mixed; not ${JSON.stringify(target)}.`);
  }
  // A true peak of −2 dBTP in the mix: the AAC encoding after it adds about
  // half a dB (measured −1.0 from a −1.5 mix), and the video should stay
  // under −1.
  const filter = `loudnorm=I=${target}:TP=-2:LRA=11`;
  const r = spawnSync(bin, ['-hide_banner', '-nostats', '-i', input, '-af', `${filter}:print_format=json`, '-f', 'null', '-'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const err = r.stderr ?? '';
  const from = err.lastIndexOf('{');
  let m = null;
  try {
    m = JSON.parse(err.slice(from, err.indexOf('}', from) + 1));
  } catch {
    // Said below.
  }
  if (r.status !== 0 || !m) throw new Error(`ffmpeg failed to measure the sound's loudness: ${err.trim().slice(-800)}`);
  run(
    bin,
    [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-af', `${filter}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      // loudnorm works at 192 kHz: back to the mix's own rate.
      '-ar', '44100', '-c:a', 'pcm_s16le', output,
    ],
    "set the sound's loudness",
  );
  return Number(m.input_i);
}

function run(bin, args, what) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed to ${what}: ${(r.stderr || r.error?.message || '').trim().slice(-1500)}`);
}

/**
 * @param {any} config resolved config
 * @param {string} dir the capture's folder
 * @param {{ script?: string | null, clips?: boolean, mode?: 'guide'|'motion', log?: (...a: any[]) => void }} [opts]
 */
export async function renderVideo(config, dir, opts = {}) {
  const log = opts.log ?? console.log;
  const ff = ffmpegStatus(config);
  if (!ff.ok) throw new Error(`ffmpeg: ${ff.detail}`);
  const capture = loadCapture(dir);
  const suiteName = capture.meta.suite;
  const scriptFile = opts.script ?? capture.meta.script ?? null;
  const script = readScript(scriptFile && fs.existsSync(scriptFile) ? scriptFile : null);
  const mode = opts.mode ?? capture.meta.mode ?? 'guide';
  const fps = mode === 'motion' ? 30 : 25;
  const suite = readSuite(config, suiteName);

  // The narration's audio, and how long each one speaks.
  const data = script.data;
  const voices = new Map();
  const want = (key, entry) => {
    if (!entry?.audio) return;
    const file = scriptPath(script, entry.audio);
    if (!fs.existsSync(file)) throw new Error(`The video script names ${entry.audio} for ${key}, and there is no such file (${file}).`);
    voices.set(key, { file, duration: mediaDuration(ff.bin, file) });
  };
  for (const [key, entry] of Object.entries(data.cards ?? {})) want(key, entry);
  for (const [key, entry] of Object.entries(data.steps ?? {})) want(key, entry);

  const plan = buildPlan({ config, capture, suite, script, mode, fps, voice: (key) => voices.get(key) ?? null });
  const frames = Math.ceil(plan.duration * fps);
  log(`Video of ${suiteName} (${mode}): ${plan.steps} steps, ${plan.clicks} presses, ${plan.duration.toFixed(1)} s, ${frames} frames.`);
  for (const line of plan.notes) log(line);
  // How long its pages took to show something: on a development server
  // (modules unbundled), what a video loses most, and what the skill tells
  // an agent to measure before filming («A page that loads slowly»).
  const loads = capture.sessions.flatMap((s) => pageLoads(s.paints ?? [])).sort((a, b) => a - b);
  if (loads.length) {
    const median = loads[Math.floor(loads.length / 2)];
    log(`Pages: ${loads.length} loaded, ${median} ms from their response to their first content (the slowest ${loads.at(-1)} ms).`);
    if (median > 300) log('  Over 300 ms is, most likely, the app in development mode, not the app: the skill says what to try.');
  }

  const work = path.join(dir, 'render');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'keys'), { recursive: true });
  const silent = path.join(work, 'picture.mp4');
  const out = path.join(dir, `${suiteName}.mp4`);
  const sheetFile = path.join(dir, `${suiteName}-sheet.jpg`);
  const posterFile = path.join(dir, `${suiteName}-poster.jpg`);

  const { chromium } = playwrightOf(config);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H + BAND }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(STAGE).href);
    await page.evaluate((theme) => window.setTheme(theme), { colors: config.video.colors, font: config.video.font });
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);

    // The frames go to ffmpeg as JPEGs (from the browser's sRGB, JPEG's
    // full-range BT.601) and come out as BT.709 video, tagged as such, so
    // the brand's colours are the brand's on any player.
    const encoder = spawn(
      ff.bin,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
        '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-r', String(fps),
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        silent,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    );
    let encoderError = '';
    encoder.stderr.on('data', (d) => (encoderError += d));
    const encoded = once(encoder, 'close');

    const keys = [...plan.keys].sort((a, b) => a.t - b.t);
    let nextKey = 0;
    const sheet = [];
    let lastState = '';
    let lastFrame = null;
    let lastReport = Date.now();
    for (let f = 0; f < frames; f += 1) {
      const t = f / fps;
      const state = plan.at(t);
      const json = JSON.stringify(state);
      if (json !== lastState) {
        await page.evaluate((s) => window.draw(s), state);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
        lastFrame = Buffer.from(shot.data, 'base64');
        lastState = json;
      }
      // The first frame is the finished cover (plan.mjs): a picture of its own too,
      // for a page's <video poster>, a README, a link's preview.
      if (f === 0) fs.writeFileSync(posterFile, lastFrame);
      // The contact sheet: the frame nearest each moment to check.
      while (nextKey < keys.length && keys[nextKey].t <= t + 0.5 / fps) {
        const file = path.join(work, 'keys', `${String(sheet.length).padStart(3, '0')}.jpg`);
        fs.writeFileSync(file, lastFrame);
        sheet.push({ src: pathToFileURL(file).href, caption: `${keys[nextKey].t.toFixed(1)} s · ${keys[nextKey].caption}` });
        nextKey += 1;
      }
      if (!encoder.stdin.write(lastFrame)) await once(encoder.stdin, 'drain');
      if (Date.now() - lastReport > 10_000) {
        lastReport = Date.now();
        log(`  ${Math.round((100 * f) / frames)}%`);
      }
    }
    encoder.stdin.end();
    const [code] = await encoded;
    if (code !== 0) throw new Error(`ffmpeg failed to encode the picture: ${encoderError.trim().slice(-1500)}`);

    // The sound, then picture and sound together.
    const ticksWav = path.join(work, 'tics.wav');
    writeWav(ticksWav, ticks(plan.ticks, plan.duration));
    const musicChoice = data.music !== undefined ? (data.music && data.music !== 'generated' ? scriptPath(script, data.music) : data.music) : config.video.music;
    // Which music plays, and from where, said every time: nobody can tell it
    // from the picture, and a script's `music` wins over the config's (one
    // written by 0.4.0's `video script` says "generated", which hid a
    // project's own track through three videos before anybody heard it).
    const source = data.music !== undefined ? "the script's music" : config.raw.video?.music !== undefined ? "the config's video.music" : 'the default (the config names no video.music)';
    log(`Music: ${musicChoice === 'generated' ? 'made by the package' : musicChoice ? path.basename(musicChoice) : 'none'}, from ${source}.`);
    if (data.music !== undefined && config.video.music && config.video.music !== 'generated' && musicChoice !== config.video.music) {
      log(`  It hides the config's video.music (${path.basename(config.video.music)}): leave "music" out of the script for that one.`);
    }
    let musicTrack = null;
    let level = 0;
    if (musicChoice === 'generated') {
      const file = path.join(work, 'music.wav');
      writeWav(file, music(plan.duration));
      musicTrack = { file, loop: false };
      level = plan.voices.length ? 0.45 : 0.8;
    } else if (musicChoice) {
      if (!fs.existsSync(musicChoice)) throw new Error(`No music file ${musicChoice}.`);
      musicTrack = { file: musicChoice, loop: true };
      // A finished track is mastered loud: well under the voice.
      level = plan.voices.length ? 0.22 : 0.4;
    }
    const mixed = path.join(work, 'sound.wav');
    run(
      ff.bin,
      mixArgs({
        duration: plan.duration,
        ticksWav,
        music: musicTrack,
        musicVolume: level * (data.musicVolume ?? 1),
        voices: plan.voices,
        out: mixed,
      }),
      'mix the sound',
    );
    // At a loudness nobody has to turn up or down: a narration came out at
    // −26 LUFS, the voice service's own level under its music.
    let sound = mixed;
    const target = config.video.loudness;
    if (target === null) {
      log('Sound: left as mixed (video.loudness is null).');
    } else if (!musicTrack && !plan.voices.length) {
      // Raised to −16 LUFS, a mix of tics alone would make every tic a shot.
      log('Sound: tics alone, left as mixed.');
    } else {
      sound = path.join(work, 'sound-normalized.wav');
      const measured = normalize(ff.bin, mixed, sound, target);
      log(`Sound: ${measured.toFixed(1)} LUFS, brought to ${target} LUFS (true peak −2 dBTP before the AAC encoding).`);
    }
    run(
      ff.bin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', sound, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out],
      'join picture and sound',
    );

    // The contact sheet.
    if (sheet.length) {
      await page.evaluate(({ items, columns }) => window.sheet(items, columns), { items: sheet, columns: 3 });
      await page.screenshot({ path: sheetFile, type: 'jpeg', quality: 85, fullPage: true });
    }
  } finally {
    await browser.close();
  }

  const clips = opts.clips ? writeClips(config, capture, ff.bin, data, log) : [];
  fs.rmSync(work, { recursive: true, force: true });
  return { out, sheet: sheetFile, poster: posterFile, duration: plan.duration, clicks: plan.clicks, steps: plan.steps, clips, mode };
}

/**
 * Each step of each person as it played, in real time, with nothing drawn
 * over it, at 60 fps; and beside each, the pointer's path: for an editor who
 * wants the real animations and a cursor of their own.
 */
function writeClips(config, capture, ffmpeg, data, log) {
  const dir = path.join(capture.dir, 'clips');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const wanted = Array.isArray(data.tests) && data.tests.length ? new Set(data.tests) : null;
  const made = [];
  for (const step of capture.steps) {
    const id = testIdOf(step.test);
    const parts = stepParts(step.title);
    if (!id || !parts || (wanted && !wanted.has(id)) || data.steps?.[`${id}/${parts.n}`]?.skip) continue;
    for (const person of step.people ?? []) {
      const s = capture.sessions.find((x) => x.id === person && x.started <= step.began && step.began <= x.ended);
      if (!s) continue;
      const first = frameAt(s, step.began);
      const inside = s.frames.filter((ms) => ms > step.began && ms <= step.ended);
      const list = [...(first ? [first.ms] : []), ...inside];
      if (!list.length) continue;
      const name = `${id}-${parts.n}-${person}`;
      const concat = path.join(dir, `${name}.txt`);
      const lines = ['ffconcat version 1.0'];
      list.forEach((ms, i) => {
        const from = Math.max(ms, step.began);
        const to = i + 1 < list.length ? list[i + 1] : step.ended;
        lines.push(`file '${path.join(s.framesDir, `${ms}.jpg`).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        lines.push(`duration ${Math.max(0.001, (to - from) / 1000).toFixed(3)}`);
      });
      // The concat demuxer forgets the last duration unless its file comes again.
      lines.push(`file '${path.join(s.framesDir, `${list.at(-1)}.jpg`).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      fs.writeFileSync(concat, `${lines.join('\n')}\n`);
      const file = path.join(dir, `${name}.mp4`);
      run(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat,
          '-t', ((step.ended - step.began) / 1000).toFixed(3),
          '-vf', 'fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p',
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
          '-movflags', '+faststart', file,
        ],
        `encode the clip ${name}`,
      );
      fs.rmSync(concat);
      const events = s.events
        .filter((e) => e.at >= step.began && e.at <= step.ended)
        .map((e) => ({ t: Number(((e.at - step.began) / 1000).toFixed(3)), kind: e.kind, x: e.x, y: e.y }));
      const cursor = {
        clip: path.basename(file),
        test: step.test,
        step: step.title,
        person,
        touch: Boolean(s.touch),
        viewport: s.viewport,
        duration: Number(((step.ended - step.began) / 1000).toFixed(3)),
        note: 'x, y in the clip\'s own pixels (CSS pixels of the page); t in seconds from the clip\'s start; kind: move (the pointer passing), click, type (the first keystroke in a field).',
        events,
      };
      fs.writeFileSync(path.join(dir, `${name}.cursor.json`), `${JSON.stringify(cursor, null, 2)}\n`);
      made.push(file);
    }
  }
  log(`Clips: ${made.length} in ${dir}`);
  return made;
}
