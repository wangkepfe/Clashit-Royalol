const BOTS_DIR = new URL('../bots/', import.meta.url);
const JS_FILE = /\.js$/i;
const HELPER_FILES = new Set(['lib.js']);

function isNodeRuntime() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function fileNameFromUrl(url) {
  return decodeURIComponent(url.pathname.split('/').pop() || '');
}

function botNameFromFile(file) {
  return file.replace(JS_FILE, '');
}

function isDirectBotFile(url) {
  const dirPath = BOTS_DIR.pathname.endsWith('/') ? BOTS_DIR.pathname : BOTS_DIR.pathname + '/';
  if (url.origin !== BOTS_DIR.origin || !url.pathname.startsWith(dirPath)) return false;

  const file = decodeURIComponent(url.pathname.slice(dirPath.length));
  return file && !file.includes('/') && JS_FILE.test(file);
}

async function discoverBotFilesFromListing() {
  const res = await fetch(BOTS_DIR.href);
  if (!res.ok) throw new Error(`could not list ${BOTS_DIR.href}: ${res.status}`);

  const html = await res.text();
  const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  return hrefs
    .map((href) => new URL(href, BOTS_DIR))
    .filter(isDirectBotFile)
    .map((url) => url.href);
}

async function discoverBotFilesFromDisk() {
  const [{ readdir }, { join }, { fileURLToPath, pathToFileURL }] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:url'),
  ]);

  const dir = fileURLToPath(BOTS_DIR);
  const files = await readdir(dir, { withFileTypes: true });
  return files
    .filter((file) => file.isFile() && JS_FILE.test(file.name))
    .map((file) => pathToFileURL(join(dir, file.name)).href);
}

async function discoverBotFiles() {
  const hrefs = BOTS_DIR.protocol === 'file:' && isNodeRuntime()
    ? await discoverBotFilesFromDisk()
    : await discoverBotFilesFromListing();

  const byFile = new Map();
  for (const href of hrefs) {
    const url = new URL(href);
    byFile.set(fileNameFromUrl(url), url.href);
  }

  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, href]) => ({ file, href, name: botNameFromFile(file) }));
}

async function loadBots() {
  const bots = {};
  for (const { file, href, name } of await discoverBotFiles()) {
    try {
      const mod = await import(href);
      if (typeof mod.default === 'function') {
        bots[name] = mod.default;
      } else if (!HELPER_FILES.has(file)) {
        console.warn(`Skipping ${file}: bot modules must default-export a function.`);
      }
    } catch (err) {
      console.error(`Failed to load bot ${file}.`, err);
    }
  }
  return bots;
}

export const BOTS = await loadBots();
