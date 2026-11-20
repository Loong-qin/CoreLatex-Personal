import { editorRuntime } from './editorRuntime.js';

/**
 * 编辑器右键选区菜单。selection 在右键弹出菜单时由调用方捕获（{from, to}），
 * 避免点击菜单项时编辑器已失焦导致选区被清空；缺省时回退到 editorRuntime 实时读取。
 * action 必须与后端 SELECTION_ACTIONS 对齐：translate/add-comment/explain/simplify/expand/optimize。
 * chatOnly 动作(translate/explain)只在 AI 面板输出结果、不改文件;其余动作会经变更集修改文件。
 */
export function buildSelectionMenuItems({ store, agentStore, ui, onLocatePdf, onAddReview, selection, runtime = editorRuntime }) {
  const sel = selection || runtime.getSelection();
  const start = Math.max(0, Number(sel?.from) || 0);
  const end = Math.max(start, Number(sel?.to) || 0);
  const selectionText = runtime.view?.state?.sliceDoc?.(start, end);
  const { projectId, activeFile: file } = store;
  const run = (action) => {
    if (store.projectId !== projectId || store.activeFile !== file) {
      ui.error('当前文件已切换，请重新选择要处理的文字');
      return;
    }
    if (end <= start) {
      ui.error('请先在编辑器中选中一段文字');
      return;
    }
    agentStore.runSelectionAction(projectId, action, { file, start, end, ...(typeof selectionText === 'string' ? { selectionText } : {}) })
      .then((ok) => {
        // 错误由 agentStore 弹出并 rethrow,这里只在成功时提示
        if (ok === false) return;
        ui.toast(action === 'translate' ? '译文已输出到 AI 面板'
          : action === 'explain' ? 'CoreAgent 已生成回答'
          : action === 'add-comment' ? '已为选中段落添加中文注释,可在编辑器上方审查'
          : '已生成修改，可在编辑器上方审查');
      })
      .catch(() => {});
  };
  return [
    // 审阅模式下由调用方传入 onAddReview（已捕获选区），置顶提供「添加批注」
    ...(onAddReview ? [{ label: '添加批注', action: () => onAddReview({ from: start, to: end }) }, 'divider'] : []),
    ...(onLocatePdf ? [{ label: '定位到 PDF', action: onLocatePdf }, 'divider'] : []),
    { label: '翻译为中文', action: () => run('translate') },
    { label: '添加中文注释', action: () => run('add-comment') },
    { label: '解释这段内容', action: () => run('explain') },
    { label: '精简表达', action: () => run('simplify') },
    { label: '扩写论证', action: () => run('expand') },
    'divider',
    { label: '优化学术表达', action: () => run('optimize') },
  ];
}
