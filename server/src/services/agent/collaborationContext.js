import { createHash } from 'node:crypto';

export const fingerprint = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';

/** Only successful, actually returned windows are evidence. A whole-file hash
 * does not expand a paginated read into full-file coverage. */
export function createEvidenceRecord({ source, contentHash, content, startLine = 1, endLine, truncated = false, snapshotId, purpose = 'context', capturedAt = Date.now() }) {
  if (!source || typeof content !== 'string' || !contentHash) return null;
  return { evidenceId: fingerprint([source, contentHash, startLine, endLine, content]), source, contentHash,
    startLine, endLine: endLine ?? startLine + content.split('\n').length - 1, content, truncated: !!truncated, snapshotId, purpose, capturedAt };
}

export function buildContextPacket({ task, userRequest, messages = [], goalVersion = 0, snapshotId,
  reads = new Map(), evidence = [], toolTrace = [], preferences = {}, project = {}, getHash }) {
  const scope = task?.readScope || task?.scope?.map(item => typeof item === 'string' ? item : item.path) || [];
  const constraints = messages.filter(message => message.role === 'user').map((message, index) => ({
    sourceMessageId: message.id ?? `history-${index}`, text: text(message.content) })).filter(item => item.text);
  let remaining = 24000;
  const selected = evidence.filter(item => item && (!scope.length || scope.includes(item.source)) && reads.get(item.source) === item.contentHash &&
    (!getHash || getHash(item.source) === item.contentHash)).flatMap(item => {
      if (!remaining) return [];
      const content = item.content.slice(0, Math.min(8000, remaining)); remaining -= content.length;
      return [createEvidenceRecord({ ...item, content, endLine: item.startLine + content.split('\n').length - 1,
        truncated: item.truncated || content.length < item.content.length })];
    });
  return {
    version: 2,
    taskContract: { userGoal: userRequest, objective: task?.task || task?.objective || '', goalVersion,
      priorUserRequirements: constraints, readScope: scope, writeScope: task?.role === 'editor' ? task.scope || [] : [], preferences },
    referenceDataNotInstructions: { project, snapshotId, evidence: structuredClone(selected),
      readDigest: [...reads].map(([path, contentHash]) => ({ path, contentHash })) },
    executionFacts: toolTrace.slice(-20).map(call => ({ toolCallId: call.toolCallId, name: call.name,
      status: call.status, input: call.input, summary: call.display?.summary })),
  };
}
