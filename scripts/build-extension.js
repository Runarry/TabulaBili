const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const chromeSourceDir = path.join(distDir, 'chrome-source');
const firefoxSourceDir = path.join(distDir, 'firefox-source');
const webExtBin = path.join(rootDir, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const versionLabel = process.env.BUILD_VERSION || process.env.GITHUB_REF_NAME || 'local';
const crcTable = buildCrcTable();

const extensionFiles = [
  'rules.json',
  'analysis-common.js',
  'sync-common.js',
  'background.js',
  'content.js',
  'content-main.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'options.html',
  'options.css',
  'options.js',
  'icon.png',
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png'
];

function copyExtensionFiles(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of extensionFiles) {
    fs.copyFileSync(path.join(rootDir, file), path.join(targetDir, file));
  }
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeBrowserManifests() {
  const manifest = readManifest();

  const chromeManifest = structuredClone(manifest);
  delete chromeManifest.background.scripts;
  delete chromeManifest.browser_specific_settings;
  writeJson(path.join(chromeSourceDir, 'manifest.json'), chromeManifest);

  const firefoxManifest = structuredClone(manifest);
  delete firefoxManifest.background.service_worker;
  writeJson(path.join(firefoxSourceDir, 'manifest.json'), firefoxManifest);
}

function validateChromeManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(chromeSourceDir, 'manifest.json'), 'utf8'));
  if (!manifest.background || manifest.background.service_worker !== 'background.js') {
    throw new Error('Chrome manifest must define background.service_worker');
  }
  if (manifest.background.scripts) {
    throw new Error('Chrome manifest must not define background.scripts');
  }
  if (manifest.browser_specific_settings) {
    throw new Error('Chrome manifest must not include browser_specific_settings');
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runWebExt(args) {
  run(process.execPath, [webExtBin, ...args]);
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function collectFiles(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push({
        fullPath,
        zipPath: path.relative(baseDir, fullPath).replaceAll(path.sep, '/')
      });
    }
  }

  return files;
}

function writeZip(sourceDir, outputPath) {
  fs.rmSync(outputPath, { force: true });
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of collectFiles(sourceDir)) {
    const source = fs.readFileSync(file.fullPath);
    const compressed = require('node:zlib').deflateRawSync(source);
    const name = Buffer.from(file.zipPath, 'utf8');
    const stat = fs.statSync(file.fullPath);
    const { dosDate, dosTime } = getDosDateTime(stat.mtime);
    const checksum = crc32(source);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(source.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(centralParts.length / 2, 8);
  footer.writeUInt16LE(centralParts.length / 2, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(offset, 16);

  fs.writeFileSync(outputPath, Buffer.concat([...localParts, ...centralParts, footer]));
}

function buildFirefoxWithWebExt(sourceDir, filename) {
  const outputPath = path.join(distDir, filename);
  fs.rmSync(outputPath, { force: true });

  runWebExt([
    'build',
    '--source-dir',
    sourceDir,
    '--artifacts-dir',
    distDir,
    '--filename',
    filename,
    '--overwrite-dest'
  ]);
}

fs.mkdirSync(distDir, { recursive: true });
copyExtensionFiles(chromeSourceDir);
copyExtensionFiles(firefoxSourceDir);
writeBrowserManifests();
validateChromeManifest();

runWebExt(['lint', '--source-dir', firefoxSourceDir]);

writeZip(chromeSourceDir, path.join(distDir, `TabulaBili-${versionLabel}-chrome.zip`));
buildFirefoxWithWebExt(firefoxSourceDir, `tabulabili-${versionLabel}-firefox.xpi`);
