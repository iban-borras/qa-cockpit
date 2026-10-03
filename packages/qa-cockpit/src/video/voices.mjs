// The operating system's own voice, for a video's narration when no voice
// service is at hand (`qa-cockpit video voices`): Windows' System.Speech,
// macOS's `say`, espeak-ng on Linux. Offline and free, plainer than a
// studio voice: good for a draft, for the timing, for a video that stays
// inside. A better voice later is the same script with other files.
//
// The text never travels as a command-line argument: a shell may hand it
// over in another code page, and «ó» arrives broken. It goes in a UTF-8 file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The audio files this system's voice writes. */
export const AUDIO_EXT = process.platform === 'darwin' ? '.aiff' : '.wav';

const has = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  return !r.error && r.status === 0;
};

/** Which voice this system has: 'windows', 'say', 'espeak-ng', 'espeak', or null. */
export function systemSpeech() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return has('say', ['-v', '?']) ? 'say' : null;
  if (has('espeak-ng', ['--version'])) return 'espeak-ng';
  if (has('espeak', ['--version'])) return 'espeak';
  return null;
}

// System.Speech, from Windows PowerShell 5.1, which every Windows has. The
// job (the texts, where each goes, the voice wanted) comes in a UTF-8 file.
const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$job = [IO.File]::ReadAllText($env:QA_VOICE_JOB, [Text.Encoding]::UTF8) | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
if ($job.list) { foreach ($v in $voices) { $v.Name + [char]9 + $v.Culture.Name }; exit 0 }
$pick = $null
if ($job.voice) { $pick = $voices | Where-Object { $_.Name -eq $job.voice } | Select-Object -First 1 }
if (-not $pick -and $job.lang) { $pick = $voices | Where-Object { $_.Culture.Name -eq $job.lang } | Select-Object -First 1 }
if (-not $pick -and $job.lang) {
  $two = $job.lang.Split('-')[0]
  $pick = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $two } | Select-Object -First 1
}
if ($pick) { $s.SelectVoice($pick.Name) }
'VOICE' + [char]9 + $s.Voice.Name + [char]9 + $s.Voice.Culture.Name
foreach ($i in $job.items) {
  $s.SetOutputToWaveFile($i.out)
  $s.Speak([IO.File]::ReadAllText($i.textFile, [Text.Encoding]::UTF8))
}
$s.SetOutputToNull()
$s.Dispose()
`;

function powershell(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-voice-'));
  try {
    const items = (job.items ?? []).map((item, n) => {
      const textFile = path.join(dir, `${n}.txt`);
      fs.writeFileSync(textFile, item.text, 'utf8');
      return { out: item.out, textFile };
    });
    const jobFile = path.join(dir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, items }), 'utf8');
    // A file, not stdin: `-Command -` runs its input line by line, as if typed.
    const script = path.join(dir, 'speak.ps1');
    fs.writeFileSync(script, WINDOWS, 'ascii');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, QA_VOICE_JOB: jobFile },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`Windows' voice failed: ${(r.stderr || r.error?.message || '').trim().slice(-800)}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The voices this system has: { name, lang }. */
export function listVoices(kind = systemSpeech()) {
  if (kind === 'windows') {
    return powershell({ list: true }).map((l) => {
      const [name, lang] = l.split('\t');
      return { name, lang };
    });
  }
  if (kind === 'say') {
    const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';
    return out
      .split('\n')
      .map((l) => /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(l))
      .filter(Boolean)
      .map((m) => ({ name: m[1].trim(), lang: m[2].replace('_', '-') }));
  }
  if (kind === 'espeak-ng' || kind === 'espeak') {
    const out = spawnSync(kind, ['--voices'], { encoding: 'utf8' }).stdout ?? '';
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4)
      .map((c) => ({ name: c[3], lang: c[1] }));
  }
  return [];
}

/** The voice of a list for a language: the exact one, else one of its language. */
function choose(voices, lang) {
  if (!lang) return null;
  const want = lang.toLowerCase().replace('_', '-');
  return (
    voices.find((v) => v.lang.toLowerCase() === want) ??
    voices.find((v) => v.lang.toLowerCase().split('-')[0] === want.split('-')[0]) ??
    null
  );
}

/**
 * Speak each text into its file, with the voice named or one of the
 * language. Says which voice spoke.
 * @param {{ text: string, out: string }[]} items
 * @param {{ voice?: string | null, lang?: string | null }} opts
 * @returns {{ name: string, lang: string }}
 */
export function speakAll(items, { voice = null, lang = null } = {}) {
  const kind = systemSpeech();
  if (!kind) throw new Error('This system has no voice: Windows and macOS have one; on Linux, install espeak-ng.');
  for (const item of items) fs.mkdirSync(path.dirname(item.out), { recursive: true });
  if (kind === 'windows') {
    const said = powershell({ voice, lang, items }).find((l) => l.startsWith('VOICE\t'))?.split('\t') ?? [];
    return { name: said[1] ?? '?', lang: said[2] ?? '' };
  }
  const voices = listVoices(kind);
  const picked = (voice && voices.find((v) => v.name === voice)) || choose(voices, lang);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-voice-'));
  try {
    items.forEach((item, n) => {
      const textFile = path.join(dir, `${n}.txt`);
      fs.writeFileSync(textFile, item.text, 'utf8');
      const args =
        kind === 'say'
          ? [...(picked ? ['-v', picked.name] : []), '-o', item.out, '-f', textFile]
          : [...(picked ? ['-v', picked.lang] : []), '-f', textFile, '-w', item.out];
      const r = spawnSync(kind, args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${kind} failed: ${(r.stderr || r.error?.message || '').trim().slice(-500)}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return picked ?? { name: `${kind}'s default`, lang: '' };
}
