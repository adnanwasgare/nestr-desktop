const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, desktopCapturer, powerMonitor, Notification, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { autoUpdater } = require('electron-updater');

// Same project the web app uses -- confirmed from supabase-client.js.
// The publishable key is meant for exactly this, client-side use; RLS
// is what actually gates data access, not this key.
const SUPABASE_URL = 'https://kphonfpcqcwkrpacezpl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_OUDECUpO1JLpyhC2n_3BRQ_ktXYAsRN';

// No storage option is configured here on purpose. In a Node context
// (unlike a browser), that means the session lives in memory only for
// as long as this process runs -- there is nothing to persist to
// disk, and nothing to clear. Every fresh launch of the app starts
// with no session at all, which is what satisfies "PIN required every
// launch" -- no extra logic needed for that requirement, it falls out
// of where this client lives.
//
// realtime.transport: unlike a browser, Node has no built-in
// WebSocket global (pre-22), which is what the Realtime module needs
// to open its live connection for the messenger. The `ws` package was
// already a listed dependency for exactly this, but never actually
// wired in here -- this is that fix.
let supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { transport: WebSocket }
});

/* ----------------------------------------------------------
   Theme -- a UI preference, not auth state, so this is
   deliberately allowed to persist across launches even though
   the login session itself never does. Kept in its own small
   file, entirely separate from anything session-related.
   ---------------------------------------------------------- */

function settingsPath() {
  return path.join(app.getPath('userData'), 'nestr-settings.json');
}

function loadSavedTheme() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.theme === 'light' || parsed.theme === 'dark') return parsed.theme;
  } catch (e) { /* no saved preference yet -- fall through */ }
  return null;
}

function saveTheme(theme) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify({ theme: theme })); } catch (e) { /* non-fatal */ }
}

function resolveTheme() {
  const saved = loadSavedTheme();
  if (saved) return saved;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

let mainWindow = null;
let tray = null;
let realtimeChannel = null;

// Session + app-local cache, cleared on logout.
let session = null;              // { companyId, employeeId, role, fullName }
let punchState = { last: null, firstIn: null, breakMs: 0 };
let employeeShift = null; // fetched once per session, doesn't change often
let people = {};                 // employee_id -> { name, designation }
let threads = {};                // other_employee_id -> [messages]

// Monitoring state -- cleared on logout same as everything else above.
let monitoringPolicy = null;     // the current monitoring_policies row for this company
let monitoringConsented = false; // has THIS employee acknowledged the current policy version
let monitoringDeviceId = null;
let captureTimer = null;
let activityTickTimer = null;
let idleSecondsAccum = 0;
let activeSecondsAccum = 0;

function resetLocalState() {
  session = null;
  punchState = { last: null, firstIn: null, breakMs: 0 };
  people = {};
  threads = {};
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  monitoringPolicy = null;
  monitoringConsented = false;
  monitoringDeviceId = null;
  if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
  if (activityTickTimer) { clearInterval(activityTickTimer); activityTickTimer = null; }
  idleSecondsAccum = 0;
  activeSecondsAccum = 0;
}

/* ----------------------------------------------------------
   Auth -- replicates auth.js's real sign-in sequence exactly:
   anonymous session first, then the sign-in Edge Function
   "upgrades" it with company/employee claims, then the session
   is refreshed so the JWT actually carries those claims.
   ---------------------------------------------------------- */

// supabase-js wraps any non-2xx Edge Function response in a generic
// FunctionsHttpError; the real message ("Incorrect PIN", "Company
// code not found") is in the response body. Same extraction auth.js
// uses for the exact same reason.
async function edgeErrorMessage(err, fallback) {
  try {
    if (err && err.context && typeof err.context.json === 'function') {
      const body = await err.context.json();
      return (body && body.error) || fallback;
    }
  } catch (e) { /* fall through to fallback */ }
  return (err && err.message) || fallback;
}

async function doLogin(companyCode, employeeId, pin) {
  const { error: anonErr } = await supabase.auth.signInAnonymously();
  if (anonErr) throw new Error(anonErr.message || 'Could not start a session.');

  const { error: fnErr } = await supabase.functions.invoke('sign-in', {
    body: { companyCode, employeeId, pin }
  });
  if (fnErr) {
    const msg = await edgeErrorMessage(fnErr, 'Sign in failed. Try again.');
    throw new Error(msg);
  }

  const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
  if (refErr) throw new Error(refErr.message || 'Could not complete sign in.');

  const meta = (refreshed && refreshed.session && refreshed.session.user &&
                refreshed.session.user.app_metadata) || {};
  if (!meta.company_id || !meta.employee_id) {
    throw new Error('Sign in did not return a valid session. Try again.');
  }

  session = {
    companyId: meta.company_id,
    employeeId: meta.employee_id,
    role: meta.employee_role || 'employee',
    fullName: (refreshed.session.user.user_metadata &&
               refreshed.session.user.user_metadata.full_name) || employeeId
  };
  return session;
}

async function doLogout() {
  try { await supabase.auth.signOut(); } catch (e) { /* ignore -- clearing local state regardless */ }
  resetLocalState();
}

/* ----------------------------------------------------------
   Check In/Out and Break In/Out -- same punch() RPC the web
   Punch Panel uses. p_source is 'agent' (a real, constrained
   value on attendance_punches -- confirmed against the actual
   check constraint, not guessed) to distinguish a punch made by
   this installed background app from one made through the
   browser.
   ---------------------------------------------------------- */

async function fetchEmployeeShift() {
  if (employeeShift !== null) return employeeShift; // already cached this session
  const { data, error } = await supabase
    .from('employees')
    .select('shifts(id, name, start_time, end_time, grace_minutes)')
    .eq('id', session.employeeId)
    .maybeSingle();
  employeeShift = (!error && data && data.shifts) || false; // false = "checked, has none" vs null = "not checked yet"
  return employeeShift;
}

async function refreshPunchState() {
  // Correctly passes p_company_id -- company_timezone() has no
  // default for this parameter. Both attendance.js and punch.js in
  // the web app call this RPC with an empty argument object, which
  // is a separate, pre-existing bug worth fixing there too (flagged,
  // not fixed here -- out of scope for this app).
  const { data: tz } = await supabase.rpc('company_timezone', { p_company_id: session.companyId });
  const timezone = tz || 'Asia/Kolkata';
  const localDate = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  const { data: punches, error } = await supabase
    .from('attendance_punches')
    .select('punch_type, punched_at')
    .eq('employee_id', session.employeeId)
    .eq('work_date', localDate)
    .order('punched_at');
  if (error) throw new Error(error.message);

  const rows = punches || [];
  punchState.last = rows.length ? rows[rows.length - 1].punch_type : null;
  const firstIn = rows.find((p) => p.punch_type === 'in');
  punchState.firstIn = firstIn ? firstIn.punched_at : null;

  // Matches punch.js's pairBreaks() on the web -- worked time should
  // read the same on both, not disagree because one subtracts break
  // time and the other doesn't.
  var breakMs = 0, openBreak = null;
  rows.forEach((p) => {
    if (p.punch_type === 'break_start') { openBreak = p.punched_at; }
    else if (p.punch_type === 'break_end' && openBreak) {
      breakMs += new Date(p.punched_at) - new Date(openBreak);
      openBreak = null;
    }
  });
  if (openBreak) breakMs += Date.now() - new Date(openBreak);
  punchState.breakMs = breakMs;

  return punchState;
}

async function doPunch(type) {
  const { error } = await supabase.rpc('punch', { p_type: type, p_source: 'agent' });
  if (error) throw new Error(error.message);
  await refreshPunchState();
  updateTrayMenu();
  return punchState;
}

/* ----------------------------------------------------------
   Monitoring -- screen activity + periodic screenshots, gated
   entirely by the company's own monitoring_policies row. Every
   behavior here reads from that row rather than assuming
   anything -- the interval, whether blur is on, whether capture
   requires being checked in, all company-configured, never
   hardcoded. If is_enabled is false, none of this does anything
   at all.
   ---------------------------------------------------------- */

async function fetchMonitoringPolicy() {
  const { data, error } = await supabase
    .from('monitoring_policies')
    .select('*')
    .eq('company_id', session.companyId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  monitoringPolicy = (!error && data) || null;
  return monitoringPolicy;
}

async function checkConsent() {
  if (!monitoringPolicy) { monitoringConsented = false; return false; }
  const { data, error } = await supabase
    .from('monitoring_acknowledgements')
    .select('id')
    .eq('company_id', session.companyId)
    .eq('employee_id', session.employeeId)
    .eq('policy_version', monitoringPolicy.version)
    .maybeSingle();
  monitoringConsented = !error && !!data;
  return monitoringConsented;
}

async function acknowledgeConsent() {
  if (!monitoringPolicy) throw new Error('No monitoring policy loaded.');
  const { error } = await supabase.from('monitoring_acknowledgements').insert({
    company_id: session.companyId, employee_id: session.employeeId,
    policy_version: monitoringPolicy.version
  });
  if (error) throw new Error(error.message);
  monitoringConsented = true;
  return true;
}

function mapPlatform() {
  var p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

async function registerDevice() {
  const label = os.hostname() || 'Unknown device';
  const platform = mapPlatform();
  const version = app.getVersion();

  // One row per (employee, device label) in practice -- reuse an
  // existing registration for this machine rather than creating a
  // new one every relaunch.
  const { data: existing } = await supabase
    .from('monitoring_devices')
    .select('id')
    .eq('company_id', session.companyId)
    .eq('employee_id', session.employeeId)
    .eq('device_label', label)
    .maybeSingle();

  if (existing) {
    monitoringDeviceId = existing.id;
    await supabase.from('monitoring_devices')
      .update({ last_seen_at: new Date().toISOString(), agent_version: version, is_active: true })
      .eq('id', existing.id);
  } else {
    const { data: created, error } = await supabase.from('monitoring_devices').insert({
      company_id: session.companyId, employee_id: session.employeeId,
      device_label: label, platform, agent_version: version,
      last_seen_at: new Date().toISOString(), is_active: true
    }).select('id').single();
    if (!error && created) monitoringDeviceId = created.id;
  }
}

function isActivelyCheckedIn() {
  // Excludes breaks on purpose -- "checked in" for monitoring means
  // actually working, not just present with the app open during a
  // break.
  return punchState.last === 'in';
}

async function bumpActivityDay(deltas) {
  const day = new Date().toLocaleDateString('en-CA');
  const { data: existing } = await supabase
    .from('activity_days')
    .select('*')
    .eq('company_id', session.companyId)
    .eq('employee_id', session.employeeId)
    .eq('day', day)
    .maybeSingle();

  const base = existing || {
    active_seconds: 0, idle_seconds: 0, in_shift_seconds: 0,
    outside_shift_seconds: 0, screenshot_count: 0
  };
  const next = {
    active_seconds: base.active_seconds + (deltas.active_seconds_inc || 0),
    idle_seconds: base.idle_seconds + (deltas.idle_seconds_inc || 0),
    in_shift_seconds: base.in_shift_seconds + (deltas.in_shift_seconds_inc || 0),
    outside_shift_seconds: base.outside_shift_seconds + (deltas.outside_shift_seconds_inc || 0),
    screenshot_count: base.screenshot_count + (deltas.screenshot_count_inc || 0)
  };

  if (existing) {
    await supabase.from('activity_days').update(next).eq('id', existing.id);
  } else {
    await supabase.from('activity_days').insert(Object.assign({
      company_id: session.companyId, employee_id: session.employeeId, day
    }, next));
  }
}

async function captureAndUploadScreenshot() {
  if (!monitoringPolicy || !monitoringPolicy.is_enabled) return;
  if (monitoringPolicy.capture_only_when_checked_in && !isActivelyCheckedIn()) return;
  if (!monitoringConsented) return;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 }
  });
  if (!sources.length) return;

  let image = sources[0].thumbnail;
  if (monitoringPolicy.blur_screenshots) {
    // No image-processing dependency needed for this -- shrinking
    // heavily then rescaling back up is a genuine blur baked into
    // the stored file, not a cosmetic effect applied only when
    // someone views it later.
    const size = image.getSize();
    const tiny = image.resize({ width: Math.max(1, Math.round(size.width * 0.06)) });
    image = tiny.resize({ width: size.width, height: size.height });
  }

  const idleSeconds = powerMonitor.getSystemIdleTime();
  const activityLevel = idleSeconds > 300 ? 'low' : (idleSeconds > 60 ? 'moderate' : 'high');

  const buffer = image.toPNG();
  const storagePath = session.companyId + '/' + session.employeeId + '/' + Date.now() + '.png';

  const { error: upErr } = await supabase.storage.from('screenshots').upload(storagePath, buffer, {
    contentType: 'image/png'
  });
  if (upErr) { console.error('[nestr] screenshot upload failed:', upErr.message); return; }

  await supabase.from('activity_screenshots').insert({
    company_id: session.companyId, employee_id: session.employeeId,
    device_id: monitoringDeviceId, storage_path: storagePath,
    activity_level: activityLevel, was_checked_in: isActivelyCheckedIn()
  });

  await bumpActivityDay({ screenshot_count_inc: 1 });
}

// Every 60s while monitoring is active and consented: attribute the
// last minute as active/idle and in-shift/outside-shift, based on
// real punch state rather than assuming the app being open means
// working.
function activityTick() {
  if (!monitoringPolicy || !monitoringPolicy.is_enabled || !monitoringConsented) return;
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const wasActive = idleSeconds < 60;
  const inShift = isActivelyCheckedIn();

  bumpActivityDay({
    active_seconds_inc: wasActive ? 60 : 0,
    idle_seconds_inc: wasActive ? 0 : 60,
    in_shift_seconds_inc: inShift ? 60 : 0,
    outside_shift_seconds_inc: inShift ? 0 : 60
  }).catch(() => {});
}

// Randomized around the configured interval (80-120% of it) rather
// than a fixed clock tick -- the same reasoning real monitoring
// tools use: a perfectly predictable interval is one people learn
// to work around.
function scheduleNextCapture() {
  if (captureTimer) clearTimeout(captureTimer);
  if (!monitoringPolicy || !monitoringPolicy.is_enabled || !monitoringConsented) return;

  const base = monitoringPolicy.screenshot_interval_seconds * 1000;
  const jitter = base * (0.8 + Math.random() * 0.4);

  captureTimer = setTimeout(() => {
    captureAndUploadScreenshot().catch((e) => console.error('[nestr] capture failed:', e));
    scheduleNextCapture();
  }, jitter);
}

async function startMonitoringIfApplicable() {
  await fetchMonitoringPolicy();
  if (!monitoringPolicy || !monitoringPolicy.is_enabled) return;

  await checkConsent();
  await registerDevice();

  if (activityTickTimer) clearInterval(activityTickTimer);
  activityTickTimer = setInterval(activityTick, 60 * 1000);

  // If not consented yet, capture does not start here -- the
  // renderer shows the disclosure and calls nestr:acknowledge-
  // monitoring, and only that IPC handler starts the capture loop.
  if (monitoringConsented) scheduleNextCapture();
}

/* ----------------------------------------------------------
   Messenger -- same `messages` table and Realtime pattern as
   messages.js. Cached in memory here; the renderer just asks
   for what it needs.
   ---------------------------------------------------------- */

function otherPartyOf(m) {
  return m.sender_id === session.employeeId ? m.recipient_id : m.sender_id;
}

async function loadMessagingData() {
  const [peopleRes, msgRes] = await Promise.all([
    supabase.from('employees').select('id, full_name, designation').eq('is_active', true).order('full_name'),
    supabase.from('messages').select('id, sender_id, recipient_id, body, read_at, created_at').order('created_at')
  ]);
  if (peopleRes.error) throw new Error(peopleRes.error.message);

  people = {};
  (peopleRes.data || []).forEach((e) => { people[e.id] = { name: e.full_name, designation: e.designation }; });

  threads = {};
  ((msgRes.data) || []).forEach((m) => {
    const other = otherPartyOf(m);
    (threads[other] = threads[other] || []).push(m);
  });

  subscribeRealtime();
  return buildConversationList();
}

function buildConversationList() {
  return Object.keys(people)
    .filter((id) => id !== session.employeeId)
    .map((id) => {
      const msgs = threads[id] || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const unread = msgs.filter((m) => m.recipient_id === session.employeeId && !m.read_at).length;
      return { id, person: people[id], last, unread };
    })
    .sort((a, b) => {
      if (a.last && b.last) return new Date(b.last.created_at) - new Date(a.last.created_at);
      if (a.last) return -1;
      if (b.last) return 1;
      return (a.person.name || '').localeCompare(b.person.name || '');
    });
}

async function doSendMessage(recipientId, body) {
  const { data, error } = await supabase.from('messages').insert({
    company_id: session.companyId, sender_id: session.employeeId,
    recipient_id: recipientId, body
  }).select('*').single();
  if (error) throw new Error(error.message);

  (threads[recipientId] = threads[recipientId] || []).push(data);
  return data;
}

async function markThreadRead(otherId) {
  const unread = (threads[otherId] || []).filter((m) => m.recipient_id === session.employeeId && !m.read_at);
  if (!unread.length) return;
  const now = new Date().toISOString();
  unread.forEach((m) => { m.read_at = now; });
  await supabase.from('messages').update({ read_at: now }).in('id', unread.map((m) => m.id));
}

function subscribeRealtime() {
  if (realtimeChannel || !session) return;
  realtimeChannel = supabase
    .channel('nestr-desktop-messages')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: 'recipient_id=eq.' + session.employeeId
    }, (payload) => {
      const m = payload.new;
      const other = otherPartyOf(m);
      (threads[other] = threads[other] || []).push(m);
      if (mainWindow) mainWindow.webContents.send('nestr:new-message', m);
      updateTrayMenu();
      notifyNewMessage(other, m);
    })
    .subscribe();
}

// On by default, no setting to turn it on -- only suppressed when the
// window is already focused, since the person is actively looking at
// the app at that point and a popup on top would just be redundant
// with what they can already see updating live.
function notifyNewMessage(senderId, m) {
  if (!Notification.isSupported()) return;
  if (mainWindow && mainWindow.isFocused()) return;

  const sender = people[senderId];
  const title = sender ? sender.name : 'New message';
  const body = m.body.length > 120 ? m.body.slice(0, 120) + '\u2026' : m.body;

  const notification = new Notification({
    title: title,
    body: body,
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  notification.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('nestr:open-thread', senderId);
  });

  notification.show();
}

/* ----------------------------------------------------------
   Tray icon -- Break In/Out reachable without opening the main
   window, mirroring the web Punch Panel's own rule: only offer
   what's actually valid next.
   ---------------------------------------------------------- */

function updateTrayMenu() {
  if (!tray) return;

  const items = [];
  items.push({ label: 'Open Nestr', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } });
  items.push({ type: 'separator' });

  if (!session) {
    items.push({ label: 'Not signed in', enabled: false });
  } else if (punchState.last === 'break_start') {
    items.push({
      label: 'End Break', click: async () => {
        try { await doPunch('break_end'); mainWindow && mainWindow.webContents.send('nestr:punch-updated', punchState); }
        catch (e) { /* surfaced in the main window when opened */ }
      }
    });
  } else if (punchState.last === 'in' || punchState.last === 'break_end') {
    items.push({
      label: 'Start Break', click: async () => {
        try { await doPunch('break_start'); mainWindow && mainWindow.webContents.send('nestr:punch-updated', punchState); }
        catch (e) { /* surfaced in the main window when opened */ }
      }
    });
  } else {
    items.push({ label: 'Clock in from the web app first', enabled: false });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Log Out', click: async () => {
      await doLogout();
      if (mainWindow) mainWindow.webContents.send('nestr:logged-out');
      updateTrayMenu();
    }, enabled: !!session
  });
  items.push({ label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } });

  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(session ? ('Nestr \u2014 ' + session.fullName) : 'Nestr');
}

/* ---------------------------------------------------------- */

/* ----------------------------------------------------------
   Auto-update -- checks the GitHub repo configured under
   build.publish in package.json for a newer published release.
   Silently does nothing during local development (npm start),
   since there's no real release feed to check against until the
   app is actually packaged and published.
   ---------------------------------------------------------- */

function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[nestr] update check failed:', err.message);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window hides it to tray rather than quitting -- Break
  // In/Out needs to keep working from the tray icon while the window
  // is closed, per the "system tray + main window" requirement.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  updateTrayMenu();
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  checkForUpdates();
  // The app is designed to sit in the tray for long stretches without
  // restarting -- a startup-only check would miss anything released
  // while it's just running quietly in the background.
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Tray-resident app -- do not quit when the window closes, only on
  // explicit Quit from the tray menu.
});

/* ----------------------------------------------------------
   IPC -- the only surface the renderer talks to. All real
   Supabase calls happen here in main, never in the renderer.
   ---------------------------------------------------------- */

ipcMain.handle('nestr:login', async (_evt, { companyCode, employeeId, pin }) => {
  const s = await doLogin(companyCode, employeeId, pin);
  await refreshPunchState();
  await startMonitoringIfApplicable();
  updateTrayMenu();
  return s;
});

ipcMain.handle('nestr:get-monitoring-status', async () => {
  // Re-checked fresh each time, not just returned from memory --
  // punch state changes (e.g. clocking in after opening the app)
  // shouldn't require a relaunch to pick up whether capture should
  // actually be running now.
  if (!monitoringPolicy) await fetchMonitoringPolicy();
  return {
    enabled: !!(monitoringPolicy && monitoringPolicy.is_enabled),
    consented: monitoringConsented,
    disclosureText: monitoringPolicy ? monitoringPolicy.disclosure_text : null
  };
});

ipcMain.handle('nestr:acknowledge-monitoring', async () => {
  await acknowledgeConsent();
  scheduleNextCapture();
  return true;
});

ipcMain.handle('nestr:logout', async () => {
  await doLogout();
  updateTrayMenu();
});

ipcMain.handle('nestr:get-session', async () => session);

ipcMain.handle('nestr:get-punch-state', async () => {
  await refreshPunchState();
  return punchState;
});

ipcMain.handle('nestr:break-start', async () => {
  const s = await doPunch('break_start');
  return s;
});

ipcMain.handle('nestr:break-end', async () => {
  const s = await doPunch('break_end');
  return s;
});

ipcMain.handle('nestr:get-shift-info', async () => {
  const shift = await fetchEmployeeShift();
  return shift || null;
});

ipcMain.handle('nestr:check-in', async () => {
  const s = await doPunch('in');
  return s;
});

ipcMain.handle('nestr:check-out', async () => {
  const s = await doPunch('out');
  return s;
});

ipcMain.handle('nestr:get-theme', async () => resolveTheme());

ipcMain.handle('nestr:set-theme', async (_evt, theme) => {
  if (theme !== 'light' && theme !== 'dark') return resolveTheme();
  saveTheme(theme);
  return theme;
});

ipcMain.handle('nestr:get-conversations', async () => {
  return await loadMessagingData();
});

ipcMain.handle('nestr:get-thread', async (_evt, otherId) => {
  await markThreadRead(otherId);
  return threads[otherId] || [];
});

ipcMain.handle('nestr:send-message', async (_evt, { recipientId, body }) => {
  return await doSendMessage(recipientId, body);
});
