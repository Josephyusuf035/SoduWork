'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create, endpoint, MAX_AUDIO } = require('../main/voice-input.cjs');
/* 中文：使用临时目录、合成凭据和可替换模型目录模拟主进程，不读取真实账号、不访问真实语音供应商、不调用麦克风；测试验证协议与安全边界。
 * English: Use temporary directories, synthetic credentials and a replaceable catalog to simulate main without reading real accounts, calling providers or accessing a microphone; verify protocol and trust boundaries. */
function fixture(t, fetchImpl = async () => Response.json({ text: '中文与 API terminology' })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sodu-voice-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let model = { id: 'local:model-test', modality: 'audio', kind: 'openai-compat', name: 'whisper-1', baseUrl: 'https://asr.example/v1', key: 'synthetic-test-credential', providerName: 'Test' };
  const modelStore = { get: () => ({ myModels: model ? [model] : [] }), resolve: ref => ref === model?.id ? model : null };
  const service = create({ modelStore, fetchImpl, platform: 'linux' });
  return { service, dir, setModel: value => { model = value; }, modelStore };

}
test('endpoint normalization preserves version paths and refuses credentials, insecure remote URLs and URL parameters', () => {
  assert.equal(endpoint('https://asr.example/v1/'), 'https://asr.example/v1/audio/transcriptions');
  assert.equal(endpoint('http://127.0.0.1:9000/v1/audio/transcriptions'), 'http://127.0.0.1:9000/v1/audio/transcriptions');
  for (const value of ['http://asr.example/v1', 'https://user:secret@asr.example/v1', 'https://asr.example/v1?key=x', 'https://asr.example/v1#x', 'file:///tmp/asr']) assert.throws(() => endpoint(value));
});
/* 中文：模型删除/改用途后必须立刻不可用，目录不可包含密钥，也不应创建第二份语音凭据文件。
 * English: Model deletion/purpose changes must invalidate speech immediately; public catalogs contain no keys and no duplicate voice credential file is created. */
test('catalog exposes no keys and resolves updated or removed models at request time', async t => {
  const { service, setModel, modelStore, dir } = fixture(t);
  assert.equal(service.get().models.length, 1);
  assert.ok(!JSON.stringify(service.get()).includes('synthetic-test-credential'));
  const current = modelStore.resolve('local:model-test');
  setModel({ ...current, modality: 'chat' });
  assert.deepEqual(service.get().models, []);
  await assert.rejects(service.transcribe(1, { modelRef: current.id }), /我的模型/);
  setModel(null);
  await assert.rejects(service.transcribe(1, { modelRef: current.id }), /我的模型/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
/* 中文：凭据轮换不能依赖重开语音窗口；两次调用必须各自解析最新目录，避免继续使用旧 Key。
 * English: Credential rotation must work without reopening voice UI; each call resolves current catalog credentials instead of a stale key. */
test('credential rotation in My models is applied without saving voice settings', async t => {
  const keys = [];
  const { service, modelStore, setModel } = fixture(t, async (_url, options) => {
    keys.push(options.headers.Authorization); return Response.json({ text: 'ok' });
  });
  const payload = { modelRef: 'local:model-test', bytes: new Uint8Array([1]), type: 'audio/webm' };
  await service.transcribe(1, payload);
  setModel({ ...modelStore.resolve(payload.modelRef), key: 'synthetic-rotated-credential' });
  await service.transcribe(1, payload);
  assert.deepEqual(keys, ['Bearer synthetic-test-credential', 'Bearer synthetic-rotated-credential']);
});
test('transcription uses multipart audio, selected model/language, JSON text and a nonredirecting request', async t => {
  let calls = 0;
  const { service } = fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://asr.example/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-credential');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('model'), 'whisper-1');
    assert.equal(options.body.get('language'), 'zh');
    assert.equal(options.body.get('response_format'), 'json');
    assert.deepEqual(new Uint8Array(await options.body.get('file').arrayBuffer()), new Uint8Array([1, 2, 3]));
    return Response.json({ text: '  中文与 API terminology  ' });
  });
  assert.deepEqual(await service.transcribe(1, { modelRef: 'local:model-test', language: 'zh', bytes: new Uint8Array([1, 2, 3]), type: 'audio/webm;codecs=opus' }), { text: '中文与 API terminology' });
  assert.equal(calls, 1);
});
test('invalid audio is rejected before a request and configuration is required', async t => {
  let calls = 0; const { service } = fixture(t, async () => { calls++; return Response.json({ text: 'x' }); });
  await assert.rejects(service.transcribe(1, {}), /配置/);
  for (const payload of [{ bytes: new Uint8Array(), type: 'audio/webm' }, { bytes: new Uint8Array(MAX_AUDIO + 1), type: 'audio/webm' }, { bytes: [1], type: 'audio/webm' }, { bytes: new Uint8Array([1]), type: 'text/plain' }]) await assert.rejects(service.transcribe(1, { ...payload, modelRef: 'local:model-test' }));
  assert.equal(calls, 0);
});
test('cancellation aborts only its own request and blocks duplicate uploads from one window', async t => {
  const { service } = fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('private transport error')))));
  const audio = { modelRef: 'local:model-test', bytes: new Uint8Array([1]), type: 'audio/webm' };
  const first = service.transcribe(1, audio), second = service.transcribe(2, audio);
  await assert.rejects(service.transcribe(1, audio), /正在识别/);
  service.cancel(1); await assert.rejects(first, /取消/);
  service.cancel(2); await assert.rejects(second, /取消/);
});
test('provider failures, empty text and excessive responses do not become successful transcripts or expose response bodies', async t => {
  for (const response of [new Response('private provider body', { status: 401 }), Response.json({ text: '' }), new Response('not JSON'), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const { service } = fixture(t, async () => response);
      await assert.rejects(service.transcribe(1, { modelRef: 'local:model-test', bytes: new Uint8Array([1]), type: 'audio/webm' }), error => !error.message.includes('private provider body'));
  }
});
test('voice IPC refuses remote pages and subframes; only the workspace main frame can read settings', async t => {
  const Module = require('node:module'), original = Module._load;
  const handlers = new Map(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sodu-voice-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wc = { id: 7, getURL: () => 'file:///synthetic/desk.html' };
  wc.mainFrame = { url: wc.getURL() };
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const electron = { app: { getPath: () => dir }, safeStorage: {}, net: {}, systemPreferences: {},
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { fromWebContents: () => ({ webContents: wc }) } };
  try { Module._load = (name, ...args) => name === 'electron' ? electron : original.call(Module, name, ...args);
    require('../main/voice-input.cjs').install({ getRendererRoot: () => '/synthetic' });
  } finally { Module._load = original; }
  assert.equal((await handlers.get('voice-input-get')(event)).ok, true);
  assert.equal((await handlers.get('voice-input-get')({ ...event, senderFrame: { url: wc.getURL() } })).ok, false);
  wc.getURL = () => 'https://untrusted.example/desk.html'; wc.mainFrame.url = wc.getURL();
  assert.equal((await handlers.get('voice-input-get')(event, {})).ok, false);
});

/* 中文：回归用户场景：已配两个聊天模型仍自动只有一个 DeepSeek ASR 服务；请求仅带 file，不能误发聊天模型名、语言参数或 WebM。
 * English: Regress the reported case: multiple saved chat models yield one DeepSeek ASR service, with file-only requests rather than chat-model names, language fields or WebM. */
test('DeepSeek chat configuration supplies one ASR service and file-only native requests', async t => {
  let calls = 0;
  const { service, setModel, modelStore } = fixture(t, async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/v1/tools/asr');
    assert.deepEqual([...options.body.keys()], ['file']);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-credential');
    assert.equal(options.body.get('file').type, 'audio/wav');
    return Response.json({ text: '识别结果' });
  });
  const model = { ...modelStore.resolve('local:model-test'), baseUrl: 'https://api.deepseek.com', modality: 'chat', provider: 'deepseek' };
  setModel(model);
  modelStore.get = () => ({ myModels: [model, { ...model, id: 'local:second-chat' }] });
  modelStore.resolve = ref => ref === model.id || ref === 'local:second-chat' ? { ...model, id: ref } : null;
  assert.equal(service.get().models.length, 1);
  assert.equal(service.get().models[0].protocol, 'deepseek-asr');
  const payload = { modelRef: model.id, bytes: new Uint8Array([1]), type: 'audio/wav', language: 'zh' };
  assert.deepEqual(await service.transcribe(1, payload), { text: '识别结果' });
  await assert.rejects(service.transcribe(1, { ...payload, type: 'audio/webm' }), /WAV/);
  await assert.rejects(service.transcribe(1, { ...payload, bytes: new Uint8Array(8 * 1024 * 1024 + 1) }), /8 MiB/);
  assert.equal(calls, 1);
  modelStore.resolve = () => null;
  await assert.rejects(service.transcribe(1, payload), /我的模型/);
});
test('DeepSeek routing never trusts renamed providers or lookalike hosts', () => {
  const { deepseekEndpoint } = require('../main/voice-input.cjs');
  assert.equal(deepseekEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/tools/asr');
  for (const url of ['https://api.deepseek.com.evil.example/v1', 'https://proxy.example/v1', 'http://api.deepseek.com', 'https://user@api.deepseek.com', 'https://api.deepseek.com/custom', 'https://api.deepseek.com?key=x']) assert.equal(deepseekEndpoint(url), null);
});
/* 中文：验证 WAV 头、采样率和有符号样本截断，避免只有文件扩展名变为 WAV 而实际编码仍不兼容。
 * English: Validate WAV headers, sample rate and signed sample clipping; renaming a recording to WAV must not masquerade as actual encoding conversion. */
test('PCM conversion emits clipped mono 16-bit WAV samples with correct headers', () => {
  const vm = require('node:vm'), context = { window: {}, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-voice.js'), 'utf8'), context);
  const bytes = context.module.exports.pcmWav(new Float32Array([-2, 0, 2]));
  const view = new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes).toString('ascii', 0, 4), 'RIFF');
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(46, true), 0); assert.equal(view.getInt16(48, true), 32767);
});

/* 中文：覆盖已允许、拒绝、尚未决定三种授权状态；已允许不得再次 ask，避免重复系统请求造成假性等待。
 * English: Cover granted, denied and undecided consent; granted permission must not call ask again and create misleading waits. */
test('macOS permission skips the OS request when already granted and rejects denied access', async () => {
  let calls = 0;
  const systemPreferences = { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => { calls++; return true; } };
  const service = create({ platform: 'darwin', systemPreferences });
  assert.equal(await service.permission(), true); assert.equal(calls, 0);
  systemPreferences.getMediaAccessStatus = () => 'denied';
  assert.equal(await service.permission(), false); assert.equal(calls, 0);
  systemPreferences.getMediaAccessStatus = () => 'not-determined';
  assert.equal(await service.permission(), true); assert.equal(calls, 1);
});
