const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const rawTargets = process.argv.slice(2);
const targets = rawTargets.length > 0 ? rawTargets : ['dist', 'dist-electron'];

function removeTreeSafe(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(targetPath);
    return;
  }
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeTreeSafe(childPath);
    } else {
      fs.unlinkSync(childPath);
    }
  }
  fs.rmdirSync(targetPath);
}

for (const rel of targets) {
  const full = path.resolve(appRoot, rel);
  const relative = path.relative(appRoot, full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside app root: ${rel}`);
  }
  removeTreeSafe(full);
}
