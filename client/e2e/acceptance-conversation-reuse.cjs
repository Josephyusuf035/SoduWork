'use strict';
// NativeChat, archive recovery, review metadata and composer submission stay production code.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', timeout: 180000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-reuse-'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const report = { ok: false, platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome,
  checks: [], errors: [], network: [], cleanup: { ok: false },
  boundary: 'Real Electron Chromium, production TaskTraceApproval.openAcceptance, TaskConversationNavigation, NativeChat, TaskController, SessionController, composer controls, DOM bindings and message renderer. Mouse/keyboard input is native Chromium input. Hub, model catalogs, archive snapshots, native conversation IPC and account identity are synthetic. Unrelated shell and collaboration surfaces use existing fixture doubles. No provider inference, real SDK/Runner, main-process archive synchronization, approval persistence, remote executor or Windows validation.' };
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => js(`({calls,errors,toasts,info:NativeChat.sessionInfo(),session:fixtureContext?._sessionOptions,
  snapshot:fixtureContext?._snap,input:document.querySelector('#nchatInput')?.value,body:document.body.innerText})`);
async function until(code, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(code)) return; await delay(20); }
  throw Error('Timed out: ' + code + '\nState: ' + JSON.stringify(await state()));
}
async function click(selector) {
  const previous = await js('clicks.length');
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');
    e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(e.disabled||!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control unavailable');return p})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await until('clicks.length>' + previous);
}
async function screenshot(name) {
  const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
app.whenReady().then(async () => {
  try {
    const css = [...read('desk.html').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(match => match[1]);
    const html = path.join(temporary, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + css.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:0;padding:20px;background:#fafafa}#composePanel{height:900px;display:block}#cpChat{display:block;height:100%}.nchat{height:100%}</style>' +
      '</head><body><main id="composePanel"><div id="cpChat"></div></main></body></html>');
    win = new BrowserWindow({ show: false, width: 1360, height: 1020,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (request, done) => { report.network.push(request.url); done({ cancel: true }); });
    await win.loadFile(html); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await require('./lib/conversation-send-harness.cjs').install(win, read, ['chat-work-intent']);
    await js(read('core/task-conversation-navigation.js') + '\nvoid 0;');
    await js(read('core/requirements.js') + '\nvoid 0;');
    await js(read('components/panels/task-trace-approval.js') + '\nvoid 0;');
    const runtimes = ['pi', 'qwen', 'opencode', 'dsh', 'kimi', 'codex-harness', 'codex'];
    await js(`window.runtimeRows=${JSON.stringify(runtimes)}.map(id=>({id,displayName:id,
        modelMode:['codex'].includes(id)?'account':'managed'}));
      low.runtimes=async()=>({ok:true,runtimes:runtimeRows,availableRuntimes:runtimeRows});low.conversationRuntimes=low.runtimes;
      low.history=async()=>{calls.push({kind:'history'});return {ok:true,chats:[]};};
      window.liveId='';window.liveRef='';window.liveMessages=[];
      idle=()=>({status:'idle',messages:structuredClone(liveMessages),tools:[],adapterId:runtimeId,
        execution:{running:false,taskExecutions:[]},modelSelection:{name:model.id,model}});
      low.open=async options=>{calls.push({kind:'open',options:structuredClone(options)});
        if(options.chatId===originalId&&archiveState!=='exists')return {ok:false,notFound:archiveState==='missing',
          code:archiveState==='missing'?'SESSION_NOT_FOUND':'ACCOUNT_HISTORY_UNAVAILABLE',
          reason:archiveState==='missing'?'Original archive is missing':'Original archive temporarily unavailable'};
        liveId=options.chatId||'replacement-'+task.id;liveRef='ref-'+liveId;
        liveMessages=options.chatId===originalId?[{role:'user',text:'Original execution instruction'},
          {role:'assistant',blocks:[{kind:'text',text:'Original delivery evidence for '+task.id}],done:true}]:[];
        return {ok:true,ref:liveRef,sessionId:liveId,adapterId:runtimeId,model,snapshot:idle(),taskIds:[task.id],
          ...(options.acceptanceSession?{acceptanceSession:{taskRef:task.id,approvalId:options.approvalId,acceptanceMode:options.acceptanceMode}}:{})};};
      low.send=async(ref,text,attachments,options)=>{calls.push({kind:'send',ref,sessionId:liveId,text,
          options:structuredClone(options),adapterId:runtimeId,model:model.id,history:structuredClone(liveMessages)});
        liveMessages.push({role:'user',text});return {ok:true,snapshot:idle()};};
      SoduWorkAPI.approvalDetail=async id=>{calls.push({kind:'approval-detail',id});return {item:{id,action:'review',status:'pending',assignment:{userId:'fixture-owner'}}};};
      SoduWorkAPI.getAcceptanceContext=async id=>{calls.push({kind:'acceptance-context',id});return {criteria:['Verify the saved delivery'],artifactVersionId:'frozen-artifact-'+id};};
      window.openReview=()=>TaskTraceApproval.openAcceptance(task,{approvalId:'approval-'+task.id,acceptanceMode:reviewOptions.acceptanceMode})
        .then(()=>true,error=>{window.navigationError=String(error.message);return false;});
      window.__teamCap={meId:'fixture-owner'};void 0;`);
    for (const runtime of runtimes) for (const mode of ['manual', 'auto']) for (const availability of ['exists', 'missing', 'unreadable']) {
      const id = runtime + '-' + mode + '-' + availability;
      const model = ['codex'].includes(runtime)
        ? { id: runtime + '-account-model', label: runtime + ' account model' }
        : { id: 'local:model-' + 'd'.repeat(32), label: 'Private review model', localOnly: true };
      await js(`NativeChat.reset();calls=[];toasts=[];errors=[];modelCalls=0;catalogMode='ok';
        window.runtimeId=${JSON.stringify(runtime)};window.archiveState=${JSON.stringify(availability)};model=${JSON.stringify(model)};
        task={id:${JSON.stringify(id)},title:'Review saved evidence',kind:'requirement',status:'done',requirementStage:'reviewing',canViewExecution:true,canReview:true,myRoles:['creator','executor'],
          createdBy:'fixture-owner',assigneeUserId:'fixture-owner',acceptanceCriteria:['Verify the saved delivery'],
          workRouting:{conversationTurn:{conversationId:'original-'+${JSON.stringify(id)},state:'completed',executor:'native'}}};
        window.originalId=task.workRouting.conversationTurn.conversationId;
        window.reviewOptions={source:'acceptance',chatId:originalId,acceptanceSession:false,reuseExecutionSession:true,
          acceptanceExecutionSession:true,acceptanceMode:${JSON.stringify(mode)},approvalId:'approval-'+task.id,
          sessionOptions:{adapterId:runtimeId,modelName:model.id}};void 0;`);
      await js('fixtureContext._sessionOptions={adapterId:runtimeId,modelName:model.id};void 0;');
      const opened = await js('openReview()');
      if (opened && availability==='exists')
        await until(`document.body.innerText.includes(${JSON.stringify('Original delivery evidence for '+id)})`);
      const actual = await state(), opens = actual.calls.filter(row => row.kind === 'open');
      assert.equal(opens[0].options.chatId, 'original-' + id, 'A paginated empty history must still open the exact original archive');
      assert.equal(actual.calls.filter(row => row.kind === 'send').length, 0);
      assert.equal(actual.calls.filter(row => row.kind === 'approval-detail').length, 1);
      assert.equal(actual.calls.filter(row => row.kind === 'acceptance-context').length, 1,
        'Manual analysis and automatic acceptance both read the authoritative review context before navigation');
      if (availability === 'unreadable') {
        assert.equal(opened, false); assert.equal(opens.length, 1, 'A failed archive read must not create another conversation');
        assert.equal(actual.snapshot.sessionNotFound, false); assert.equal(actual.snapshot.sessionOpenCode, 'ACCOUNT_HISTORY_UNAVAILABLE');
        await click('#nchatInput'); await until("document.activeElement?.id==='nchatInput'");
        await win.webContents.insertText('Keep the review draft while the archive is unavailable');
        for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
        await delay(40);
        assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
        assert.equal(await js('calls.filter(row=>row.kind==="open").length'), 1);
        assert.match(await js('document.querySelector("#nchatInput").value'), /Keep the review draft/);
        await until(`document.querySelector('.nbad.show')?.textContent.includes('Original archive temporarily unavailable')`);
        assert.match(await js('document.body.innerText'), /Original archive temporarily unavailable/);
        assert.equal(await js('Boolean(document.querySelector("[data-session-retry]"))'), true);
        await js("archiveState='exists';void 0;");
        assert.equal(await js('openReview()'), true, 'A new explicit review attempt may reopen the original once it becomes readable');
        assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'original-' + id);
        assert.equal(await js('calls.filter(row=>row.kind==="open").at(-1).options.chatId'), 'original-' + id);
        await click('#nchatSend');
        await until(`calls.filter(row=>row.kind==='send').length===1&&fixtureContext._sendState==='idle'`);
        const recovered = await js('calls.find(row=>row.kind==="send")');
        assert.equal(recovered.sessionId, 'original-' + id); assert.equal(recovered.options.taskId, id);
        assert.equal(recovered.options.taskExecution.acceptanceOnly, true);
        assert.equal(recovered.options.taskExecution.acceptanceMode, mode);
        assert.equal(recovered.options.taskExecution.approvalId, 'approval-' + id);
        assert.equal(recovered.history.length, 2);
      } else {
        assert.equal(opened, true); assert.equal(opens.length, availability === 'exists' ? 1 : 2);
        const expectedId = availability === 'exists' ? 'original-' + id : 'replacement-' + id;
        assert.equal(actual.info.sessionId, expectedId); assert.equal(actual.info.adapterId, runtime); assert.equal(actual.info.model, model.id);
        if (availability === 'missing') assert.equal(opens[1].options.chatId, undefined);
        assert.equal(actual.session.acceptanceExecutionSession, availability === 'exists');
        assert.equal(actual.session.acceptanceSession, availability === 'missing');
        assert.ok(actual.input.startsWith(mode === 'auto' ? '【自动验收】' : '【验收分析】'));
        if (availability === 'exists') assert.match(actual.body, /Original delivery evidence/);
        await click('#nchatSend');
        await until(`calls.filter(row=>row.kind==='send').length===1&&fixtureContext._sendState==='idle'`);
        const sent = await js('calls.find(row=>row.kind==="send")');
        assert.equal(sent.sessionId, expectedId); assert.equal(sent.ref, 'ref-' + expectedId);
        assert.equal(sent.adapterId, runtime); assert.equal(sent.model, model.id);
        assert.equal(sent.options.taskId, id); assert.equal(sent.options.taskExecution.acceptanceOnly, true);
        assert.equal(sent.options.taskExecution.acceptanceMode, mode); assert.equal(sent.options.taskExecution.approvalId, 'approval-' + id);
        assert.equal(sent.options.taskExecution.acceptanceExecutionSession === true, availability === 'exists');
        assert.equal(sent.history.length, availability === 'exists' ? 2 : 0);
        assert.equal(await js('modelCalls>0'), !['codex'].includes(runtime));
        assert.equal(await js('openTaskConversation(task.id,task.title,reviewOptions)'), true);
        assert.equal(await js('NativeChat.sessionInfo().sessionId'), expectedId, 'Repeated review opens must keep the confirmed archive');
        assert.equal(await js('calls.filter(row=>row.kind==="open").length'), opens.length);
        assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 1, 'Reopening review never sends another turn automatically');
      }
      assert.deepEqual(await js('errors'), []);
      if (runtime === 'pi' && mode === 'auto' && availability === 'exists') {
        await js(`document.querySelector('#nchatInput').value='Keep my unrelated draft';void 0;`);
        assert.equal(await js(`TaskTraceApproval.openAcceptance(task,{approvalId:'approval-'+task.id,acceptanceMode:'auto',startAcceptance:true})`), true);
        assert.equal(await js(`calls.filter(row=>row.kind==='send').length`), 2);
        assert.match(await js(`calls.filter(row=>row.kind==='send').at(-1).text`), /自动验收/);
        assert.equal(await js(`document.querySelector('#nchatInput').value`), 'Keep my unrelated draft');
        assert.equal(await js(`TaskTraceApproval.openAcceptance(task,{approvalId:'approval-'+task.id,acceptanceMode:'auto',startAcceptance:true})`), true);
        assert.equal(await js(`calls.filter(row=>row.kind==='send').length`), 2, 'Repeated start shares the accepted submission');
        await js(`NativeChat.reset();calls=[];catalogMode='reject';void 0;`);
        const start = `TaskTraceApproval.openAcceptance(task,{approvalId:'approval-'+task.id,acceptanceMode:'auto',startAcceptance:true,acceptanceInstruction:'Fresh automatic review'})`;
        await assert.rejects(js(start), /验收会话未能打开|自动验收未能提交/);
        assert.equal(await js(`calls.filter(row=>row.kind==='send').length`), 0);
        await js(`catalogMode='ok';void 0;`);
        assert.equal(await js(start), true, 'A failed startup must remain retryable');
        assert.equal(await js(`calls.filter(row=>row.kind==='send').length`), 1);
      }
      report.checks.push({ runtime, mode, archive: availability, ok: true });
      console.log('PASS ' + id);
    }
    assert.deepEqual(report.network, []); await screenshot('final'); report.ok = true;
  } catch (error) {
    report.errors.push(error.stack || String(error));
    try { report.failureState = await state(); await screenshot('failure'); } catch (failure) { report.errors.push(String(failure)); }
  } finally {
    try { win?.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); report.cleanup.ok = true; }
    catch (error) { report.cleanup.error = String(error); report.ok = false; }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, errors: report.errors }));
    app.exit(report.ok ? 0 : 1);
  }
});
