import { defineStore } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';

export const useUiStore = defineStore('ui', {
  state: () => ({
    // 全局右键菜单 {x, y, items:[{label, danger?, action}] | 'divider'}
    contextMenu: null,
  }),
  actions: {
    toast(message, type = 'ok', ms = 3000) {
      ElMessage({
        message,
        type: type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'success',
        duration: ms,
      });
    },
    error(message, ms = 4500) {
      this.toast(message, 'error', ms);
    },
    // 确认对话框：resolve(true)=确认，resolve(false)=取消/关闭
    async confirm(message, title = '确认', options = {}) {
      try {
        await ElMessageBox.confirm(message, title, {
          confirmButtonText: options.confirmText || '确定',
          cancelButtonText: options.cancelText || '取消',
          type: options.type || 'warning',
          ...options,
        });
        return true;
      } catch {
        return false;
      }
    },
    openContextMenu(x, y, items) {
      this.contextMenu = { x, y, items };
    },
    closeContextMenu() {
      this.contextMenu = null;
    },
  },
});
