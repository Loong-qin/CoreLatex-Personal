import { createHash } from 'node:crypto';

const deterministic = new Set(['FILE_READ_REQUIRED', 'FILE_CHANGED', 'DRAFT_BASE_CHANGED', 'READ_SCOPE_REQUIRED',
  'EDIT_SEARCH_NOT_FOUND', 'EDIT_SEARCH_AMBIGUOUS', 'STALE_FIX', 'REBASE_STALE', 'WORKFLOW_PRECONDITION']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Only proven deterministic local failures are suppressed. Reads, networking,
// scripts and unknown side effects never enter this cache. No total tool cap.
export function createExecutionRecovery() {
  const failed = new Map();
  let prevented = 0;
  return {
    before(name, input, state) {
      const key = hash([name, canonical(input), state]);
      const previous = failed.get(key);
      if (!previous) return { key };
      prevented++;
      return { key, block: { failed: true, code: 'TOOL_NO_PROGRESS',
        reason: `相同 ${name} 操作在相关文件、读取范围及参数均未变化时再次提交，先前错误为 ${previous}。已停止重复失败；请根据实际错误调整目标或内容后继续，已有草稿保留待审。` } };
    },
    record(key, result) { if (deterministic.has(result?.code)) failed.set(key, result.code); },
    reset() { failed.clear(); },
    snapshot: () => ({ deterministicFailures: failed.size, prevented }),
  };
}
