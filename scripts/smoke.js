#!/usr/bin/env node
// Start a freshly built installer the way a person would, and check that the app runs.
// A build can pass every test and still ship an app that dies on start (a file left out
// of the package, a broken installer). This is the last check before a release is made.
//
// usage: node smoke.js --kind mac-dmg|linux-appimage|win-exe --file <installer>
//        --version X.Y.Z --source <source dir> --work <empty scratch dir>
//
// It never touches a real profile: the app runs with MD_USER_DATA_DIR in the scratch
// dir and its own --user-data-dir (the single-instance lock is taken before the first one
// applies, so without the flag an installed copy that is already running makes the new
// app quit at once and this check time out), and MD_RELEASE_GATE=1 keeps it from stealing focus or starting the updater.
// On Linux run it under a virtual screen (xvfb-run -a node smoke.js ...).
// The licence (0.0.8) is checked too: the free trial, wrong and forged codes, and then a second start after
// the trial is aged by 30 days and licence.json is deleted (the books must be view-only). Accepting a real code
// needs the owner's private key, which a build machine does not have, so that part runs only when
// MD_SMOKE_SIGNING_KEY points at the key file (and MD_SMOKE_SIGNING_KEY_INDEX at its number, default 0);
// otherwise it prints SKIP and is not counted as a pass.
// Exits 0 when every check passes, 1 otherwise. Writes <work>/smoke.png.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const PRODUCT = 'M-Digital Accounting';
const START_TIMEOUT_MS = 120000;
const DAY = 86400000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function findFile(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// Each installer kind is unpacked the way a user would, and gives back what to launch.
const installers = {
  'mac-dmg'(file, work) {
    const mount = path.join(work, 'mount');
    const apps = path.join(work, 'apps');
    fs.mkdirSync(mount, { recursive: true });
    fs.mkdirSync(apps, { recursive: true });
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mount, file], { stdio: 'inherit' });
    try {
      const app = fs.readdirSync(mount).find((n) => n.endsWith('.app'));
      if (!app) throw new Error('The disk image has no .app in it.');
      execFileSync('ditto', [path.join(mount, app), path.join(apps, app)], { stdio: 'inherit' });
      const macos = path.join(apps, app, 'Contents', 'MacOS');
      const binary = fs.readdirSync(macos)[0];
      return { executablePath: path.join(macos, binary), args: [] };
    } finally {
      try { execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  },

  'linux-appimage'(file, work) {
    fs.chmodSync(file, 0o755);
    // Extracting needs no FUSE, so it works on a plain CI machine.
    execFileSync(file, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    const appRun = path.join(work, 'squashfs-root', 'AppRun');
    if (!fs.existsSync(appRun)) throw new Error('The AppImage did not unpack an AppRun.');
    // A CI user cannot use Chromium's SUID sandbox helper from an unpacked image.
    return { executablePath: appRun, args: ['--no-sandbox'] };
  },

  'win-exe'(file, work) {
    const dir = path.join(work, 'app');
    // NSIS: /S is silent, /D sets the folder and must come last (no quotes, no spaces).
    const result = spawnSync(file, ['/S', `/D=${dir}`], { stdio: 'inherit' });
    if (result.error) throw result.error;
    // The installer can hand over to a second process, so wait for the program to appear.
    const deadline = Date.now() + 120000;
    let exe = null;
    while (!exe && Date.now() < deadline) {
      exe = findFile(dir, `${PRODUCT}.exe`);
      if (!exe) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!exe) throw new Error(`The installer finished but ${PRODUCT}.exe is not in ${dir}.`);
    return { executablePath: exe, args: [] };
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { kind, file, version, source, work } = args;
  if (!installers[kind] || !file || !version || !source || !work) {
    console.error('usage: node smoke.js --kind mac-dmg|linux-appimage|win-exe --file <installer> --version X.Y.Z --source <dir> --work <dir>');
    return 2;
  }
  fs.mkdirSync(work, { recursive: true });
  const dataDir = path.join(work, 'userdata');
  fs.mkdirSync(dataDir, { recursive: true });

  const playwright = require(require.resolve('playwright', { paths: [path.resolve(source)] }));
  const { executablePath, args: launchArgs } = installers[kind](path.resolve(file), path.resolve(work));
  console.log(`Installed. Starting ${executablePath}`);

  const env = { ...process.env, MD_USER_DATA_DIR: dataDir, MD_RELEASE_GATE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };

  let app = null;
  let firstRunOk = false;
  const pageErrors = [];
  const launch = () => playwright._electron.launch({ executablePath, args: [...launchArgs, `--user-data-dir=${path.join(path.resolve(work), 'chromium-profile')}`], env, timeout: START_TIMEOUT_MS });
  const licenceModule = require(path.join(path.resolve(source), 'desktop', 'licence.js'));
  try {
    app = await launch();
    const win = await app.firstWindow({ timeout: START_TIMEOUT_MS });
    win.on('pageerror', (error) => pageErrors.push(error.message));
    await win.waitForLoadState('domcontentloaded', { timeout: START_TIMEOUT_MS });
    // The first screen of a fresh profile is the sign-in / first-owner page.
    await win.waitForURL(/\/login/, { timeout: 60000 }).catch(() => {});
    await win.waitForTimeout(4000);

    const info = await app.evaluate(({ app: electronApp }) => ({
      version: electronApp.getVersion(),
      packaged: electronApp.isPackaged
    }));
    check('the app reports the release version', info.version === version, `${info.version}, wanted ${version}`);
    check('it is the packaged app, not a development run', info.packaged === true);

    const page = await win.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText : '',
      bridge: typeof window.mdDesktop
    }));
    check('the built-in server answers on this computer only', /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url), page.url);
    check('a fresh profile opens the sign-in page', /\/login/.test(page.url), page.url);
    check('the page has a title', page.title.trim().length > 0, page.title);
    check('the page shows content, not an error', page.text.trim().length > 50 &&
      !/application error|internal server error|this page could not be found/i.test(page.text));
    check('the desktop bridge is present', page.bridge === 'object', page.bridge);

    await win.screenshot({ path: path.join(work, 'smoke.png') }).catch(() => {});

    // The desktop app is not the website. v0.0.3 shipped with the marketing site inside
    // it. A signed-out visit to the root must land on sign-in, and the old website
    // addresses must not exist.
    const base = new URL(page.url).origin;
    await win.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await win.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
    check('the root address leads to sign-in, not a landing page', /\/login/.test(win.url()), win.url());
    for (const address of ['/home', '/about', '/download', '/legal/terms', '/products/pos', '/site/demo']) {
      const response = await win.goto(`${base}${address}`, { waitUntil: 'domcontentloaded' });
      check(`the website page ${address} is not part of the app`, Boolean(response) && response.status() === 404, `status ${response && response.status()}`);
    }

    // Start with the computer (0.0.6). An installed app must be able to use it; a development run never can.
    // It is flipped on and then straight off again, and the state is read back from the system each time,
    // so the computer is left as it was found. On Linux it also needs an AppImage file to point at, so
    // there it is reported, not required.
    await win.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    const startup = await win.evaluate(() => (window.mdDesktop.launchAtLogin ? window.mdDesktop.launchAtLogin.get() : null));
    const needsSupport = process.platform !== 'linux';
    check('start with the computer is offered in the installed app', Boolean(startup) && startup.enabled === false && (startup.supported === true || !needsSupport), JSON.stringify(startup));
    if (startup && startup.supported) {
      try {
        const on = await win.evaluate(() => window.mdDesktop.launchAtLogin.set(true));
        let detail = JSON.stringify(on);
        if (on.enabled !== true && process.platform === 'win32') {
          // The one thing that has failed on a real Windows machine: say what Windows itself holds.
          const raw = await app.evaluate(({ app: electronApp }) => electronApp.getLoginItemSettings()).catch((error) => ({ error: String(error) }));
          const reg = (key) => { const r = spawnSync('reg', ['query', key], { encoding: 'utf8' }); return (r.stdout || r.stderr || '').replace(/\r?\n/g, ' | ').slice(0, 600); };
          detail += ` raw=${JSON.stringify(raw)} Run=[${reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')}] StartupApproved=[${reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')}]`;
        }
        check('the switch turns on and the system says it is on', on.enabled === true, detail);
      } finally {
        const off = await win.evaluate(() => window.mdDesktop.launchAtLogin.set(false));
        check('the switch turns off again and the system says it is off', off.enabled === false, JSON.stringify(off));
      }
    }

    // Password and recovery key (0.0.6), through the real bridge of the installed app: make an owner, make a key,
    // reset with it, and check the old password is dead and the key was replaced. The profile is a temporary one.
    const flow = await win.evaluate(async () => {
      const auth = (request) => window.mdDesktop.local.auth(request);
      const shape = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/;
      const me = { name: 'Smoke Owner', email: 'smoke@example.com', password: 'smoke-password-1' };
      await auth({ op: 'setup', ...me });
      const key = (await auth({ op: 'createRecoveryKey', password: me.password })).recoveryKey;
      await auth({ op: 'signOut' });
      const reset = await auth({ op: 'resetPassword', email: me.email, recoveryKey: key, newPassword: 'smoke-password-2' });
      await auth({ op: 'signOut' });
      let oldPasswordWorks = true;
      try { await auth({ op: 'signIn', email: me.email, password: me.password }); } catch { oldPasswordWorks = false; }
      const back = await auth({ op: 'signIn', email: me.email, password: 'smoke-password-2' });
      await auth({ op: 'signOut' });
      return { shapes: shape.test(key) && shape.test(reset.recoveryKey), replaced: reset.recoveryKey !== key, oldPasswordWorks, signedInAgain: back.email === me.email };
    });
    check('a recovery key is made in the right shape and a reset gives a new one', flow.shapes && flow.replaced, JSON.stringify(flow));
    check('after a reset the old password is refused and the new one signs in', flow.oldPasswordWorks === false && flow.signedInAgain, JSON.stringify(flow));

    // The paid licence (0.0.8). An installed app always enforces it, so this is the real thing: a new install is on
    // the 14 day trial, and a made-up code and a code signed with some other key are both refused. Nothing here needs
    // the owner's key.
    const free = await win.evaluate(async () => {
      const licence = window.mdDesktop.licence;
      return { status: await licence.get(), junk: await licence.activate('not a code at all') };
    });
    check('a new install is on the 14 day free trial and the licence is enforced', free.status.state === 'trial' && free.status.daysLeft === 14 && free.status.enforced === true && free.status.locked === false, JSON.stringify(free.status));
    check('a made-up code is refused', free.junk.ok === false && free.junk.code === 'LICENCE_FORMAT', JSON.stringify(free.junk));
    const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
    const forged = licenceModule.makeCode({ privateKey: stranger, keyIndex: 0, email: 'smoke@example.com', issuedAt: Date.now(), endsAt: Date.now() + 365 * DAY });
    const forgedAnswer = await win.evaluate((code) => window.mdDesktop.licence.activate(code), forged);
    check('a code that looks right but was signed with another key is refused', forgedAnswer.ok === false && forgedAnswer.code === 'LICENCE_SIGNATURE', JSON.stringify(forgedAnswer));
    // Backups (0.0.9). A copy is made by a worker thread running VACUUM INTO and a restore swaps the live file, and
    // only the installed app proves both. A business is saved, copied, another is saved, and the copy is restored:
    // the second business must be gone, what was live before must be kept in a safety copy, and the app must ask to
    // restart (the restart itself is stood in for, so this run can look at the result).
    const backupModule = require(path.join(path.resolve(source), 'desktop', 'backup.js'));
    const made = await win.evaluate(async () => {
      const b = window.mdDesktop.backup;
      if (!b) return { present: false };
      const user = await window.mdDesktop.local.auth({ op: 'signIn', email: 'smoke@example.com', password: 'smoke-password-2' });
      const save = (id) => window.mdDesktop.local.commit({ ops: [{ table: 'businesses', id, type: 'set', fields: { uid: user.uid, businessId: id, businessName: id } }] });
      await save('before-copy');
      const run = await b.run();
      await save('after-copy');
      const status = await b.status();
      return { present: true, run, copies: status.copies.map((c) => c.id) };
    });
    check('the backup bridge is present in the installed app', made.present === true);
    check('Back up now makes a copy in the installed app', Boolean(made.run && made.run.ok) && made.copies.length === 1, JSON.stringify(made.run));
    const autoRoot = path.join(dataDir, 'backups', 'auto');
    const copyFolders = fs.existsSync(autoRoot) ? fs.readdirSync(autoRoot).filter((n) => n.startsWith('md-')) : [];
    const copyCheck = copyFolders.length === 1 ? backupModule.checkDatabase(path.join(autoRoot, copyFolders[0], 'accounting.sqlite')) : { ok: false };
    check('the copy is on disk, opens, passes its check and holds the account', copyCheck.ok === true && copyCheck.owner === true, JSON.stringify(copyCheck));
    await app.evaluate(({ app: electronApp }) => {
      globalThis.__md = { restarts: 0, quit: electronApp.quit, relaunch: electronApp.relaunch };
      electronApp.relaunch = () => { globalThis.__md.restarts += 1; };
      electronApp.quit = () => {};
    });
    const restored = await win.evaluate(async (id) => window.mdDesktop.backup.restore(id), made.copies[0]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const restarts = await app.evaluate(({ app: electronApp }) => {
      const state = globalThis.__md;
      electronApp.quit = state.quit;
      electronApp.relaunch = state.relaunch;
      return state.restarts;
    });
    check('a restore in the installed app succeeds and asks the app to restart', restored.ok === true && restarts === 1, JSON.stringify(restored) + ` restarts: ${restarts}`);
    const afterRestore = await win.evaluate(async () => {
      await window.mdDesktop.local.auth({ op: 'signIn', email: 'smoke@example.com', password: 'smoke-password-2' });
      return (await window.mdDesktop.local.query({ table: 'businesses' })).map((row) => row.id).sort();
    });
    check('after the restore the books are as they were at the copy', JSON.stringify(afterRestore) === JSON.stringify(['before-copy']), JSON.stringify(afterRestore));
    const safetyRoot = path.join(dataDir, 'backups', 'safety');
    const safetyFolders = fs.existsSync(safetyRoot) ? fs.readdirSync(safetyRoot) : [];
    const safetyCheck = safetyFolders.length === 1 ? backupModule.checkDatabase(path.join(safetyRoot, safetyFolders[0], 'accounting.sqlite')) : { ok: false };
    check('what was live before the restore is kept in a safety copy that opens', safetyCheck.ok === true, JSON.stringify(safetyCheck));
    const refused = await win.evaluate(async () => window.mdDesktop.backup.restore('auto:../../etc'));
    check('a restore cannot be pointed at any path the page makes up', refused.ok === false && refused.error === 'not-found', JSON.stringify(refused));
    if (pageErrors.length) console.log(`note: ${pageErrors.length} uncaught page error(s), first: ${pageErrors[0]}`);
    firstRunOk = true;
  } catch (error) {
    check('the app starts and opens a window', false, String(error.message || error).split('\n')[0]);
  } finally {
    if (app) await app.close().catch(() => {});
    app = null;
  }

  // The trial is over (0.0.8). The app is closed, so its files can be changed the way a person could: the trial start
  // is moved 30 days back in the database, and licence.json is deleted as well (the copy in the database must be enough
  // to keep the trial from starting again). Then the app is started a second time.
  if (firstRunOk) {
    let sqlite = null;
    try { sqlite = require('node:sqlite'); } catch { /* an older Node */ }
    if (!sqlite) {
      console.log('SKIP  the view-only check: this Node has no node:sqlite to age the trial with');
    } else {
      try {
        const file = path.join(dataDir, 'licence.json');
        const old = JSON.parse(fs.readFileSync(file, 'utf8')).trialStartedAt - 30 * DAY;
        const db = new sqlite.DatabaseSync(path.join(dataDir, 'accounting.sqlite'));
        try {
          db.prepare('INSERT INTO local_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(licenceModule.MARKER_KEY, String(old));
        } finally { db.close(); }
        fs.rmSync(file);

        app = await launch();
        const win = await app.firstWindow({ timeout: START_TIMEOUT_MS });
        await win.waitForLoadState('domcontentloaded', { timeout: START_TIMEOUT_MS });
        await win.waitForTimeout(3000);
        const view = await win.evaluate(async () => {
          await window.mdDesktop.local.auth({ op: 'signIn', email: 'smoke@example.com', password: 'smoke-password-2' });
          const status = await window.mdDesktop.licence.get();
          let readWorks = true;
          try { await window.mdDesktop.local.query({ table: 'businesses' }); } catch { readWorks = false; }
          let writeError = null;
          try {
            await window.mdDesktop.local.commit({ ops: [{ table: 'products', id: 'smoke-product', type: 'set', fields: { businessId: 'smoke', name: 'Smoke' } }] });
          } catch (error) { writeError = String((error && error.message) || error); }
          return { status, readWorks, writeError };
        });
        check('after the trial, and with licence.json deleted, the books are view-only', view.status.state === 'ended' && view.status.locked === true && view.status.endedFor === 'trial', JSON.stringify(view.status));
        check('view-only books can still be read', view.readWorks === true);
        check('view-only books refuse a new record', typeof view.writeError === 'string' && view.writeError.includes('LICENCE_ENDED'), String(view.writeError));
        check('licence.json is written again, with the old trial start', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).trialStartedAt === old);

        const keyFile = process.env.MD_SMOKE_SIGNING_KEY;
        if (keyFile && fs.existsSync(keyFile)) {
          const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
          const keyIndex = Number(process.env.MD_SMOKE_SIGNING_KEY_INDEX || 0);
          const make = (email) => licenceModule.makeCode({ privateKey, keyIndex, email, issuedAt: Date.now(), endsAt: Date.now() + 30 * DAY });
          const answers = await win.evaluate(async ({ right, wrong }) => ({
            wrong: await window.mdDesktop.licence.activate(wrong),
            right: await window.mdDesktop.licence.activate(right),
          }), { right: make('smoke@example.com'), wrong: make('someone-else@example.com') });
          check('a real code made for another email is refused', answers.wrong.ok === false && answers.wrong.code === 'LICENCE_EMAIL', JSON.stringify(answers.wrong));
          check('a real code made for this owner is accepted and unlocks the books', answers.right.ok === true && answers.right.status.state === 'licensed' && answers.right.status.locked === false, JSON.stringify(answers.right));
        } else {
          console.log('SKIP  accepting a real code: no signing key here (set MD_SMOKE_SIGNING_KEY to the key file to run it)');
        }
      } catch (error) {
        check('the second start, after the trial, works', false, String(error.message || error).split('\n')[0]);
      } finally {
        if (app) await app.close().catch(() => {});
      }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nSMOKE FAILED: ${failed} of ${results.length} checks` : `\nSmoke passed: ${results.length} checks`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
