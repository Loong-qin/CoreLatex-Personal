// Real links preserve optional browser tab shortcuts and context menus.
export function projectPath(project) {
  return `/project/${encodeURIComponent(String(project?.publicId || project?.id || ''))}`;
}

export function navigateWorkspaceLink(event, path, router) {
  if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  event.preventDefault();
  router.push(path);
  return true;
}

export function navigateProjectLink(event, project, router) {
  return navigateWorkspaceLink(event, projectPath(project), router);
}
