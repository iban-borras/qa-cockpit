// Before a publish (npm's prepublishOnly): every text file the package ships
// ends its lines with LF. npm packs the files as they are on disk, and a
// Windows working copy may hold CRLF where git holds LF: 0.1.0 shipped 21
// such files, and `init` wrote its templates into projects that way.
// The fix, from the repository's root: `git checkout-index -f -a`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { files } = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
const BINARY = /\.(png|jpe?g|webp|gif|ico|zip|woff2?|ttf)$/i;

const bad = [];
const walk = (abs) => {
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
  } else if (!BINARY.test(abs) && fs.readFileSync(abs).includes(13)) {
    bad.push(path.relative(PACKAGE, abs).split(path.sep).join('/'));
  }
};
for (const entry of [...files, 'package.json']) walk(path.join(PACKAGE, entry));

if (bad.length) {
  console.error(`CRLF in ${bad.length} file(s) the package would ship:\n  ${bad.join('\n  ')}`);
  console.error('From the repository root: git checkout-index -f -a');
  process.exit(1);
}
console.log('Line endings: LF everywhere.');
