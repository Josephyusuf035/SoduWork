'use strict';
// 中文：密钥和网络请求留在主进程；渲染器仅获得公开配置与识别文字。
// English: Keep credentials and networking in main; return only public settings and transcripts.
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const MAX_AUDIO = 20 * 1024 * 1024;
/* 中文：通用转录服务沿用服务的版本路径并追加标准接口；拒绝 URL 内嵌凭据、查询参数和远程明文 HTTP，避免错误目的地址与凭据泄露。
 * English: Preserve the provider version path and append the standard transcription endpoint. Reject embedded credentials, query parameters and remote plaintext HTTP to avoid wrong destinations and credential exposure. */
function endpoint(value) {
  const url = new URL(String(value || '').trim());
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw Error('Use HTTPS, or HTTP on localhost / 请使用 HTTPS 或本机 HTTP 地址');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/audio/transcriptions')) url.pathname += '/audio/transcriptions';
  return url.href;
}
// 中文：只为官方 DeepSeek 地址启用专有接口，不能仅凭服务名称猜测兼容能力。
// English: Enable the native adapter only for the official DeepSeek origin, never by provider display name.
function deepseekEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash ||
        !['', '/', '/v1', '/v1/'].includes(url.pathname)) return null;
    return 'https://api.deepseek.com/v1/tools/asr';
  } catch (_) { return null; }
}
function create({ modelStore = require('./local-model-store.cjs'), fetchImpl, systemPreferences, platform = process.platform }) {
  const pending = new Map();
  // 中文：只传公开模型引用，识别时重新解析凭据，避免重复保存密钥或使用已删除的模型。
  // English: Expose public references only; resolve current credentials per request, avoiding duplicate secrets and stale models.
  /* 中文：需求：已有官方 DeepSeek 聊天服务即可语音输入。以服务 ID 去重，两个聊天模型仅产生一个 ASR 入口；其他供应商必须显式配置 audio，不能由兼容聊天协议推断转录能力。
   * English: Requirement: existing official DeepSeek chat services enable voice input. Deduplicate by provider ID so multiple chat models yield one ASR entry; other providers require explicit audio entries because chat compatibility does not imply transcription support. */
  function get() {
    const catalog = modelStore.get();
    const seen = new Set();
    return { models: (catalog.myModels || []).flatMap(row => {
      const model = modelStore.resolve(row.id);
      if (!model || model.kind !== 'openai-compat') return [];
      const nativeUrl = deepseekEndpoint(model.baseUrl);
      if (!nativeUrl && row.modality !== 'audio') return [];
      if (nativeUrl && seen.has(model.provider)) return [];
      try {
        const url = nativeUrl || endpoint(model.baseUrl);
        if (nativeUrl) seen.add(model.provider);
        return [{ id: row.id, label: nativeUrl ? 'DeepSeek 语音识别 / Speech recognition' : row.label || row.name,
          providerName: model.providerName, url, protocol: nativeUrl ? 'deepseek-asr' : 'openai',
          maxBytes: nativeUrl ? 8 * 1024 * 1024 : MAX_AUDIO }];
      } catch (_) { return []; }
    }) };
  }

  /* 中文：每次上传重新解析引用及最新凭据，删除模型/密钥后不得使用旧副本；同一窗口只允许一个在途请求，不同窗口的取消互不影响。
   * English: Resolve the reference and latest credentials on every upload so deleted models/keys cannot use stale copies. Permit one in-flight request per window and isolate cancellation between windows. */
  async function transcribe(owner, raw) {
    if (pending.has(owner)) throw Error('Recognition already running / 正在识别，请稍候');
    const model = typeof raw?.modelRef === 'string' && raw.modelRef.startsWith('local:') ? modelStore.resolve(raw.modelRef) : null;
    const nativeUrl = model && deepseekEndpoint(model.baseUrl);
    if (!model || (!nativeUrl && model.modality !== 'audio') || model.kind !== 'openai-compat')
      throw Error('Configure a speech recognition model in My models / 请在我的模型配置可用的语音识别模型');
    const language = String(raw?.language || '');
    if (!/^(?:[a-z]{2,3})?$/.test(language)) throw Error('Invalid language / 语言设置无效');
    const config = { url: model.baseUrl, model: model.name, key: model.key, language };
    /* 中文：渲染器输入不可信：主进程独立验证字节类型、大小和 MIME；DeepSeek 的 8 MiB/WAV-Ogg 限制另行校验，不能只依赖前端转换。
     * English: Renderer input is untrusted: validate byte type, size and MIME again in main. Enforce DeepSeek-specific 8 MiB/WAV-Ogg limits independently of renderer conversion. */
    const bytes = raw?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_AUDIO)
      throw Error('Audio must be between 1 byte and 20 MB / 录音为空或超过 20 MB');
    const type = String(raw?.type || '').split(';')[0];
    if (!['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav'].includes(type)) throw Error('Unsupported audio / 不支持的音频格式');
    // 中文：DeepSeek 接受 PCM WAV/Ogg，且只接收 file，不使用聊天模型名或语言参数。
    // English: DeepSeek accepts PCM WAV/Ogg and a file-only form, without a chat model or language field.
    if (nativeUrl && (bytes.length > 8 * 1024 * 1024 || !['audio/wav', 'audio/ogg'].includes(type)))
      throw Error('DeepSeek requires WAV/Ogg audio up to 8 MiB / DeepSeek 需要不超过 8 MiB 的 WAV/Ogg 录音');
    const control = new AbortController(); pending.set(owner, control);
    /* 中文：90 秒超时覆盖上传与读取响应；禁止重定向，避免 Authorization 或录音被服务跳转到其他目的地。finally 总是释放请求记录和计时器。
     * English: The 90-second deadline covers upload and response reading. Reject redirects to keep credentials/audio from redirected destinations; finally always clears the timer and request ownership. */
    const timer = setTimeout(() => control.abort(), 90000);
    try {
      const form = new FormData();
      form.set('file', new Blob([bytes], { type }), 'recording.' + ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/wav': 'wav' }[type]));
      if (!nativeUrl) {
        form.set('model', config.model); form.set('response_format', 'json');
        if (config.language) form.set('language', config.language);
      }
      const response = await fetchImpl(nativeUrl || endpoint(config.url), { method: 'POST', headers: config.key ? { Authorization: 'Bearer ' + config.key } : {}, body: form, redirect: 'error', signal: control.signal });
      if (!response.ok) throw Error('Speech service HTTP ' + response.status + ' / 识别服务请求失败（' + response.status + '）');
      /* 中文：只接受有界 JSON 文字结果；不把供应商原始错误响应透传给页面，以免包含请求凭据、音频内容或其他私密数据。
       * English: Accept only bounded JSON text results. Do not relay raw provider error bodies to the renderer, which could contain credentials, audio content or private data. */
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 1024 * 1024) throw Error('Recognition response too large / 识别结果过大');
        chunks.push(Buffer.from(chunk));
      }
      let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw Error('Invalid recognition response / 识别服务未返回有效 JSON'); }
      if (typeof result.text !== 'string' || !result.text.trim()) throw Error('No speech recognized / 未识别到语音，请重试');
      return { text: result.text.trim() };
    } catch (error) {
      if (control.signal.aborted) throw Error('Recognition cancelled or timed out / 识别已取消或超时');
      // 中文：不透传供应商响应或网络异常，避免错误信息携带凭据或录音内容。
      // English: Do not relay provider bodies or transport errors that might contain private data.
      if (/ \/ /.test(error.message)) throw error;
      throw Error('Cannot connect to speech service / 无法连接语音识别服务，请检查地址与网络');
    } finally { clearTimeout(timer); if (pending.get(owner) === control) pending.delete(owner); }
  }
  return { get,
    cancel: owner => { pending.get(owner)?.abort(); }, transcribe,
    permission: async () => {
      if (platform !== 'darwin') return true;
      // 中文：已授权时不要重复进入系统授权请求，拒绝时明确引导系统设置。
      // English: Avoid repeat OS prompts when granted; denied access must be changed in System Settings.
      /* 中文：需求：不能一直停在请求权限。已允许直接继续，拒绝/受限立即返回；未决定才请求系统授权，并用 15 秒截止保护无法返回的系统调用。
       * English: Requirement: never wait indefinitely on permission. Continue immediately when granted, reject denied/restricted access, and request OS consent only when undecided with a 15-second deadline. */
      const status = systemPreferences.getMediaAccessStatus?.('microphone');
      if (status === 'granted') return true;
      if (status === 'denied' || status === 'restricted') return false;
      let timer;
      try { return await Promise.race([systemPreferences.askForMediaAccess('microphone'),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Microphone permission timed out; check System Settings → Privacy & Security → Microphone / 麦克风授权超时，请检查系统设置 → 隐私与安全性 → 麦克风')), 15000); })]); }
      finally { clearTimeout(timer); }
    } };
}
function install({ getRendererRoot }) {
  const { app, BrowserWindow, ipcMain, safeStorage, net, systemPreferences } = require('electron');
  const service = create({ app, safeStorage, systemPreferences, fetchImpl: (...args) => net.fetch(...args) });
  /* 中文：只接受真实工作区窗口的 desk.html 主框架；远程页面、子框架及其他本地页面不能借 IPC 调用麦克风授权或使用模型密钥。
   * English: Accept only the desk.html main frame of a real workspace window; remote pages, subframes and other local pages cannot use IPC to request microphone access or use model credentials. */
  function trusted(event) {
    try {
      const wc = event.sender, win = BrowserWindow.fromWebContents(wc), url = new URL(wc.getURL());
      return win && win.webContents === wc && event.senderFrame === wc.mainFrame && event.senderFrame.url === wc.getURL() && url.protocol === 'file:' &&
        path.resolve(fileURLToPath(url)) === path.resolve(getRendererRoot(), 'desk.html');
    } catch (_) { return false; }
  }
  for (const action of ['get', 'cancel', 'transcribe', 'permission']) {
    ipcMain.handle('voice-input-' + action, async (event, data) => {
      if (!trusted(event)) return { ok: false, reason: 'Voice input is only available in the workspace' };
      try {
        if (action === 'transcribe') {
          /* 中文：窗口销毁后中止上传，防止已经关闭的页面留下网络任务；请求结束时移除监听，避免多次识别积累 destroyed 监听器。
           * English: Abort uploads when their window is destroyed so closed pages leave no background requests; remove the listener after completion to avoid accumulating destroyed listeners. */
          const cancel = () => service.cancel(event.sender.id);
          event.sender.once('destroyed', cancel);
          try { return { ok: true, ...await service.transcribe(event.sender.id, data) }; }
          finally { if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', cancel); }
        }
        if (action === 'cancel') { service.cancel(event.sender.id); return { ok: true }; }
        if (action === 'permission') return { ok: await service.permission(), reason: 'Microphone permission denied / 麦克风权限被拒绝，请检查系统设置' };
        return { ok: true, ...service[action](data) };
      } catch (error) { return { ok: false, reason: error.message }; }
    });
  }
}
module.exports = { create, endpoint, deepseekEndpoint, MAX_AUDIO, install };
