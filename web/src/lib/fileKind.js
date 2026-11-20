const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.txt', '.md', '.json', '.xml', '.csv',
  '.sh', '.py', '.js', '.ts', '.css', '.html', '.svg', '.yaml', '.yml',
  '.bibtex', '.bst', '.cfg', '.def', '.clo', '.tsv', '.m', '.r',
  '.c', '.cpp', '.h', '.hpp', '.java', '.log', '.aux', '.bbl', '.blg',
  '.toc', '.out', '.gls', '.ist', '.latexmkrc',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.avif', '.ico']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);

export function fileExtension(path = '') {
  const name = String(path).split('/').pop();
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function fileKind(path = '', node = null) {
  if (node?.type === 'dir') return 'directory';
  if (node?.text === true) return 'text';
  const ext = fileExtension(path);
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext) || !String(path).split('/').pop().includes('.')) return 'text';
  return 'binary';
}

export function isTextFilePath(path = '', node = null) {
  return fileKind(path, node) === 'text';
}

export { TEXT_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS };