export function projectNotificationLabel(pendingReviewCount, unreadCompletion) {
  if (pendingReviewCount > 0) return `${pendingReviewCount} 个待审阅文件`;
  return unreadCompletion ? '有未读完成结果' : '';
}
