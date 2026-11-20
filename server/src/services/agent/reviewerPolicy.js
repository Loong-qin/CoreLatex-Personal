import { diffLines } from 'diff';
import { fingerprint } from './collaborationContext.js';

const DEFECTS = new Set(['factual_error', 'conflict']);
const NON_BLOCKING = new Set(['suggestion', 'uncertain']);

// A style suggestion or an unconfirmed suspicion cannot create a repair gate.
// Preserve genuine blocked investigations; absence of evidence is not a pass.
export function nonBlockingReview(report) {
  if (!report || report.verdict === 'blocked' || !Array.isArray(report.findings) || !report.findings.length ||
    !report.findings.every(item => NON_BLOCKING.has(item.category))) return report;
  const uncertain = report.findings.filter(item => item.category === 'uncertain').map(item => ({ ...item, severity: 'info' }));
  return { ...report, verdict: 'pass',
    summary: '本轮变更未发现有证据支持的冲突或事实性错误。' + (uncertain.length ? '以下未证实疑点仅说明核查范围，不构成返工要求。' : ''),
    findings: uncertain };
}

function changedLine(file, line, side) {
  if (file.encoding === 'base64') return line == null;
  if (!Number.isInteger(line) || line < 1) return false;
  let before = 1, after = 1;
  for (const chunk of diffLines(file.before || '', file.after || '')) {
    if (side === 'before' && chunk.removed && line >= before && line < before + chunk.count) return true;
    if (side === 'after' && chunk.added && line >= after && line < after + chunk.count) return true;
    if (!chunk.added) before += chunk.count;
    if (!chunk.removed) after += chunk.count;
  }
  return false;
}

/** Evidence sources are supplied by the server, never accepted from a report. */
export function validateReviewerReport(report, { changes, sources }) {
  for (const item of report.findings) {
    if (!DEFECTS.has(item.category)) continue;
    const file = changes.find(file => file.path === item.path);
    if (!file || !changedLine(file, item.line, item.side || 'after'))
      return '错误必须定位到本轮实际变更行；删除行用 side=before，新增或修改后的行用 side=after。未修改部分的独立问题不属于此次审查。';
    const proof = item.evidence;
    if (!proof?.source?.trim() || !proof?.quote?.trim() ||
      !sources.some(source => source.source === proof.source && source.text.includes(proof.quote.trim())))
      return '事实错误或冲突须提供 evidence.source 与 evidence.quote，引用必须来自服务器已提供的差异片段或本子智能体实际成功读取的正文；不能虚构来源或用他人报告代替。';
    if (report.verdict === 'pass') return '仍有已证实的事实错误或冲突，应报告 needs_changes，不能报告 pass。';
    const fix = item.suggestedFix;
    if (fix && (fix.path !== file.path || file.encoding === 'base64' || typeof file.after !== 'string' ||
      fix.baseHash !== fingerprint(file.after) || !fix.search || file.after.split(fix.search).length !== 2 || typeof fix.replace !== 'string'))
      return 'suggestedFix 必须定位到当前冻结草稿的同一文件，提供匹配的 baseHash、唯一 search 和 replace；建议不会自动执行。';
  }
  if (report.verdict === 'needs_changes' && !report.findings.some(item => DEFECTS.has(item.category)))
    return 'needs_changes 仅用于有证据的 factual_error 或 conflict。无确证错误时报告 pass；可选建议和未证实疑点不能要求修改。';
  return '';
}
