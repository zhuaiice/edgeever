export const openStandaloneMobileEditor = (memoId: string, returnTo = "/") => {
  const params = new URLSearchParams({
    memoId,
    returnTo,
  });
  window.location.href = `/mobile-edit.html#${params.toString()}`;
};
