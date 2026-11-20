import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSelectionMenuItems } from './selectionMenu.js';
import { editorRuntime } from './editorRuntime.js';

function makeCtx({ selection } = {}) {
  const store = { projectId: 'p1', activeFile: 'main.tex' };
  const agentStore = { runSelectionAction: vi.fn(() => Promise.resolve(true)) };
  const ui = { toast: vi.fn(), error: vi.fn() };
  const items = buildSelectionMenuItems({ store, agentStore, ui, selection });
  return { store, agentStore, ui, items };
}

function itemByLabel(items, label) {
  const it = items.find((i) => i !== 'divider' && i.label === label);
  expect(it, `菜单项缺失：${label}`).toBeTruthy();
  return it;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('buildSelectionMenuItems', () => {
  beforeEach(() => {
    editorRuntime.register(null);
  });

  it('透传右键时捕获的选区偏移给后端', async () => {
    const { agentStore, items } = makeCtx({ selection: { from: 5, to: 17 } });
    itemByLabel(items, '翻译为中文').action();
    await flush();
    expect(agentStore.runSelectionAction).toHaveBeenCalledWith('p1', 'translate', {
      file: 'main.tex', start: 5, end: 17,
    });
  });

  it('动作名与后端 SELECTION_ACTIONS 对齐（simplify/optimize）', () => {
    const { agentStore, items } = makeCtx({ selection: { from: 0, to: 3 } });
    const cases = [
      ['翻译为中文', 'translate'],
      ['解释这段内容', 'explain'],
      ['精简表达', 'simplify'],
      ['扩写论证', 'expand'],
      ['优化学术表达', 'optimize'],
    ];
    for (const [label, action] of cases) {
      itemByLabel(items, label).action();
      expect(agentStore.runSelectionAction).toHaveBeenLastCalledWith(
        'p1', action, { file: 'main.tex', start: 0, end: 3 },
      );
    }
  });

  it('未传 selection 时回退到 editorRuntime.getSelection()', async () => {
    editorRuntime.register({
      state: {
        selection: { main: { from: 2, to: 8 } },
        sliceDoc: () => 'abcdef',
      },
    });
    const { agentStore, items } = makeCtx();
    itemByLabel(items, '精简表达').action();
    await flush();
    expect(agentStore.runSelectionAction).toHaveBeenCalledWith('p1', 'simplify', {
      file: 'main.tex', start: 2, end: 8, selectionText: 'abcdef',
    });
  });

  it('空选区直接报错，不调用后端', () => {
    const { agentStore, ui, items } = makeCtx({ selection: { from: 4, to: 4 } });
    itemByLabel(items, '翻译为中文').action();
    expect(agentStore.runSelectionAction).not.toHaveBeenCalled();
    expect(ui.error).toHaveBeenCalledWith('请先在编辑器中选中一段文字');
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it('切换文件后禁用旧菜单中的修改操作', () => {
    const { store, agentStore, ui, items } = makeCtx({ selection: { from: 0, to: 3 } });
    store.activeFile = 'appendix.tex';
    itemByLabel(items, '优化学术表达').action();
    expect(agentStore.runSelectionAction).not.toHaveBeenCalled();
    expect(ui.error).toHaveBeenCalled();
  });

  it('成功时弹提示，失败（reject）时不弹成功提示也不重复报错', async () => {
    const ok = makeCtx({ selection: { from: 0, to: 3 } });
    itemByLabel(ok.items, '优化学术表达').action();
    await flush();
    expect(ok.ui.toast).toHaveBeenCalledWith('已生成修改，可在编辑器上方审查');

    const fail = makeCtx({ selection: { from: 0, to: 3 } });
    fail.agentStore.runSelectionAction.mockRejectedValue(new Error('选区为空'));
    itemByLabel(fail.items, '优化学术表达').action();
    await flush();
    expect(fail.ui.toast).not.toHaveBeenCalled();
    expect(fail.ui.error).not.toHaveBeenCalled(); // 错误由 agentStore 统一弹出
  });

  it('explain 成功的提示文案不带「修改」', async () => {
    const { ui, items } = makeCtx({ selection: { from: 0, to: 3 } });
    itemByLabel(items, '解释这段内容').action();
    await flush();
    expect(ui.toast).toHaveBeenCalledWith('CoreAgent 已生成回答');
  });

  it('streaming 中（返回 false）不弹成功提示', async () => {
    const { agentStore, ui, items } = makeCtx({ selection: { from: 0, to: 3 } });
    agentStore.runSelectionAction.mockResolvedValue(false);
    itemByLabel(items, '翻译为中文').action();
    await flush();
    expect(ui.toast).not.toHaveBeenCalled();
  });
});
