// Runs INSIDE the runner container, one process per compose command, so
// that compose.mjs can stay synchronous: it reads {args, input} on stdin,
// asks the host's bridge (runner.mjs) and prints the host's
// {status, stdout, stderr} as JSON.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const body = Buffer.concat(chunks).toString('utf8');

try {
  const r = await fetch(`${process.env.QA_BRIDGE_URL}/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Token': process.env.QA_BRIDGE_TOKEN ?? '' },
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) {
    process.stderr.write(`bridge answered ${r.status}: ${text}`);
    process.exit(1);
  }
  process.stdout.write(text);
} catch (e) {
  process.stderr.write(`bridge unreachable: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
