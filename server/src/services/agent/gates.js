/** Pure checks over server-owned facts. No scheduling, counters or mutations. */
export function workflowGate(facts) {
  const { planned, needsContext, contextRead, needsSources, sourceRead, allowWebAccess,
    compileBlock, compileStale, requiresCompile, compileFailed, compiledRevision, revision,
    needsDiagnosis, compileAttempted } = facts;
  let reason = '', target = 'verify';
  if (compileBlock?.fatal) return { ready: false, failed: true, blocked: true, code: compileBlock.code,
    reason: compileBlock.reason, target, limitReached: false };
  if (!planned) { reason = '尚未规划任务路线。请先调用 plan_task_graph；直接解释可选择 answer。'; target = 'plan'; }
  else if (needsContext && !contextRead) { reason = '尚未读取本轮项目上下文，请先读取相关文件。'; target = 'context'; }
  else if (needsSources && !sourceRead) {
    reason = allowWebAccess
      ? '来源核查尚未完成：请用 web_fetch 读取非空正文，或直接用 read_file({path, purpose:"source"}) 读取本地原始资料的非空正文；普通文稿上下文与文件列表不算来源证据。'
      : '来源核查尚未完成且联网已关闭：请直接用 read_file({path, purpose:"source"}) 核对本地原始资料的非空正文，或用 ask_user 索取资料；不得绕过联网设置。';
    target = 'research';
  } else if (compileBlock) reason = compileBlock.reason + '请在服务恢复后重试编译，不要为此修改正文。';
  else if (compileStale) reason = '编译时或编译后项目输入发生变化，旧快照不能验证当前版本。请重新编译当前版本后再交付。';
  else if (requiresCompile && (compileFailed || compiledRevision !== revision)) reason = compileFailed
    ? '编译验证仍失败。请根据真实错误修复，再调用 compile_and_preview；未通过前不能自动应用草稿。'
    : '最新的正式排版文件尚未验证。请调用 compile_and_preview 编译当前暂存版本，成功后再交付。';
  else if (needsDiagnosis && !compileAttempted) reason = '只读编译诊断尚未执行，请调用 compile_and_preview 获取实际结果，再如实解释成功或错误；无需为诊断制造修改。';
  return { ready: !reason, failed: false, reason, target };
}

export function dependencySatisfied(requirement, task, current = true) {
  if (!current || !task || task.status !== 'completed' || !task.report) return false;
  if (requirement === 'merged_draft') return task.merged === true && task.report.verdict === 'pass';
  if (requirement === 'pass') return task.report.verdict === 'pass';
  return ['pass', 'needs_changes'].includes(task.report.verdict);
}
