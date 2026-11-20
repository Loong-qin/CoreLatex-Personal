import { createHash } from 'node:crypto';

// Execute every requested read. Only the outgoing model context is compacted:
// an older identical window can be replaced when the latest actual result is
// still present in full in this very request. No cross-request content cache.
export function compactDuplicateReads(messages) {
  const seen = new Set();
  return messages.map((message, index) => ({ message, index })).reverse().map(({ message, index }) => {
    const read = message.role === 'toolResult' && message.toolName === 'read_file' && message.details?.readVersion;
    if (!read || message.isError || !Array.isArray(message.content) || message.content.some(part => part.type !== 'text')) return { message, index };
    const body = message.content.map(part => part.text).join('\n');
    if (body.length < 1024) return { message, index }; // A pointer would cost more.
    // A context-overflow fallback may already have shortened this result.
    if (createHash('sha256').update(body).digest('hex') !== read.resultHash) return { message, index };
    const key = JSON.stringify(read);
    if (!seen.has(key)) { seen.add(key); return { message, index }; }
    return { index, message: { ...message, content: [{ type: 'text', text:
      '[本次读取确已执行；与下方同路径、版本及范围的最新 read_file 结果完全一致。原文保留在该最新结果中。] ' +
      JSON.stringify({ path: read.path, view: read.view, contentHash: read.contentHash, start: read.start, end: read.end, purpose: read.purpose }) }] } };
  }).reverse().map(item => item.message);
}

// Overflow summaries preserve progress, never authority to overwrite unseen
// bytes. Retain edit permissions only for current raw windows still in context.
export function retainVisibleReadPermissions(ctx, messages) {
  const visible = new Map();
  for (const message of messages) {
    const read = message.role === 'toolResult' && !message.isError && message.details?.readVersion;
    if (!read || !Number.isInteger(read.startOffset) || !Number.isInteger(read.endOffset)) continue;
    const text = message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (typeof text !== 'string' || createHash('sha256').update(text).digest('hex') !== read.resultHash) continue;
    const key = `${read.view}:${read.path}`, current = ctx.fileReads.get(key);
    if (current?.hash !== read.contentHash) continue;
    if (!visible.has(key)) visible.set(key, []);
    visible.get(key).push([read.startOffset, read.endOffset]);
  }
  const removed = [];
  for (const [key, read] of ctx.fileReads) {
    if (visible.has(key)) {
      const ranges = [];
      for (const [a, b] of visible.get(key).sort((a, b) => a[0] - b[0])) {
        const last = ranges.at(-1);
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else ranges.push([a, b]);
      }
      ctx.fileReads.set(key, { ...read, ranges });
    }
    else {
      ctx.fileReads.delete(key);
      if (key.startsWith('effective:')) {
        const file = key.slice(10); ctx.reads.delete(file); ctx.readEvidence?.delete(file); removed.push(file);
      }
    }
  }
  return removed;
}
