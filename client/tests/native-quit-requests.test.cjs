'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), syncFs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {EventEmitter}=require('node:events'), {pathToFileURL}=require('node:url'), vm=require('node:vm');
const fileOpen=require('../main/file-open.cjs'), quitRelaunch=require('../main/quit-relaunch.cjs');
const main=syncFs.readFileSync(path.join(__dirname,'../main.js'),'utf8');

async function setup(t,{ready=true,platform='darwin',quitInitialized=true}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-quit-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=new EventEmitter(), handlers=new Map(), relaunches=[], calls=[];
  app.isReady=()=>ready; app.isPackaged=false; app.getPath=()=>root;
  app.relaunch=options=>relaunches.push(options);
  const createState=()=>quitRelaunch.create(app,{argv:['electron','app','--soduwork-open-file',path.join(root,'earlier.txt')]});
  const state=quitInitialized?createState():undefined;
  const mainFrame={}, sender={mainFrame,isDestroyed:()=>false,send(){},
    getURL:()=>pathToFileURL(path.resolve(__dirname,'../desk.html')).href};
  const hostWindow={isDestroyed:()=>false,webContents:sender};
  const start=main.indexOf('const _workWindows = new Map();'), end=main.indexOf('\nfunction revealWorkWindow(',start);
  assert.ok(start>=0 && end>start,'production file broker remains available');
  const context={app,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},hostWindow,
    _quitRelaunch:state,_sessionIdentity:async()=> 'test-owner',
    revealWorkWindow:()=>calls.push('workspace'),openDeskWindow:()=>calls.push('workspace'),
    require(name){
      if(name==='./main/file-open.cjs')return fileOpen;
      if(name==='./main/quit-relaunch.cjs')return quitRelaunch;
      if(name==='./main/platform-connections/runtime.cjs')return {connectionScope:identity=>identity};
      throw Error('Unexpected broker dependency: '+name);
    },
  };
  const production=vm.runInNewContext(main.slice(start,end)+
    '\n_workWindows.set("workspace",hostWindow);\n({broker:_fileOpen,state:_quitRelaunch})',context);
  const activateStart=main.indexOf("    app.on('activate',"), activateEnd=main.indexOf('\n    });',activateStart);
  assert.ok(activateStart>=0 && activateEnd>activateStart,'production activation handler remains available');
  const activation={
    app,process:{platform},_quitRelaunch:production.state,_overlayFocusAt:0,Date:{now:()=>10000},
    BrowserWindow:{getAllWindows:()=>[]},_desktopOverlay:{createWindow:()=>calls.push('overlay')},
    openDeskWindow:()=>calls.push('workspace'),console,
  };
  vm.runInNewContext(main.slice(activateStart,activateEnd+'\n    });'.length),activation);
  const list=()=>handlers.get('file-open-list')({sender,senderFrame:mainFrame});
  let prevented=0;
  const open=file=>app.emit('open-file',{preventDefault:()=>prevented++},file);
  return {root,app,get state(){return production.state||context._quitRelaunch;},broker:production.broker,calls,relaunches,list,open,
    prevented:()=>prevented,ready:()=>{
      if(!production.state&&!context._quitRelaunch)context._quitRelaunch=createState();
      activation._quitRelaunch=production.state||context._quitRelaunch;
      ready=true;
    }};
}

test('a cold native file request remains queued until the desktop is ready',async t=>{
  const h=await setup(t,{ready:false,quitInitialized:false}), file=path.join(h.root,'cold.txt');
  h.open(file);
  assert.equal(h.prevented(),1); assert.deepEqual(h.calls,[]);
  assert.deepEqual((await h.list()).items.map(row=>row.name),['cold.txt']);
  h.ready(); h.broker.signal(); assert.deepEqual(h.calls,['workspace']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

test('a native file request while running still queues normally and never schedules a restart',async t=>{
  const h=await setup(t), file=path.join(h.root,'running.txt');
  h.open(file);
  assert.equal(h.prevented(),1); assert.deepEqual(h.calls,['workspace']);
  assert.deepEqual((await h.list()).items.map(row=>row.name),['running.txt']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

test('native files received during confirmed quit are handed off once without queuing in the exiting desktop',async t=>{
  const h=await setup(t), a=path.join(h.root,'材料 & first.txt'), b=path.join(h.root,'second.txt');
  h.state.markQuitting(); h.open(a); h.open(b); h.open(a);
  assert.equal(h.prevented(),3);
  assert.deepEqual((await h.list()).items,[]); assert.deepEqual(h.calls,[]);
  assert.deepEqual(h.relaunches,[],'handoff waits until cleanup finishes');
  h.app.emit('will-quit'); h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[a,b]);
});

test('macOS activation during confirmed quit schedules one fresh launch and opens no exiting windows',async t=>{
  const h=await setup(t);
  h.state.markQuitting(); h.app.emit('activate'); h.app.emit('activate');
  assert.deepEqual(h.calls,[]); assert.deepEqual(h.relaunches,[]);
  h.app.emit('will-quit'); h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[]);
});

test('macOS activation while running retains normal overlay and workspace recovery',async t=>{
  const h=await setup(t);
  h.app.emit('activate'); assert.deepEqual(h.calls,['overlay','workspace']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

test('a native file followed by macOS activation keeps its file in the same deferred launch',async t=>{
  const h=await setup(t), file=path.join(h.root,'requested.txt');
  h.state.markQuitting(); h.open(file); h.app.emit('activate');
  assert.deepEqual(h.calls,[]); assert.deepEqual((await h.list()).items,[]);
  h.app.emit('will-quit'); assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[file]);
});

test('activation outside macOS retains the existing overlay fallback during confirmed quit',async t=>{
  for(const platform of ['linux','win32']){
    const h=await setup(t,{platform}); h.state.markQuitting(); h.app.emit('activate');
    assert.deepEqual(h.calls,['overlay']); h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
  }
});
