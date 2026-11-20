import { reactive, markRaw } from 'vue';
import { EditorSelection } from '@codemirror/state';
import { useProjectContext } from './projectContext.js';

/**
 * 编辑器运行时句柄：CodeEditor 组件挂载时注册其 CodeMirror EditorView，
 * 工具栏/状态栏/大纲/PDF 跳转等通过这里操作编辑器，避免层层 props。
 */
export function createEditorRuntime() { return reactive({
  view: null, // CodeMirror EditorView（markRaw）
  projectId: null,
  filePath: '',
  register(view, { projectId = null, filePath = '' } = {}) {
    this.view = view ? markRaw(view) : null;
    this.projectId = view ? projectId : null;
    this.filePath = view ? filePath : '';
  },
  /** 跳到 0 基行号并滚动居中、聚焦 */
  jumpToLine(line, col = 0) {
    const v = this.view;
    if (!v) return;
    const max = v.state.doc.lines;
    const ln = Math.min(Math.max(1, line + 1), max);
    const lineInfo = v.state.doc.line(ln);
    const pos = Math.min(lineInfo.from + col, lineInfo.to);
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
  },
  getCursorLine() {
    const v = this.view;
    if (!v) return 0;
    return v.state.doc.lineAt(v.state.selection.main.head).number - 1;
  },
  /** 文档位置（字符偏移）→ 0 基行号，用于右键选区定位 */
  getLineForPos(pos) {
    const v = this.view;
    if (!v || pos == null) return 0;
    const p = Math.max(0, Math.min(pos, v.state.doc.length));
    return v.state.doc.lineAt(p).number - 1;
  },
  getSelection() {
    const v = this.view;
    if (!v) return { from: 0, to: 0, text: '' };
    const { from, to } = v.state.selection.main;
    return { from, to, text: v.state.sliceDoc(from, to) };
  },
  /** 包裹选区（加粗等）；无选区则插入占位并选中占位文本 */
  wrapSelection(before, after = before, placeholder = 'text') {
    const v = this.view;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to) || placeholder;
    v.dispatch({
      changes: { from, to, insert: before + sel + after },
      selection: { anchor: from + before.length, head: from + before.length + sel.length },
      scrollIntoView: true,
    });
    v.focus();
  },
  insertText(text) {
    const v = this.view;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, scrollIntoView: true });
    v.focus();
  },
  getDocText() {
    return this.view ? this.view.state.doc.toString() : '';
  },
  /** 选中一个字符区间并滚动可见（状态条点击跳转用：选区转移到目标处，高亮不丢） */
  selectRange(from, to) {
    const v = this.view;
    if (!v) return;
    const a = Math.max(0, Math.min(from, v.state.doc.length));
    const b = Math.max(a, Math.min(to, v.state.doc.length));
    v.dispatch({ selection: EditorSelection.range(a, b), scrollIntoView: true });
    v.focus();
  },
}); }

export const editorRuntime = createEditorRuntime();
export function useEditorRuntime() { return useProjectContext()?.runtime || editorRuntime; }
