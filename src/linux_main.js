'use strict';
// Linux entry point: command-line tools, root-folder resource overlay, built-in HID driver, then the original UI.
const { app } = require('electron');
const path = require('path');
const tools = require('./linux_driver/tools');

const argv = process.argv.slice(1);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };

const HELP = `Firstblood Driver (Linux)

Usage: Firstblood-Driver-linux-x86_64.AppImage [options]

All major graphics (logos, background, device pictures, main icon) come from the Windows install: place the
AppImage inside the Windows "Firstblood Driver" folder (the one containing resources/app/company), or bake them
in with --absorb-windows-files to get a portable copy. Without either, those pictures are simply missing.

  --root <folder>              use this folder instead of the AppImage's own folder
  --absorb-windows-files       copy the Windows pictures and main icon INTO a new AppImage
                               (<name>-portable.AppImage next to this one), so the Windows folder is no longer needed
      --output <file>          where to write that new AppImage
  --purge-windows-files        delete Windows-only files in the root folder that the Linux build does not need
                               (matched by their known file names; company/ resources are always kept)
      --dry-run                only list what would be deleted
      --yes                    do not ask for confirmation
  --import-windows-data [path] import saved configurations and macros from the Windows 'db' file
                               (path: the 'db' file or the folder containing it; default: the root folder)
      --include-deleted        also import entries the Windows app had marked as deleted
  --list-backups               list the automatic backups of your configurations and macros
  --restore-backup <name>      restore one of them (the current state is backed up first)
  --dedupe-configs             remove exact duplicate entries from the Configuration list (also done at every start)
  --reset-device-cache         forget cached keyboard layouts so the keys are read from the keyboard again
  --install-udev-rules         install the udev rule that lets your user access the keyboard
                               (the app also offers this by itself when the keyboard cannot be opened)
  --help                       this text

Debugging: FB_DEBUG=1 prints every byte sent to / received from the keyboard.
`;

(async () => {
  const wantsCli = has('--help') || has('-h') || has('--purge-windows-files') || has('--absorb-windows-files') || has('--import-windows-data') || has('--reset-device-cache') || has('--list-backups') || has('--restore-backup') || has('--dedupe-configs');
  const root = tools.resolveRoot(val('--root'));
  if (wantsCli) {
    let code = 0;
    try {
      if (has('--help') || has('-h')) console.log(HELP);
      if (has('--absorb-windows-files')) code = (await tools.absorb(root, val('--output'))) || code;
      if (has('--purge-windows-files')) code = (await tools.purge(root, { dryRun: has('--dry-run'), yes: has('--yes') })) || code;
      if (has('--import-windows-data')) {
        const src = val('--import-windows-data') || root;
        if (!src) { console.log('Give the path of the Windows db file or its folder.'); code = 1; }
        else code = (await tools.importWindows(src, app.getPath('userData'), { includeDeleted: has('--include-deleted') })) || code;
      }
      if (has('--list-backups')) tools.listBackups(app.getPath('userData'));
      if (has('--restore-backup')) code = tools.restoreBackup(app.getPath('userData'), val('--restore-backup')) || code;
      if (has('--dedupe-configs')) { const n = tools.dedupeConfigs(app.getPath('userData'), true); console.log(n ? `Removed ${n} duplicate configuration entr${n === 1 ? 'y' : 'ies'}.` : 'No duplicate configurations found.'); }
      if (has('--reset-device-cache')) code = tools.resetDeviceCache(app.getPath('userData')) || code;
    } catch (e) { console.error('Error:', e.message); code = 1; }
    app.exit(code);
    return;
  }

  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Privacy: no Chromium background networking either (secure-DNS probing, component updates, pings, sync ...).
  // The only traffic this app needs is to its own driver on 127.0.0.1, so every other host name fails to resolve.
  for (const sw of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings', 'disable-sync', 'disable-client-side-phishing-detection', 'disable-default-apps'])
    app.commandLine.appendSwitch(sw);
  app.commandLine.appendSwitch('disable-features', 'DnsOverHttps,AsyncDns,OptimizationHints,Translate');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }

  // Resources (device pictures etc.) are taken from the Windows root folder when the AppImage sits in it.
  const realApp = app.getAppPath();
  const ext = root && tools.findCompanyDir(root);
  try {
    const ov = tools.buildOverlay(realApp, ext || null, app.getPath('userData'));
    app.getAppPath = () => ov.base;
    if (ext) console.error(`[fb] using pictures from ${ext}`);
    else if (tools.companyIcon(path.join(realApp, 'company'))) console.error('[fb] using the Windows graphics built into this AppImage.');
    else console.error('[fb] AppImage is not in the Windows root folder and has no graphics built in: logos, device pictures and icon will be missing.');
  } catch (e) { console.error('[fb] could not prepare resources:', e.message); }

  // Privacy: nothing leaves this computer. Only local files and the local driver (127.0.0.1) are reachable.
  app.whenReady().then(() => {
    const local = /^(file|devtools|data|blob|about|chrome|chrome-extension):|^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
    require('electron').session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const ok = local.test(d.url);
      if (!ok && process.env.FB_DEBUG) console.error('[fb] blocked request:', d.url);
      cb({ cancel: !ok });
    });
  });

  // Safety net for configurations and macros: snapshot at every start, and remove exact duplicate configurations.
  try { const ud = app.getPath('userData'); require('./linux_driver/kv').backupAll(ud, 'startup'); tools.dedupeConfigs(ud, true); } catch (e) { console.error('[fb] startup backup failed:', e.message); }

  // Main window icon from the Windows graphics (company_*/icon.png)
  app.on('browser-window-created', (e, win) => {
    try { // UI fixes (see ui-fixes.css)
      const css = require('fs').readFileSync(path.join(__dirname, 'ui-fixes.css'), 'utf8');
      win.webContents.on('dom-ready', () => win.webContents.insertCSS(css).catch(() => {}));
    } catch (err) {}
    try {
      const icon = tools.companyIcon(path.join(app.getAppPath(), 'company'));
      if (icon) win.setIcon(require('electron').nativeImage.createFromPath(icon));
    } catch (err) {}
  });

  // First run on a system where the keyboard is not accessible yet: offer to install the udev rule (one admin prompt).
  let asked = false;
  const drv = require('./linux_driver/driver');
  const onPermissionDenied = async () => {
    if (asked) return; asked = true;
    await app.whenReady();
    const { dialog } = require('electron');
    if (tools.rulesInstalledAndCurrent()) {
      await dialog.showMessageBox({ type: 'info', title: 'Keyboard access', message: 'The access rule is installed but not active for this keyboard yet.',
        detail: 'Unplug and re-plug the keyboard. If that does not help, log out and back in.' });
      return;
    }
    const r = await dialog.showMessageBox({ type: 'question', buttons: ['Allow access', 'Not now'], defaultId: 0, cancelId: 1, title: 'Keyboard access',
      message: 'Firstblood Driver needs permission to talk to your keyboard.',
      detail: 'This installs a small udev rule once (' + tools.RULES_DEST + '). You will be asked for your administrator password. It stays in place after reboots and re-plugging.' });
    if (r.response !== 0) return;
    const res = await tools.installUdevRules();
    if (!res.ok) {
      await dialog.showMessageBox({ type: 'error', title: 'Keyboard access', message: 'Could not install the access rule.',
        detail: (res.error || 'Unknown error') + '\n\nYou can also run this in a terminal:\n' + (process.env.APPIMAGE || 'Firstblood-Driver-linux-x86_64.AppImage') + ' --install-udev-rules' });
      return;
    }
    setTimeout(() => { if (drv.manager.denied.size) dialog.showMessageBox({ type: 'info', title: 'Keyboard access',
      message: 'Rule installed. Please unplug and re-plug the keyboard.', detail: 'If it is still not detected afterwards, log out and back in.' }); }, 12000);
  };
  drv.start({ onPermissionDenied });
  require('./main_dist/main.js');
})();
