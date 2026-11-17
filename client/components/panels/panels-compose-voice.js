/* 中文需求：两处输入框共用“按住录音、松手识别”，单服务不弹选择框，结果直接追加草稿且不自动发送。
 * 录音只在内存中，松手才允许上传；Esc、取消、失焦、会话/账号切换使结果失效并释放麦克风。
 * 通用服务使用显式 audio 模型；官方 DeepSeek 复用已有服务密钥，由主进程选择专有 ASR 接口。
 * English requirement: share hold-to-record/release-to-transcribe across composers. A single service needs no picker;
 * append transcripts to the draft without auto-sending. Keep audio in memory and upload only after release.
 * Escape, cancellation, blur and session/account changes discard results and release the microphone.
 * Generic services use explicit audio models; main adapts official DeepSeek ASR using existing provider credentials. */
(function (global) {
  'use strict';
  let active = null;
  const en = () => (global.SoduWorkI18n?.getLocale?.() || document.documentElement.lang || '').startsWith('en');
  const t = (zh, english) => en() ? english : zh;
  /* 中文：异步识别期间用户可能继续输入，因此读取回填瞬间的草稿并追加，不能使用开始录音时的旧快照覆盖；input/change 通知现有草稿和布局逻辑。
   * English: The user can type during asynchronous recognition. Append to the draft as it exists at insertion time instead of overwriting it with a recording-start snapshot; emit input/change for existing draft/layout logic. */
  function appendText(input, text) {
    const current = input.value || '';
    input.value = current + (current && !/\s$/.test(current) ? ' ' : '') + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 中文：浏览器通常录成 WebM；转为 16kHz 单声道 PCM WAV 才符合 DeepSeek 格式要求。
  // English: Browsers commonly record WebM; convert to 16kHz mono PCM WAV for DeepSeek compatibility.
  function pcmWav(samples, sampleRate = 16000) {
    const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
    const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => { const x = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true); });
    return bytes;
  }
  /* 中文：只在内存解码和重采样，不把录音写到磁盘，也不播放声音；单声道 16kHz PCM 让两分钟录音仍低于 DeepSeek 8 MiB 限制，finally 关闭音频上下文。
   * English: Decode/resample in memory without disk files or audio playback. Mono 16kHz PCM keeps two minutes below DeepSeek's 8 MiB limit; finally closes the audio context. */
  async function deepseekAudio(blob) {
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!decoded.length || decoded.duration > 120) throw Error(t('录音为空或超过两分钟', 'Recording is empty or exceeds two minutes'));
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      return pcmWav((await offline.startRendering()).getChannelData(0));
    } finally { await context.close(); }
  }
  // 中文：在按下时启动，在全局松手时结束；指针移出按钮也不会漏掉停止事件。
  // English: Start on press and stop on global release, including releases outside the button.
  function bindHold(button, options) {
    if (!button || button.dataset.voiceHoldBound) return;
    button.dataset.voiceHoldBound = 'true';
    /* 中文：held 是本次按压的意图，不等同设备已开始录音。释放后即使权限/设备晚返回也不能启动采集；pointerId 防止另一根手指的松开误停止。
     * English: held describes this press intent, not hardware readiness. Late permission/device responses must not start capture after release; pointerId prevents another pointer from stopping it. */
    let hold = null;
    button.title = button.ariaLabel = t('按住说话，松开识别（Esc 取消）', 'Hold to talk, release to transcribe (Esc cancels)');
    const finish = (cancel = false) => {
      if (!hold) return;
      const current = hold; hold = null; current.held = false; current.onRelease?.(cancel);
      global.removeEventListener('pointerup', pointerUp, true);
      global.removeEventListener('pointercancel', pointerCancel, true);
      global.removeEventListener('blur', pointerCancel);
    };
    /* 中文：松手表示允许识别；pointercancel 或窗口失焦表示取消且不上传。全局捕获监听能处理按钮外松手，结束时移除监听避免重复触发。
     * English: Release authorizes transcription; pointercancel/window blur cancel without uploading. Global capture listeners catch release outside the button and are removed when finished. */
    const pointerUp = event => { if (hold?.pointerId === event.pointerId) finish(); };
    const pointerCancel = () => finish(true);
    function begin(pointerId) {
      if (hold || active) return;
      hold = { held: true, pointerId };
      const value = options();
      void toggle(button, value.input, value.say, value.stillCurrent, hold);
      global.addEventListener('pointerup', pointerUp, true);
      global.addEventListener('pointercancel', pointerCancel, true);
      global.addEventListener('blur', pointerCancel);
    }
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); begin(event.pointerId);
    });
    /* 中文：键盘用户可按住空格/回车操作；忽略自动重复，避免一次长按创建多次录音。阻止默认 click，避免释放后再次切换流程。
     * English: Keyboard users can hold Space/Enter; ignore key repeats to avoid duplicate capture. Suppress default click behavior so release cannot trigger another toggle. */
    button.addEventListener('keydown', event => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault(); if (!event.repeat) begin('keyboard');
    });
    button.addEventListener('keyup', event => {
      if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); finish(); }
    });
    button.addEventListener('click', event => { event.preventDefault(); });
  }
  async function toggle(button, input, say, stillCurrent = () => true, hold = null) {
    if (active) { active.voiceToggle ? active.voiceToggle() : active.focus(); return; }
    if (!input || !global.soduWorkAPI?.voiceInput) { say?.(t('语音输入需要桌面客户端', 'Voice input requires the desktop client')); return; }
    const api = global.soduWorkAPI.voiceInput;
    const dialog = document.createElement('dialog'); dialog.className = 'voice-input-dialog';
    // 中文：模型名、地址和返回文字通过 DOM 属性赋值，避免供应商内容成为可执行 HTML。
    // English: Assign model names, destinations and transcripts through DOM properties, never executable HTML.
    dialog.innerHTML = '<form method="dialog"><header><strong></strong><button type="button" data-close>×</button></header>' +
      '<section data-settings><label data-model-choice>语音识别服务 / Speech recognition service<select name="modelRef"></select></label>' +
      '<label data-language>语言 / Language<select name="language"><option value="">自动 / Auto</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label>' +
      '<button type="button" data-models></button></section>' +
      '<p data-privacy></p><p data-status role="status" aria-live="polite"></p>' +
      '<textarea data-result rows="5" aria-label="识别文字 / Recognized text" hidden></textarea>' +
      '<footer><button type="button" data-record></button><button type="button" data-stop hidden></button><button type="button" data-insert hidden></button><button type="button" data-cancel></button></footer></form>';
    document.body.appendChild(dialog); active = dialog;
    const q = selector => dialog.querySelector(selector), form = q('form'), status = q('[data-status]');
    const record = q('[data-record]'), stop = q('[data-stop]'), insert = q('[data-insert]'), result = q('[data-result]');
    const settings = q('[data-settings]'), modelsButton = q('[data-models]');
    q('strong').textContent = t('语音输入', 'Voice input');
    modelsButton.textContent = t('前往我的模型配置', 'Configure in My models');
    record.textContent = t('开始录音', 'Start recording'); stop.textContent = t('停止并识别', 'Stop and transcribe');
    insert.textContent = t('插入输入框', 'Insert into draft'); q('[data-cancel]').textContent = t('取消', 'Cancel');
    q('[data-close]').ariaLabel = t('关闭', 'Close');
    let closed = false, stream, recorder, chunks = [], bytes = 0, timer, firstFrameTimer, poll, busy = false, configured = false, uploadRequested = false, selectedModel = null;
    /* 中文：识别前后都检查输入框仍存在、可见且仍属原会话。取消不能让迟到结果插入另一页面；轮询还覆盖未发出显式导航事件的卸载。
     * English: Check input existence, visibility and original session before/after recognition. Late results must not reach another page; polling also covers unmounts without explicit navigation events. */
    const valid = () => !closed && input.isConnected && stillCurrent() && input.getClientRects().length > 0;
    /* 中文：按住流程只显示非模态状态和错误轻提示，不在松手后弹出旧语音窗口；错误先清理资源，再保留六秒提示供用户阅读。
     * English: Hold mode uses nonmodal status/errors instead of reopening the old voice dialog on release. Clean up first, then retain the error notification for six seconds. */
    function message(text, error = false) {
      status.textContent = text; status.classList.toggle('error', error);
      indicator.textContent = text; indicator.hidden = dialog.open;
      if (!dialog.open) say?.(text);
      // 中文：按住说话的错误只用轻提示，不重新打开已隐藏的配置/确认弹窗。
      // English: Hold-to-talk errors stay inline instead of reopening a hidden settings/review modal.
      if (error && hold && !closed) {
        close(); indicator.hidden = false; document.body.appendChild(indicator);
        setTimeout(() => indicator.remove(), 6000);
      } else if (error && !closed && !dialog.open) dialog.showModal();
    }
    /* 中文：状态提示使用 aria-live，既支持读屏，也在无弹窗时明确区分准备、授权、设备打开、等待音频帧及识别阶段。
     * English: Use aria-live status to support screen readers and distinguish preparation, consent, device opening, frame arrival and recognition without a modal. */
    const indicator = document.createElement('div'); indicator.className = 'voice-recording-status';
    indicator.setAttribute('role', 'status'); indicator.setAttribute('aria-live', 'polite');
    document.body.appendChild(indicator);
    const originalTitle = button?.title || '', originalLabel = button?.getAttribute('aria-label');
    function escapeRecording(event) { if (event.key === 'Escape' && !dialog.open) { event.preventDefault(); close(); } }
    global.addEventListener('keydown', escapeRecording);

    const pendingWaits = new Set();
    // 中文：系统授权和音频服务可能不返回；取消/超时必须结束等待，迟到的流必须释放。
    // English: OS/audio calls can hang; cancellation and deadlines settle waits and release late streams.
    function waitFor(promise, timeoutMs, timeoutText, dispose = () => {}) {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error, value) => {
          if (done) { if (!error) dispose(value); return; }
          done = true; clearTimeout(deadline); pendingWaits.delete(cancel);
          error ? reject(error) : resolve(value);
        };
        const cancel = () => finish(Error(t('录音已取消', 'Recording cancelled')));
        const deadline = setTimeout(() => finish(Error(timeoutText)), timeoutMs);
        pendingWaits.add(cancel);
        Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
      });
    }
    function controls(locked) { busy = locked; modelsButton.disabled = locked; record.disabled = locked || !configured; settings.querySelectorAll('input,select').forEach(x => { x.disabled = locked; }); }
    /* 中文：释放音轨才能让系统结束麦克风占用；同时清除首帧/时长计时器并恢复按钮，防止取消后仍显示录音中。
     * English: Stop tracks to release OS microphone ownership, clear frame/duration timers and restore the button so cancelled sessions do not appear to keep recording. */
    function release() { clearTimeout(timer); clearTimeout(firstFrameTimer); stream?.getTracks().forEach(track => track.stop()); stream = null; button?.classList.remove('on'); if (button) { button.title = originalTitle; if (originalLabel !== null) button.setAttribute('aria-label', originalLabel); } }
    /* 中文：统一且幂等地关闭所有资源；先标记 closed，再停止 recorder，确保 onstop 不把取消误当成上传授权。取消主进程请求并移除账号/页面事件监听。
     * English: Use one idempotent cleanup path. Set closed before stopping the recorder so onstop cannot mistake cancellation for upload authorization. Abort main-process requests and remove account/page listeners. */
    function close() {
      if (closed) return;
      closed = true; clearInterval(poll); release(); indicator.remove();
      for (const cancel of [...pendingWaits]) cancel();
      if (recorder && ['recording', 'paused'].includes(recorder.state)) recorder.stop();
      chunks = []; void api.cancel();
      if (dialog.open) dialog.close(); dialog.remove(); active = null;
      global.removeEventListener('keydown', escapeRecording);
      global.removeEventListener('soduwork-data-scope-changed', close);
      global.removeEventListener('pagehide', close);
      if (button?.isConnected) button.focus();
    }
    // 中文：模型设置统一由“我的模型”管理，弹窗不再收集或保存服务密钥。
    // English: My models owns configuration; this dialog never collects or stores service credentials.
    function showConfig(config) {
      const models = config.models || [];
      form.elements.modelRef.replaceChildren(...models.map(model => {
        const option = document.createElement('option'); option.value = model.id;
        option.textContent = model.label + ' · ' + model.providerName; return option;
      }));
      configured = models.length > 0;
      // 中文：一个服务直接使用，多个服务才显示选择器；空列表显示指引，避免空白下拉框。
      // English: Use a single service directly; show a picker only for multiple services, guidance for none.
      q('[data-model-choice]').hidden = models.length < 2;
      function destination() {
        const model = models.find(row => row.id === form.elements.modelRef.value);
        selectedModel = model;
        q('[data-language]').hidden = !model || model.protocol === 'deepseek-asr';
        q('[data-privacy]').textContent = model
          ? t('停止并识别后，录音将发送至：', 'Stop and transcribe sends audio to: ') + model.providerName + ' (' + model.url + ')' + t('。识别后可编辑，不自动发送消息。', '. Review the transcript before insertion; no automatic sending.')
          : t('暂无可用的语音识别模型。请前往“我的模型”添加本机服务与模型，用途选择“语音识别”并保存；已有服务可复用地址和 API Key。聊天模型不一定支持语音识别。', 'No speech recognition model available. In My models, add a local service/model, select Speech recognition and save. Existing services reuse their URL and API key. Chat models may not support transcription.');
      }
      form.elements.modelRef.onchange = destination; destination(); controls(false);
    }
    /* 中文：如果松手时 recorder 尚未准备好，直接取消而不是等待授权结束后补录；已开始才执行停止识别，符合用户按压范围。
     * English: If release occurs before the recorder is ready, cancel instead of capturing later after consent resolves. Only a started recorder can stop/transcribe, matching the actual press interval. */
    if (hold) hold.onRelease = cancel => {
      if (cancel || !recorder) close();
      else stop.onclick();
    };
    form.addEventListener('submit', e => e.preventDefault());
    modelsButton.onclick = () => { close(); global.WorkspaceHost?.open('models'); };
    record.onclick = async () => {
      if (busy || !configured) return;
      if (hold && !hold.held) return close();
      controls(true); result.hidden = insert.hidden = true;
      message(t('正在请求麦克风权限…', 'Requesting microphone access…'));
      try {
        if (!navigator.mediaDevices?.getUserMedia || !global.MediaRecorder) throw Error(t('此设备不支持录音', 'Recording is unavailable on this device'));
        /* 中文：分别等待系统授权（主进程 15 秒，页面 16 秒兜底）与设备连接（10 秒）；分阶段提示避免把音频设备卡住误说成权限未授予。
         * English: Wait separately for OS consent (15 seconds in main, 16-second renderer fallback) and device opening (10 seconds). Stage-specific messages avoid misdiagnosing a stalled device as denied consent. */
        const permission = await waitFor(api.permission(), 16000, t('系统授权未响应，请检查系统设置 → 隐私与安全性 → 麦克风', 'Permission did not respond; check System Settings → Privacy & Security → Microphone'));
        if (!valid()) return close();
        if (!permission.ok) throw Error(permission.reason);
        message(t('正在打开麦克风…', 'Opening microphone…'));
        stream = await waitFor(navigator.mediaDevices.getUserMedia({ audio: true, video: false }), 10000,
          t('麦克风设备未响应，请检查系统声音输入设备后重试；外接设备可重新连接', 'Microphone did not respond; check the system input device and reconnect external devices'),
          lateStream => lateStream?.getTracks().forEach(track => track.stop()));
        if (!valid()) { release(); return close(); }
        /* 中文：按当前 Chromium 支持情况选择编码；这里录制与实际播放无关，供应商限制由上传前转换和主进程复验共同保证。
         * English: Select a MIME type supported by this Chromium build. Recording does not require playback; pre-upload conversion and main-process validation jointly enforce provider limits. */
        const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
        if (!mimeType) throw Error(t('没有可用的录音格式', 'No supported recording format'));
        chunks = []; bytes = 0; uploadRequested = false;
        recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = e => {
          if (closed || !e.data.size) return;
          bytes += e.data.size;
          if (bytes > 20 * 1024 * 1024) { recorder.onstop = null; recorder.stop(); release(); chunks = []; stop.hidden = true; controls(false); message(t('录音超过 20 MB，请缩短后重试', 'Recording exceeds 20 MB; try a shorter recording'), true); return; }
          chunks.push(e.data);
          // 中文：MediaRecorder.start 成功不代表硬件产出了音频；CoreAudio 卡住时只有容器头。
          // English: Recorder startup does not prove hardware frames arrived; a stuck CoreAudio stream emits headers only.
          /* 中文：128 字节是针对此次观测到的 110 字节 WebM 空头部的启发式保护，不是通用音频解码器，也不判定用户是否说话；真正格式转换仍需成功解码。
           * English: The 128-byte threshold heuristically rejects the observed 110-byte WebM header; it is not a general decoder or speech detector. Actual format conversion still requires successful decoding. */
          if (firstFrameTimer && bytes > 128) {
            clearTimeout(firstFrameTimer); firstFrameTimer = null;
            message(t('正在录音，松开麦克风开始识别（Esc 取消）', 'Recording; release to transcribe (Esc cancels)'));
          }
        };
        recorder.onerror = () => { recorder.onstop = null; release(); chunks = []; stop.hidden = true; controls(false); message(t('录音失败，请检查麦克风后重试', 'Recording failed; check your microphone'), true); };
        /* 中文：停止可能来自用户松手、时长限制或设备结束；只有显式 uploadRequested 才允许上传，自动停止不会默默发送录音。
         * English: Stopping can result from release, duration limit or device termination. Upload requires explicit uploadRequested; automatic stopping must not silently send audio. */
        recorder.onstop = async () => {
          release(); stop.hidden = true;
          if (closed) return;
          if (!uploadRequested) {
            stop.hidden = false;
            message(t('录音已停止，请点击停止并识别或取消', 'Recording stopped; choose Stop and transcribe or Cancel'));
            return;
          }
          message(t('正在识别，可随时取消…', 'Transcribing; you can cancel…'));
          try {
            const blob = new Blob(chunks, { type: mimeType }); chunks = [];
            if (!blob.size || (mimeType.startsWith('audio/webm') && blob.size <= 128)) throw Error(t('未采集到音频数据；请检查系统声音输入，若持续发生请重启系统音频服务', 'No audio frames captured; check the system input device and restart the system audio service if this persists'));
            /* 中文：主进程提供协议与大小上限，页面只据此选择本机转换；不让页面构造任意服务 URL 或读取 API Key。转换后再检查有效会话，防止取消后上传。
             * English: Main supplies protocol/size metadata used only for local conversion; the renderer cannot choose arbitrary destinations or read keys. Recheck session validity after conversion to prevent upload after cancellation. */
            const isDeepseek = selectedModel?.protocol === 'deepseek-asr';
            const audio = isDeepseek ? await deepseekAudio(blob) : new Uint8Array(await blob.arrayBuffer());
            if (audio.length > (selectedModel?.maxBytes || 20 * 1024 * 1024)) throw Error(t('录音文件过大，请缩短后重试', 'Recording too large; try a shorter recording'));
            if (!valid()) return close();
            const reply = await api.transcribe({ bytes: audio, type: isDeepseek ? 'audio/wav' : mimeType, modelRef: form.elements.modelRef.value, language: form.elements.language.value });
            if (!valid()) return close();
            if (!reply.ok) throw Error(reply.reason);
            // 中文：松手识别后直接追加到当前草稿，用户仍可编辑；绝不自动发送消息。
            // English: On release, append to the current editable draft without sending a message.
            if (hold) { appendText(input, reply.text); close(); input.focus(); return; }
            result.value = reply.text; result.hidden = insert.hidden = false;
            if (!dialog.open) dialog.showModal(); indicator.hidden = true;
            message(t('请检查并编辑文字，再插入输入框', 'Review and edit the text, then insert it into your draft'));
          } catch (error) { if (!closed) message(error.message, true); }
          finally { if (!closed) controls(false); }
        };
        recorder.start(1000); stop.hidden = false; button?.classList.add('on');
        if (button) { button.title = t('松开识别（Esc 取消）', 'Release to transcribe (Esc cancels)'); button.setAttribute('aria-label', button.title); }
        message(t('正在等待麦克风音频数据…', 'Waiting for microphone audio frames…'));
        /* 中文：本次故障表明 getUserMedia 返回和 start 成功仍可能只有空头部：五秒未出现足够数据就取消并提示系统输入异常。此处检测故障，不自动重启系统音频或请求管理员权限。
         * English: This incident showed getUserMedia/start can succeed with header-only output. Cancel after five seconds without sufficient data and report system input failure; this detects failure, never restarts system audio or requests administrator access. */
        firstFrameTimer = setTimeout(() => {
          recorder.onstop = null;
          if (recorder.state === 'recording') recorder.stop();
          release(); chunks = []; stop.hidden = true; controls(false);
          message(t('麦克风未产生音频数据；请检查系统声音输入，或重启系统音频服务后重试', 'Microphone produced no audio frames; check system input or restart the system audio service'), true);
        }, 5000);
        // 中文：到时停止录音但不自动上传，保持“停止并识别”是明确的用户操作。
        // English: At the limit, stop capture without uploading until the user explicitly transcribes.
        timer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 120000);
      } catch (error) {
        release(); stop.hidden = true; controls(false);
        if (!closed) message(['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes(error.name)
          ? t('麦克风不可用或权限被拒绝，请检查设备与系统权限', 'Microphone unavailable or permission denied; check device and system settings') : error.message, true);
      }
    };
    /* 中文：只由明确用户停止/松手设置上传意图；保留 recorder 已自动停止但内存仍有数据时的手动识别入口。
     * English: Only explicit user stop/release grants upload intent. Retain manual transcription when the recorder has already stopped automatically but buffered audio remains. */
    stop.onclick = () => { if (!recorder) return; uploadRequested = true; if (['recording', 'paused'].includes(recorder.state)) recorder.stop(); else if (chunks.length) void recorder.onstop(); };
    insert.onclick = () => { if (!valid()) return close(); if (!result.value.trim()) return; appendText(input, result.value.trim()); close(); input.focus(); };
    q('[data-cancel]').onclick = q('[data-close]').onclick = close;
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    global.addEventListener('soduwork-data-scope-changed', close); global.addEventListener('pagehide', close);
    /* 中文：300ms 检查隐藏或卸载输入框，覆盖会话切换；所有录音在内存内，关闭流程丢弃分片，不保留跨账号或跨会话录音。
     * English: Check for hidden/unmounted inputs every 300ms to cover session changes. Audio stays in memory and cleanup discards chunks rather than carrying recordings across accounts/sessions. */
    poll = setInterval(() => { if (!valid()) close(); }, 300);
    // 中文：单服务自动开始按住录音；无服务/多服务才显示配置或选择窗口，程序化入口保留手动确认兼容。
    // English: A single service starts hold capture directly; show setup/selection only for zero/multiple services. Keep manual review for programmatic callers.
    dialog.voiceToggle = () => {
      if (dialog.open) return dialog.focus();
      if (recorder && !uploadRequested) stop.onclick();
      else if (uploadRequested) close();
    };
    record.disabled = true;
    message(t('正在准备麦克风…', 'Preparing microphone…'));
    try {
      const config = await api.get(); if (closed) return; if (!config.ok) throw Error(config.reason); showConfig(config);
      /* 中文：一个可用服务直接使用；无服务引导我的模型，多个服务要求明确目的地。后两种情况解除本次按压回调，避免松手误触发配置窗口里的操作。
       * English: Use a single available service directly; no service needs setup and multiple services need destination selection. Detach the hold-release callback in those cases so release cannot activate setup controls. */
      if ((config.models || []).length === 1) await record.onclick();
      else { if (hold) hold.onRelease = null; hold = null; indicator.hidden = true; dialog.showModal(); }
    }
    catch (error) { if (!closed) { message(error.message, true); record.disabled = true; } }
  }
  global.ComposeVoice = { toggle, bindHold, appendText, pcmWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeVoice;
})(window);
