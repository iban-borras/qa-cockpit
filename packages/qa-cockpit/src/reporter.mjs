// Playwright reporter that tells the cockpit (server/server.mjs) what the
// run is doing: tests, the steps of the recordings, who acts in each, and
// each test's trace, as bytes. `playwrightConfig()` adds it, with the cast
// as its option, only when COCKPIT_URL is set. Events go in order through
// one queue, and the last ones are flushed before the run exits; a cockpit
// that is gone costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { peopleIn, peopleWords } from './worker.mjs';

const URL_BASE = process.env.COCKPIT_URL || '';
const RUN = process.env.COCKPIT_RUN || 'adhoc';

let queue = Promise.resolve();

function send(event) {
  const body = JSON.stringify({ ...event, run: RUN, time: new Date().toISOString() });
  queue = queue.then(() =>
    fetch(`${URL_BASE}/api/report-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {}),
  );
}

function stripAnsi(s) {
  return String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// The trace goes as bytes, not as a path: in a container it sits on the
// container's own disk, where the cockpit cannot read it.
function sendTrace(test, file) {
  queue = queue.then(async () => {
    try {
      await fetch(`${URL_BASE}/api/trace?run=${encodeURIComponent(RUN)}&test=${encodeURIComponent(test)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: fs.readFileSync(file),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      // No cockpit, no trace in it; the run goes on.
    }
  });
}

export default class CockpitReporter {
  /** @param {{ cast?: { id: string, name: string }[] }} [options] */
  constructor(options = {}) {
    this.people = peopleWords(options.cast ?? []);
  }

  onBegin(config, suite) {
    const tests = suite.allTests();
    const files = [...new Set(tests.map((t) => path.basename(t.location.file)))];
    send({ type: 'run:begin', files, totalTests: tests.length, tests: tests.map((t) => t.title) });
  }

  onTestBegin(test) {
    send({ type: 'test:begin', test: test.title, file: path.basename(test.location.file) });
  }

  onStepBegin(test, _result, step) {
    if (step.category !== 'test.step') return;
    send({ type: 'step:begin', test: test.title, step: step.title, actors: peopleIn(step.title, this.people) });
  }

  onStepEnd(test, _result, step) {
    if (step.category !== 'test.step') return;
    send({
      type: 'step:end',
      test: test.title,
      step: step.title,
      actors: peopleIn(step.title, this.people),
      duration: step.duration,
      error: step.error ? stripAnsi(step.error.message).slice(0, 4000) : null,
    });
  }

  onTestEnd(test, result) {
    const trace = result.attachments.find((a) => a.name === 'trace' && a.path);
    if (trace && fs.existsSync(trace.path)) sendTrace(test.title, trace.path);
    send({
      type: 'test:end',
      test: test.title,
      status: result.status,
      duration: result.duration,
      errors: result.errors.map((e) => stripAnsi(e.message || String(e)).slice(0, 4000)),
    });
  }

  async onEnd(result) {
    send({ type: 'run:end', status: result.status });
    await queue;
  }
}
