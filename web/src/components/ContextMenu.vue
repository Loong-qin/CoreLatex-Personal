<template>
  <Teleport to="body">
    <div v-if="ui.contextMenu" class="ctx-mask" @click="ui.closeContextMenu()" @contextmenu.prevent="ui.closeContextMenu()">
      <div class="context-menu" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @click.stop>
        <template v-for="(item, i) in ui.contextMenu.items" :key="i">
          <div v-if="item === 'divider'" class="menu-divider"></div>
          <div
            v-else
            class="menu-item"
            :class="{ danger: item.danger }"
            @click="pick(item)"
          >{{ item.label }}</div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue';
import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();

// 防止菜单超出视口
const pos = computed(() => {
  const { x, y } = ui.contextMenu || { x: 0, y: 0 };
  const maxX = window.innerWidth - 200;
  const maxY = window.innerHeight - (ui.contextMenu?.items.length || 1) * 34 - 16;
  return { x: Math.min(x, maxX), y: Math.min(y, Math.max(8, maxY)) };
});

function pick(item) {
  ui.closeContextMenu();
  item.action?.();
}
</script>

<style scoped>
.ctx-mask { position: fixed; inset: 0; z-index: 9998; }

/* ---- visual refinement layer (presentation only; glass base comes from theme.css) ---- */
.context-menu { padding: 6px; }
.menu-item { display: flex; align-items: center; font-weight: 500; letter-spacing: .01em; border-radius: 7px; }
.menu-item.danger { color: var(--danger); font-weight: 550; }
.menu-item.danger:hover { background: var(--danger-soft); }
.menu-divider { background: color-mix(in srgb, var(--border) 65%, transparent); margin: 5px 8px; }
@media (forced-colors: active) {
  .menu-item.danger:hover { background: Canvas; color: LinkText; }
  .menu-divider { background: CanvasText; }
}
</style>
