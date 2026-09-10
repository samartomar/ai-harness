import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function regularBytes(path, maxBytes = 16 * 1024 * 1024) {
  const full = resolve(path), before = lstatSync(full, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, 'nonregular or linked input');
  assert(before.size >= 0n && before.size <= BigInt(maxBytes), 'input byte limit');
  const fd = openSync(full, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(full, { bigint: true });
    assert(!named.isSymbolicLink());
    for (const stat of [opened, after, named]) for (const field of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) assert.equal(stat[field], before[field], `changed input ${field}`);
    assert.equal(BigInt(bytes.length), before.size); return bytes;
  } finally { closeSync(fd); }
}
function within(root, path) {
  const rel = relative(root, path);
  assert(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'path outside root');
}
export function inventory(root) {
  if (!existsSync(root)) return [];
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'linked inventory root');
  const realRoot = realpathSync.native(root), rows = [{ path: '.', kind: 'directory' }];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const full = join(path, entry.name);
      assert(!lstatSync(full).isSymbolicLink(), 'linked inventory member'); within(realRoot, realpathSync.native(full));
      assert(rows.length < 20000, 'inventory count limit');
      if (entry.isDirectory()) { rows.push({ path: relative(root, full).replaceAll('\\', '/'), kind: 'directory' }); visit(full); }
      else {
        assert(entry.isFile() && rows.length < 20000, 'inventory member/count limit');
        const bytes = regularBytes(full, 128 * 1024 * 1024);
        rows.push({ path: relative(root, full).replaceAll('\\', '/'), kind: 'file', bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit(root); return rows;
}
export function compareInstalledTarball(tarballPath, packageRoot, expectedSha256) {
  const compressed = regularBytes(tarballPath, 64 * 1024 * 1024);
  assert.equal(sha256(compressed), expectedSha256, 'original tarball changed');
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const realRoot = realpathSync.native(packageRoot), entries = [], seen = new Set();
  const octal = data => { const value = data.toString('ascii').replace(/\0.*$/u, '').trim(); assert(/^[0-7]+$/u.test(value), 'invalid tar integer'); return Number.parseInt(value, 8); };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { assert(tar.subarray(offset).every(byte => byte === 0), 'tar trailing data'); break; }
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, octal(header.subarray(148, 156)), 'tar checksum');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
    const full = prefix ? `${prefix}/${name}` : name, size = octal(header.subarray(124, 136));
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'tar byte bound');
    assert(full.startsWith('package/') && !full.includes('\\') && !full.includes(':'), 'tar path');
    const rel = full.slice(8); assert(rel.split('/').every(part => part !== '..' && part !== '.'), 'tar traversal');
    if (header[156] === 0 || header[156] === 48) {
      assert(rel && !rel.endsWith('/') && !rel.includes('//') && !seen.has(rel), 'tar duplicate/path'); seen.add(rel);
      const path = resolve(packageRoot, rel); within(realRoot, realpathSync.native(path));
      const bytes = regularBytes(path, 128 * 1024 * 1024);
      assert(bytes.equals(tar.subarray(offset + 512, offset + 512 + size)), `installed bytes differ: ${rel}`);
      entries.push({ path: rel, bytes: size, sha256: sha256(bytes) });
    } else assert.equal(header[156], 53, 'unsupported nonregular tar member');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(entries.length > 0, 'empty tarball');
  assert.deepEqual(inventory(packageRoot).filter(row => row.kind === 'file').map(row => row.path).sort(), entries.map(row => row.path).sort(), 'installed file-set mismatch');
  return { tarballSha256: sha256(compressed), fileCount: entries.length, entries };
}
