import { hasInjectionContext, inject } from 'vue';

export const PROJECT_CONTEXT = Symbol('corelatex.projectContext');
export function useProjectContext() {
  return hasInjectionContext() ? inject(PROJECT_CONTEXT, null) : null;
}

export const WORKSPACE_CONTEXT = Symbol('corelatex.workspaces');
export function useWorkspaceContext() {
  return hasInjectionContext() ? inject(WORKSPACE_CONTEXT, null) : null;
}
