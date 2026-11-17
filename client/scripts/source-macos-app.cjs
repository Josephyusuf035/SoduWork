'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// A source launch still needs a native bundle identity: app.setName() does not
// change the name macOS shows in the Dock. Only generated copies are branded.
const REVISION = 1;
const ICON_SIZES = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'],
  [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']];
function iconFile(root, size) {
  return size === 1024 ? path.join(root, 'icon.png') : path.join(root, 'build/icons', `${size}x${size}.png`);
}
function icns(root) {
  const chunks = ICON_SIZES.map(([size, type]) => {
    const png = fs.readFileSync(iconFile(root, size));
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw Error('Invalid source application icon');
    }
    const header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
function prepareSourceApp({ root, binary, run = execFileSync }) {
  const source = path.dirname(path.dirname(path.dirname(binary)));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const name = metadata.productName;
  const appId = metadata.build?.appId;
  if (typeof name !== 'string' || !name.trim() || /[\\/:\x00-\x1f]/.test(name) ||
      typeof appId !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(appId)) {
    throw Error('Source application identity is invalid');
  }
  const plist = fs.readFileSync(path.join(source, 'Contents/Info.plist'));
  const icon = icns(root);
  const stat = fs.statSync(binary);
  const sourceId = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ revision: REVISION, name, appId, sourceId,
    version: metadata.version,
    binary: fs.realpathSync(binary), size: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs }))
    .update(plist).update(icon).update(fs.readFileSync(__filename)).digest('hex');
  const cache = path.join(root, '.runtime/source-macos');
  const directory = path.join(cache, digest);
  const bundleName = name + '.app';
  const executable = path.join(directory, bundleName, 'Contents/MacOS/Electron');
  const receipt = path.join(directory, 'source-app.json');
  function ready() {
    try { return fs.existsSync(executable) && JSON.parse(fs.readFileSync(receipt, 'utf8')).digest === digest; }
    catch (_) { return false; }
  }
  if (ready()) return executable;
  fs.mkdirSync(cache, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(cache, '.preparing-'));
  try {
    const bundle = path.join(temporary, bundleName);
    fs.cpSync(source, bundle, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const info = path.join(bundle, 'Contents/Info.plist');
    const value = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { encoding: 'utf8' }));
    // 中文：macOS 需要麦克风用途说明，否则源码启动的录音授权可能被系统拒绝。
    // English: macOS requires a microphone usage description for source-run recording permission.
    /* 中文：package.json 的 extendInfo 只影响打包发布；源码启动另建 .app，必须在其 Info.plist 同样写入用途说明，且不修改原 Electron 包或扩大授权。
     * English: package.json extendInfo affects release packaging only. Source startup creates a separate .app and must write the same purpose string to its Info.plist without modifying the original Electron bundle or widening consent. */
    Object.assign(value, { CFBundleName: name, CFBundleDisplayName: name,
      CFBundleIdentifier: appId + '.source.' + sourceId, CFBundleIconFile: 'soduwork-source.icns',
      NSMicrophoneUsageDescription: 'Record speech only when you start voice input / 仅在主动使用语音输入时录音' });
    if (metadata.version) {
      value.CFBundleShortVersionString = metadata.version;
      value.CFBundleVersion = metadata.version;
    }
    // Keep the Electron executable name so app.isPackaged remains false and
    // source profile, runtime, and update policies cannot become release policies.
    if (value.CFBundleExecutable !== 'Electron') throw Error('Unexpected source Electron executable');
    run('/usr/bin/plutil', ['-convert', 'xml1', '-o', info, '-'], { input: JSON.stringify(value) });
    fs.writeFileSync(path.join(bundle, 'Contents/Resources/soduwork-source.icns'), icon);
    // Ad-hoc signing is strictly for this local development copy. Release
    // packaging continues to enforce its separate Developer ID/notary contract.
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle], { stdio: 'pipe' });
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
    fs.writeFileSync(path.join(temporary, 'source-app.json'), JSON.stringify({ digest, sourceId }));
    try { fs.renameSync(temporary, directory); }
    catch (error) {
      // Concurrent launches may prepare the same immutable bundle. Only use
      // the winner after its completed receipt is visible. Windows reports
      // an existing destination directory as EPERM instead of EEXIST.
      const collision = ['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
        (process.platform === 'win32' && error.code === 'EPERM');
      if (!collision || !ready()) throw error;
    }
    return executable;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { prepareSourceApp, icns };
