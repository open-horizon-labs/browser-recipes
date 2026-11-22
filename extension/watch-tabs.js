// Extension pages can stay open while the user changes tabs in another window.
export function watchTabs(update, isBusy) {
  let timer;
  let pending = false;
  function schedule() {
    pending = true;
    if (document.hidden || timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (!pending || document.hidden) return;
      if (isBusy()) {
        schedule();
        return;
      }
      pending = false;
      await update();
    }, 180);
  }
  chrome.tabs.onActivated.addListener(schedule);
  chrome.tabs.onCreated.addListener(schedule);
  chrome.tabs.onRemoved.addListener(schedule);
  chrome.tabs.onReplaced.addListener(schedule);
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.url !== undefined || change.title !== undefined || change.status === 'complete') schedule();
  });
  chrome.permissions.onAdded.addListener(schedule);
  chrome.permissions.onRemoved.addListener(schedule);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.approvedOrigins) schedule();
  });
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', schedule);
  return schedule;
}
