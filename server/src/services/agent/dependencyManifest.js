import { fingerprint } from './collaborationContext.js';

export function diffFingerprint(changes, scope = null) {
  return fingerprint(changes.filter(file => !scope || scope.includes(file.path))
    .map(file => [file.path, file.encoding || 'utf8', file.before, file.after]).sort((a, b) => a[0].localeCompare(b[0])));
}

export function dependencyManifest({ changes, reads, scope = null, complete = false }) {
  return { version: 1, complete, scope, diffHash: diffFingerprint(changes, scope),
    reads: [...reads].map(([path, contentHash]) => ({ path, contentHash })) };
}

export function manifestCurrent(manifest, { changes, getHash, requireComplete = false }) {
  if (manifest?.version !== 1 || requireComplete && !manifest.complete) return false;
  return manifest.diffHash === diffFingerprint(changes, manifest.scope) &&
    manifest.reads.every(item => getHash(item.path) === item.contentHash);
}
