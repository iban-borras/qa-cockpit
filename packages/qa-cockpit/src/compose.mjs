// A stack started with docker compose, as a project of its own (`-p`), so it
// never touches the developer's own containers: its ports, its volumes, its
// database. Most web projects already have a compose file; this turns it
// into the `stack` of a QA Cockpit config:
//
//   stack: composeStack({
//     project: 'myapp-qa',
//     cwd: '../..',                        // where compose runs, relative to `base`
//     files: ['docker-compose.yml', 'qa/compose.qa.yml'],
//     app: { service: 'web', port: 3000 },
//     api: { service: 'api', port: 8000, health: '/health' },
//     base: import.meta.url,
//   })
//
// URLs are never configured: they are the host ports the project publishes,
// asked of compose itself. So nothing here can be pointed at another
// instance, let alone production.
import { execFile, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{
 *   project: string,
 *   files: string[],
 *   cwd?: string,
 *   base?: string,
 *   app: { service: string, port: number },
 *   api?: { service: string, port: number, health?: string } | null,
 * }} opts
 */
export function composeStack(opts) {
  const baseDir = opts.base ? path.dirname(fileURLToPath(opts.base)) : process.cwd();
  const cwd = path.resolve(baseDir, opts.cwd ?? '.');
  const files = opts.files.map((f) => path.resolve(cwd, f));
  const project = opts.project;
  const COMPOSE = ['compose', '-p', project, ...files.flatMap((f) => ['-f', f])];

  // Inside the runner container (--in-docker) there is no docker CLI and no
  // socket: handing a container the socket hands it the machine. The host
  // runs the compose commands instead, through a loopback bridge that knows
  // a per-run token (docker/runner.mjs); this is its client.
  const bridged = () => process.env.QA_BRIDGE_URL;

  /**
   * A compose command against the project: status and output.
   * @param {string[]} args
   * @param {{ input?: string, inherit?: boolean }} [o]
   */
  function raw(args, o = {}) {
    if (bridged()) {
      const r = spawnSync(process.execPath, [path.join(HERE, 'docker', 'bridge-call.mjs')], {
        input: JSON.stringify({ args, input: o.input ?? null }),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      if (r.status !== 0) return { status: 1, stdout: '', stderr: `bridge: ${r.stderr || r.stdout}` };
      return JSON.parse(r.stdout);
    }
    const r = spawnSync('docker', [...COMPOSE, ...args], {
      encoding: 'utf8',
      input: o.input,
      cwd,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      // A run the cockpit follows (QA_TEE) writes through this process, so
      // what compose says reaches the cockpit's log too.
      stdio: o.inherit && !process.env.QA_TEE ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    if (o.inherit && process.env.QA_TEE) {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /**
   * The same, returning stdout and throwing on failure unless `allowFail`.
   * @param {string[]} args
   * @param {{ input?: string, allowFail?: boolean, inherit?: boolean }} [o]
   */
  function run(args, o = {}) {
    const r = raw(args, o);
    if (r.status !== 0 && !o.allowFail) {
      throw new Error(`docker compose ${args.join(' ')} failed:\n${r.stderr || r.stdout || ''}`);
    }
    return r.stdout;
  }

  /** Without blocking, for the cockpit's server: stdout, or '' on any failure. */
  function runAsync(args) {
    return new Promise((resolve) => {
      execFile('docker', [...COMPOSE, ...args], { cwd, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
        resolve(err ? '' : stdout),
      );
    });
  }

  /** The host port a service publishes, or a clear refusal when the stack is down. */
  function hostPort(service, containerPort) {
    const out = run(['port', service, String(containerPort)], { allowFail: true }).trim();
    const m = /:(\d+)\s*$/.exec(out);
    if (!m) {
      throw new Error(`The stack "${project}" is not running (no published port for ${service}).`);
    }
    return Number(m[1]);
  }

  async function hostPortAsync(service, containerPort) {
    const m = /:(\d+)\s*$/.exec((await runAsync(['port', service, String(containerPort)])).trim());
    return m ? Number(m[1]) : null;
  }

  // The same URLs inside the runner container: it forwards localhost's
  // published ports to the services (Docker Desktop) or shares the host's
  // network (Linux), so the app's origins, its cookies and the saved sessions
  // are the host's own.
  function urls() {
    return {
      app: `http://localhost:${hostPort(opts.app.service, opts.app.port)}`,
      api: opts.api ? `http://localhost:${hostPort(opts.api.service, opts.api.port)}` : null,
    };
  }

  async function urlsAsync() {
    const [a, b] = await Promise.all([
      hostPortAsync(opts.app.service, opts.app.port),
      opts.api ? hostPortAsync(opts.api.service, opts.api.port) : Promise.resolve(null),
    ]);
    if (!a || (opts.api && !b)) return null;
    return { app: `http://localhost:${a}`, api: b ? `http://localhost:${b}` : null };
  }

  /** A service's log since an ISO timestamp, as one string. */
  function logsSince(service, sinceIso) {
    return run(['logs', '--no-log-prefix', '--since', sinceIso, service], { allowFail: true });
  }

  /** "3100=frontend:3000,8100=backend:8000,...": every TCP port the stack publishes. */
  function forwards() {
    const out = run(['ps', '--format', 'json']);
    const rows = out.trim().startsWith('[')
      ? JSON.parse(out)
      : out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const seen = new Map();
    for (const row of rows) {
      for (const p of row.Publishers ?? []) {
        if (p.PublishedPort && p.Protocol === 'tcp' && !seen.has(p.PublishedPort)) {
          seen.set(p.PublishedPort, `${p.PublishedPort}=${row.Service}:${p.TargetPort}`);
        }
      }
    }
    return [...seen.values()].join(',');
  }

  return {
    name: project,
    healthPath: opts.api?.health ?? null,
    urls,
    urlsAsync,
    async up() {
      run(['up', '-d'], { inherit: true });
    },
    async down() {
      run(['down'], { inherit: true });
    },
    async purge() {
      run(['down', '--volumes'], { inherit: true });
    },
    // For the docker runner and for the project's own helpers.
    compose: { project, cwd, files, raw, run, runAsync, hostPort, logsSince, forwards },
  };
}
