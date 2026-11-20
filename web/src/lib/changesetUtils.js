// 新服务端逐文件记录实际应用状态；旧响应回退父级标志。
export function changesetFileApplied(changeset, file) {
  return file?.applied == null ? changeset.applied !== false : !!file.applied;
}

// 审阅列表和项目角标共用文件口径，同一文件多轮修改只算一个待审阅条目。
export function groupPendingChangesetFiles(changesets) {
  const map = new Map();
  for (const cs of changesets || []) {
    for (const f of cs.files || []) {
      if (f.status !== 'pending') continue;
      const g = map.get(f.filePath) || {
        filePath: f.filePath,
        adds: 0,
        dels: 0,
        changesetIds: [],
        appliedIds: [],
        proposalIds: [],
        applied: true,
        binary: !!f.binary,
        beforeBytes: f.beforeBytes,
        afterBytes: f.afterBytes,
      };
      g.binary = g.binary || !!f.binary;
      if (f.afterBytes != null) g.afterBytes = f.afterBytes;
      g.adds += f.adds ?? 0;
      g.dels += f.dels ?? 0;
      g.changesetIds.push(cs.id);
      const applied = changesetFileApplied(cs, f);
      g.applied = g.applied && applied;
      (applied ? g.appliedIds : g.proposalIds).push(cs.id);
      map.set(f.filePath, g);
    }
  }
  return [...map.values()];
}
