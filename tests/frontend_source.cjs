// Source loader for VM unit tests. The server feature is split across scripts;
// take its order from the same index.html used in production, so tests cannot
// silently keep exercising a different dependency list after a module move.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');

function scriptPaths() {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="\/(js\/[^"?]+)\?v=__APP_VERSION__"><\/script>/g)]
    .map(match => match[1]);
}

function readFrontendScript(filename) {
  const absolute = path.resolve(filename);
  let group;
  if (absolute === path.join(frontend, 'js', 'app.server.js')) {
    group = name => name === 'js/app.server.js' || name.startsWith('js/server/');
  } else if (absolute === path.join(frontend, 'js', 'samples', '01-pool.js')) {
    group = name => ['js/samples/01-pool.js', 'js/samples/pool-pagination.js',
      'js/samples/pool-destruction.js', 'js/samples/sample-create.js'].includes(name);
  } else {
    return fs.readFileSync(absolute, 'utf8');
  }
  return scriptPaths().filter(group)
    .map(name => fs.readFileSync(path.join(frontend, name), 'utf8')).join('\n');
}

module.exports = { readFrontendScript, scriptPaths };
