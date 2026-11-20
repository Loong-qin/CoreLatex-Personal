import { getToken } from '../api.js';

export function projectFileUrl(projectId, filePath, { download = false } = {}) {
  const token = getToken();
  return `/api/projects/${encodeURIComponent(String(projectId))}/file?path=${encodeURIComponent(filePath)}`
    + (download ? '&download=1' : '') + (token ? `&token=${encodeURIComponent(token)}` : '');
}

// Let the browser stream downloads to disk instead of buffering the entire
// archive, video or dataset in JavaScript memory first.
export function downloadProjectFile(projectId, filePath) {
  const anchor = document.createElement('a');
  anchor.href = projectFileUrl(projectId, filePath, { download: true });
  anchor.download = filePath.split('/').pop() || 'download';
  anchor.rel = 'noreferrer';
  anchor.click();
}

export function downloadProjectExport(projectId) {
  const token = getToken();
  const anchor = document.createElement('a');
  anchor.href = `/api/projects/${encodeURIComponent(String(projectId))}/export`
    + (token ? `?token=${encodeURIComponent(token)}` : '');
  anchor.download = '';
  anchor.rel = 'noreferrer';
  anchor.click();
}
