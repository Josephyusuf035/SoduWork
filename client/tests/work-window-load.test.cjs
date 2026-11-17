'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { start } = require('../main/work-window-load.cjs');
/* 中文：使用虚拟定时器和最小窗口事件模拟首次导航卡住，无须真实 Electron 或等待 20 秒；检查重试次数、原生提示、旧拒绝与关闭后清理。
 * English: Use virtual timers and minimal window events to simulate stalled startup without real Electron or 20-second waits; check bounded retries, native prompts, stale rejection and cleanup. */
function fixture(options = {}) {
  const win = new EventEmitter(), timers = new Map(); let count = 0, prompts = 0, closed = false;
  win.webContents = new EventEmitter(); win.isDestroyed = () => closed; win.show = () => {};
  win.close = () => { closed = true; win.emit('closed'); };
  start({ win, load: () => { count++; return options.load?.(count) || new Promise(() => {}); },
    dialog: { showMessageBox: async () => { prompts++; return { response: 1 }; } },
    setTimer: fn => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { win, timers, count: () => count, prompts: () => prompts,
    tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}
test('stalled initial navigation retries finitely then presents a visible recovery action', async () => {
  const f = fixture(); f.tick(); assert.equal(f.count(), 2); f.tick(); assert.equal(f.count(), 3);
  f.tick(); await Promise.resolve(); assert.equal(f.prompts(), 1); assert.equal(f.timers.size, 0);
});
test('successful page load disarms recovery without refreshing later working drafts', () => {
  const f = fixture(); f.win.webContents.emit('did-finish-load');
  assert.equal(f.timers.size, 0); assert.equal(f.count(), 1);
});
test('closing a loading window removes timers and listeners', () => {
  const f = fixture(); f.win.close();
  assert.equal(f.timers.size, 0); assert.equal(f.win.webContents.listenerCount('did-finish-load'), 0);
});
test('rejected navigation retries but stale rejection cannot reload a successfully loaded page', async () => {
  let reject;
  const f = fixture({ load: n => n === 1 ? new Promise((_resolve, r) => { reject = r; }) : new Promise(() => {}) });
  f.tick(); f.win.webContents.emit('did-finish-load'); reject(Object.assign(Error(), { code: 'ERR_ABORTED' }));
  await Promise.resolve(); assert.equal(f.count(), 2); assert.equal(f.timers.size, 0);
});
test('an immediate load failure enters the same bounded recovery path', async () => {
  const f = fixture({ load: () => Promise.reject(Object.assign(Error(), { code: 'ERR_FAILED' })) });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.count(), 3); assert.equal(f.prompts(), 1);
});
