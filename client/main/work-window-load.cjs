'use strict';

// 中文：网络子进程重启可能让首次导航一直挂起，却不触发渲染崩溃事件。
// English: A network-service restart can stall initial navigation without a renderer crash.
function start({ win, load, dialog, timeoutMs = 20000, maxRetries = 2,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  /* 中文：需求：首次导航卡住时有限恢复，不是无限 reload。generation 使旧尝试的超时/拒绝失效；finished 阻止已加载页面再被旧回调刷新。
   * English: Requirement: bound initial-navigation recovery instead of endlessly reloading. generation invalidates old attempt timeouts/rejections; finished protects loaded pages from stale callbacks. */
  let timer, generation = 0, retries = 0, finished = false, closed = false, prompting = false;
  const wc = win.webContents;
  const alive = () => !closed && !win.isDestroyed();
  function clear() { if (timer) clearTimer(timer); timer = null; }
  async function failed(token, code) {
    if (!alive() || finished || token !== generation || prompting) return;
    clear();
    console.warn('[desk] initial navigation failed:', code, 'retry', retries);
    // 中文：只恢复尚未加载完成的初始页面，不刷新已工作的会话或丢弃用户草稿。
    // English: Recover only unfinished initial navigation, never reload a working session or its drafts.
    if (retries < maxRetries) { retries++; attempt(); return; }
    /* 中文：自动重试耗尽后使用原生错误框，即使网页完全空白也能操作；用户选择重试才重置预算，关闭只作用于当前窗口。
     * English: After automatic retries are exhausted, use a native dialog that works even with a blank page. Reset the retry budget only on user action; Close affects this window only. */
    prompting = true;
    try {
      win.show();
      const reply = await dialog.showMessageBox(win, { type: 'error', title: 'SoduWork',
        message: '页面加载失败 / Page could not load',
        detail: '请重试加载；已有数据不会被清除。 / Retry loading; existing data will be preserved.',
        buttons: ['重新加载 / Retry', '关闭窗口 / Close'], defaultId: 0, cancelId: 1 });
      if (!alive()) return;
      prompting = false;
      if (reply.response === 0) { retries = 0; attempt(); } else win.close();
    } catch (_) { prompting = false; }
  }
  /* 中文：同步 load 抛错、异步导航拒绝和导航一直不返回共用恢复路径；计时器可注入，测试不必等待真实 20 秒。
   * English: Unify synchronous load throws, asynchronous navigation rejection and stalled navigation under one recovery path. Injectable timers let tests avoid a real 20-second wait. */
  function attempt() {
    if (!alive()) return;
    clear(); finished = false;
    const token = ++generation;
    timer = setTimer(() => { void failed(token, 'timeout'); }, timeoutMs);
    try { Promise.resolve(load()).catch(error => { void failed(token, error?.code || 'navigation-error'); }); }
    catch (error) { void failed(token, error?.code || 'navigation-error'); }
  }
  /* 中文：did-finish-load 仅证明首次页面导航完成，并不证明登录、模型调用或全部业务初始化成功；关闭窗口时清理计时器与监听，不操作用户数据。
   * English: did-finish-load proves initial navigation completed, not successful login, model calls or all business initialization. Clean timers/listeners on close without modifying user data. */
  function loaded() { finished = true; clear(); }
  function onClosed() { closed = true; generation++; clear(); wc.removeListener('did-finish-load', loaded); }
  wc.on('did-finish-load', loaded);
  win.once('closed', onClosed);
  attempt();
}
module.exports = { start };
