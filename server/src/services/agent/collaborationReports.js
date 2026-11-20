import { fingerprint } from './collaborationContext.js';

export function reportEnvelope(report, { task, revision, goalVersion = 0, coverage = [], evidenceIds = [], dependencyManifest } = {}) {
  const reportId = fingerprint([task?.executionId || task?.id, revision, report]);
  return { ...structuredClone(report), reportId, taskId: task?.id, attemptId: task?.executionId,
    goalVersion, snapshotId: String(revision), policyVersion: 'orchestration-v2', coverage, evidenceIds,
    limitations: report.limitations || [],
    ...(dependencyManifest ? { dependencyManifest } : {}),
    ...(report.verdict === 'blocked' ? { blockedReason: report.blockedReason || { code: 'INVESTIGATION_BLOCKED', message: report.summary, recoverable: false } } : {}),
    findings: (report.findings || []).map(finding => ({ ...finding,
      findingId: finding.findingId || fingerprint([task?.id, finding.category, finding.path, finding.side, finding.message, finding.evidence]) })),
  };
}

/** Compact transport, never an empty blocked message or an unscoped guarantee. */
export function renderWorkerReports(result) {
  const reports = Array.isArray(result) ? result : result?.reports || [];
  return JSON.stringify({ phase: result?.phase, ready: result?.ready, reason: result?.reason, error: result?.error, failed: result?.failed,
    reports: reports.map(item => {
      const report = item.report || item;
      return { id: item.id || report.taskId, role: item.role, revision: item.revision ?? report.snapshotId, current: item.current,
        ...(item.takeover ? { takeover: item.takeover } : {}),
        report: { reportId: report.reportId, verdict: report.verdict, summary: report.summary,
          coverage: report.coverage, limitations: report.limitations,
          ...(report.verdict === 'blocked' ? { blockedReason: report.blockedReason || { message: report.summary } } : {}),
          findings: report.findings || [] } };
    }) });
}
