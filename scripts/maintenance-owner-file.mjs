import fs from 'node:fs';

export function readMaintenanceOwnerFile(path) {
  if (!path) throw new Error('--owner-file is required');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Owner file must be a private regular file (0600)');
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
}
