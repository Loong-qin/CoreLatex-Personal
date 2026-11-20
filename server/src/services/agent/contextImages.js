/**
 * 图像软预算：优先省略旧图，但至少保留最新一张有效图像。
 * latestMessageOnly 用于只保留最近一次看图结果；始终复制被修改的消息，不改写活上下文。
 */
export function pruneContextImages(messages, { byteBudget = Infinity, latestMessageOnly = false } = {}) {
  const images = [];
  let total = 0;
  messages.forEach((m, messageIndex) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((part, partIndex) => {
      if (part?.type !== 'image' || typeof part.data !== 'string' || !part.data.length) return;
      const size = part.data.length; // base64 字符为 ASCII，按请求中的编码体积计量。
      images.push({ messageIndex, partIndex, size });
      total += size;
    });
  });
  const latest = images[images.length - 1];
  if (!latest) return messages;
  const omitted = new Map();
  for (const image of images) {
    if (image === latest) continue; // 最后一张超过预算时，交给真实上下文超限重试处理。
    if ((!latestMessageOnly || image.messageIndex === latest.messageIndex) && total <= byteBudget) continue;
    if (!omitted.has(image.messageIndex)) omitted.set(image.messageIndex, new Set());
    omitted.get(image.messageIndex).add(image.partIndex);
    total -= image.size;
  }
  return messages.map((m, index) => !omitted.has(index) ? m : {
    ...m,
    content: m.content.map((part, partIndex) => omitted.get(index).has(partIndex)
      ? { type: 'text', text: '[早期图像已省略]' }
      : part),
  });
}

