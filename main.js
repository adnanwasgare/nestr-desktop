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

function settingsPath() {
  return path.join(app.getPath('userData'), 'nestr-settings.json');
}

function sessionStoragePath() {
  return path.join(app.getPath('userData'), 'nestr-session.json');
}

// A generic key-value store backed by its own file, separate from
// theme settings (nestr-settings.json) so the two can be cleared
// independently -- logging out should wipe the session file without
// touching a saved theme preference, and vice versa.
//
// This REVERSES a deliberate earlier decision: no storage was
// configured on purpose before, specifically so a PIN was required
// on every single launch as a security measure. Requested explicitly
// now, so built properly -- but worth stating plainly that this
// trade-off was intentional before, not an oversight being corrected.
const sessionStorage = {
  _read() {
    try { return JSON.parse(fs.readFileSync(sessionStoragePath(), 'utf8')); }
    catch (e) { return {}; }
  },
  _write(obj) {
    try { fs.writeFileSync(sessionStoragePath(), JSON.stringify(obj)); }
    catch (e) { /* non-fatal -- session simply won't persist this run */ }
  },
  getItem(key) {
    const all = this._read();
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  },
  setItem(key, value) {
    const all = this._read();
    all[key] = value;
    this._write(all);
  },
  removeItem(key) {
    const all = this._read();
    delete all[key];
    this._write(all);
  }
};

// storage: sessionStorage -- the actual fix. Previously no storage
// was configured at all (see the comment on sessionStorage above for
// why, and why that's now deliberately being reversed).
//
// realtime.transport: unlike a browser, Node has no built-in
// WebSocket global (pre-22), which is what the Realtime module needs
// to open its live connection for the messenger. The `ws` package was
// already a listed dependency for exactly this, but never actually
// wired in here -- this is that fix.
let supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: sessionStorage, persistSession: true, autoRefreshToken: true },
  realtime: { transport: WebSocket }
});

/* ----------------------------------------------------------
   Theme -- a UI preference, not auth state, kept in its own
   small file, entirely separate from anything session-related.
   ---------------------------------------------------------- */

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

// Shared by doLogin() and the startup session-restore logic below --
// both need to turn a Supabase auth user's app_metadata into this
// app's own session shape.
//
// Includes a real-name lookup because Supabase Auth's own
// user_metadata for full_name is never actually set by the sign-in
// flow -- found the same bug here as the web app's
// employee-dashboard.js had, fixed the same way: queried directly
// from employees, the same proven, working pattern the rest of this
// app's own queries already use, rather than trusting a metadata
// field that's silently always empty.
async function buildSessionFromAuthUser(user, fallbackName) {
  const meta = (user && user.app_metadata) || {};
  if (!meta.company_id || !meta.employee_id) return null;

  const built = {
    companyId: meta.company_id,
    employeeId: meta.employee_id,
    role: meta.employee_role || 'employee',
    fullName: fallbackName || meta.employee_id
  };

  const nameRes = await supabase.from('employees').select('full_name').eq('id', meta.employee_id).maybeSingle();
  if (!nameRes.error && nameRes.data && nameRes.data.full_name) {
    built.fullName = nameRes.data.full_name;
  }
  return built;
}

async function doLogin(companyCode, employeeId, pin, location) {
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

  session = await buildSessionFromAuthUser(refreshed && refreshed.session && refreshed.session.user, employeeId);
  if (!session) {
    throw new Error('Sign in did not return a valid session. Try again.');
  }

  // Location is mandatory at login here too, matching the web app.
  // Recorded after the session above is fully established (the RPC
  // needs a valid session to attach the record to) but before
  // returning success to the renderer. If it fails, signed back out
  // rather than left with a valid session and no location recorded
  // -- otherwise someone could just retry other actions with an
  // already-valid session, bypassing the requirement entirely.
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    try { await supabase.auth.signOut(); } catch (e) { /* ignore -- already failing */ }
    session = null;
    throw new Error('Location is required to sign in.');
  }
  const { error: locErr } = await supabase.rpc('record_login_location', {
    p_latitude: location.lat, p_longitude: location.lng
  });
  if (locErr) {
    try { await supabase.auth.signOut(); } catch (e) { /* ignore -- already failing */ }
    session = null;
    throw new Error(locErr.message || 'Could not record your location. Try again.');
  }

  return session;
}

async function doLogout() {
  try { await supabase.auth.signOut(); } catch (e) { /* ignore -- clearing local state regardless */ }
  unsubscribePunchRealtime();
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

let punchRealtimeChannel = null;

// Keeps this app's punch state in sync with punches made anywhere
// else -- the web app, or this same person's account open on a
// different machine. Without this, a check-in on the web wouldn't
// show up here until something else happened to trigger a refresh
// (opening the app, clicking something), which could mean this app's
// UI and tray disagree with reality for an entire day.
function subscribePunchRealtime() {
  if (punchRealtimeChannel || !session) return;
  punchRealtimeChannel = supabase
    .channel('nestr-desktop-punches')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'attendance_punches',
      filter: 'employee_id=eq.' + session.employeeId
    }, async () => {
      // A single payload row isn't enough to correctly recompute
      // breakMs (that needs the whole day's punches paired up), so a
      // full refresh rather than patching in just the new row.
      try {
        await refreshPunchState();
        updateTrayMenu();
        if (mainWindow) mainWindow.webContents.send('nestr:punch-updated', punchState);
      } catch (e) {
        console.error('[nestr] punch realtime refresh failed:', e);
      }
    })
    .subscribe();
}

function unsubscribePunchRealtime() {
  if (punchRealtimeChannel) {
    supabase.removeChannel(punchRealtimeChannel);
    punchRealtimeChannel = null;
  }
}

async function doPunch(type, location) {
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    throw new Error('Location is required to record this.');
  }
  // Face verification is enforced by refusing the punch here, not by
  // performing it.
  //
  // The web app captures a photo and matches it against the person's
  // enrolment. This app cannot -- it has no face model and no camera
  // capture in the punch flow -- so if it punched anyway, anyone
  // subject to face checks could skip them entirely by using the
  // desktop app. That would not be a gap in the feature so much as a
  // documented way around it.
  //
  // Refusing and pointing at the web app is the honest behaviour until
  // this app can do the check itself.
  const faceRequired = await faceVerificationRequired();
  if (faceRequired) {
    throw new Error(
      'Your company requires face verification at check-in. ' +
      'Please check in from the Nestr website or mobile app.'
    );
  }

  const { error } = await supabase.rpc('punch', {
    p_type: type, p_source: 'agent', p_latitude: location.lat, p_longitude: location.lng
  });
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

/**
 * Whether this employee must verify their face to check in.
 *
 * Read at punch time rather than cached: a company can enable face
 * verification at any moment, and a stale answer here means either
 * blocking someone who no longer needs it, or letting through someone
 * who now does.
 *
 * Fails OPEN -- if the policy can't be read, the punch proceeds. An
 * employee unable to record attendance because a settings lookup timed
 * out is a worse outcome than an unverified punch, and matches how the
 * web app treats the same failure.
 */
async function faceVerificationRequired() {
  try {
    const { data: pol, error: polErr } = await supabase
      .from('monitoring_policies')
      .select('face_attendance_enabled, face_attendance_scope')
      .eq('company_id', session.companyId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (polErr || !pol || !pol.face_attendance_enabled) return false;

    const { data: emp } = await supabase
      .from('employees')
      .select('work_mode')
      .eq('id', session.employeeId)
      .maybeSingle();

    const mode = ((emp && emp.work_mode) || 'office').toLowerCase();
    // 'field' scope means only field staff are checked; office workers
    // punching from a desk are unaffected.
    return pol.face_attendance_scope === 'all' || mode === 'field';
  } catch (e) {
    console.error('[nestr] face policy check failed, allowing punch:', e && e.message);
    return false;
  }
}

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

/**
 * Encodes a captured screen to WebP, falling back to JPEG.
 *
 * Electron's nativeImage can produce PNG and JPEG but has no WebP
 * encoder, so this borrows the renderer's -- the renderer is Chromium,
 * which encodes WebP natively. The image is handed over as a data URL,
 * drawn to a canvas there, and comes back encoded.
 *
 * Two things this deliberately guards against:
 *
 *  - A browser that can't encode WebP does NOT error on
 *    toDataURL('image/webp'); it silently returns a PNG instead. The
 *    prefix is checked rather than trusted, otherwise a PNG would be
 *    uploaded under a .webp name and the saving would quietly not
 *    happen.
 *  - The window may be closed to tray, or not yet created, while
 *    capture continues. Any failure falls through to JPEG, which needs
 *    no renderer and is still far smaller than PNG.
 */
/**
 * One-time notice when monitoring is switched back on.
 *
 * Persisted rather than held in memory so restarting the app doesn't
 * re-announce it every launch, and so someone who was offline when it
 * was re-enabled still finds out on their next start.
 */
function notifyMonitoringResumed() {
  try {
    const seenVersion = sessionStorage.getItem('monitoringResumedNotice');
    const stamp = String(monitoringPolicy.version) + ':on';
    if (seenVersion === stamp) return;
    sessionStorage.setItem('monitoringResumedNotice', stamp);

    new Notification({
      title: 'Activity monitoring resumed',
      body: 'Your administrator has re-enabled activity monitoring for this company.'
    }).show();
  } catch (e) {
    console.error('[nestr] could not show monitoring notice:', e && e.message);
  }
}

async function encodeScreenshot(image) {
  const webp = await encodeViaRenderer(image, 0.72);
  if (webp) return { buffer: webp, ext: 'webp', contentType: 'image/webp' };
  return { buffer: image.toJPEG(70), ext: 'jpg', contentType: 'image/jpeg' };
}

async function encodeViaRenderer(image, quality) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return null;
  try {
    const src = image.toDataURL();
    const out = await mainWindow.webContents.executeJavaScript(
      '(function (src, q) { return new Promise(function (resolve) {' +
      '  var img = new Image();' +
      '  img.onload = function () {' +
      '    try {' +
      '      var c = document.createElement("canvas");' +
      '      c.width = img.naturalWidth; c.height = img.naturalHeight;' +
      '      c.getContext("2d").drawImage(img, 0, 0);' +
      '      var d = c.toDataURL("image/webp", q);' +
      '      resolve(d.indexOf("data:image/webp") === 0 ? d : null);' +
      '    } catch (e) { resolve(null); }' +
      '  };' +
      '  img.onerror = function () { resolve(null); };' +
      '  img.src = src;' +
      '}); })(' + JSON.stringify(src) + ', ' + quality + ')',
      true
    );
    if (!out) return null;
    return Buffer.from(out.split(',')[1], 'base64');
  } catch (e) {
    console.error('[nestr] webp encode failed, falling back to jpeg:', e && e.message);
    return null;
  }
}

async function captureAndUploadScreenshot() {
  // The policy is re-read here, immediately before capturing, rather
  // than relying on the copy fetched at startup.
  //
  // Previously it was only loaded once when monitoring initialised,
  // so an admin switching monitoring off company-wide had no effect on
  // any machine already running -- it kept capturing against a stale
  // policy until the app was restarted, potentially for days. For a
  // control whose entire purpose is "stop this now", that made the
  // switch misleading.
  //
  // Checking here rather than on a separate timer is deliberate: it
  // makes "am I allowed to capture" and "capture" the same operation,
  // so there is no window in which a stale policy permits a screenshot
  // that shouldn't be taken. One extra query per user per interval is
  // a small price for that guarantee.
  const previouslyEnabled = monitoringPolicy && monitoringPolicy.is_enabled;
  await fetchMonitoringPolicy();

  if (!monitoringPolicy || !monitoringPolicy.is_enabled) {
    if (previouslyEnabled) {
      console.log('[nestr] monitoring switched off company-wide -- capture paused');
    }
    // Deliberately does NOT cancel the timer: the loop has to stay
    // alive to notice if monitoring is switched back on.
    return;
  }

  // Off -> on while this app was running: tell the person rather than
  // silently resuming. Consent is recorded against a policy version
  // and toggling doesn't bump it, so nobody is re-prompted -- which
  // makes an explicit notice the only thing standing between this and
  // monitoring quietly restarting unannounced.
  if (!previouslyEnabled) notifyMonitoringResumed();

  if (monitoringPolicy.capture_only_when_checked_in && !isActivelyCheckedIn()) return;

  // Consent is re-checked because the policy may have changed version
  // since startup, and consent is per-version.
  if (!monitoringConsented) {
    await checkConsent();
    if (!monitoringConsented) return;
  }

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

  // WebP where possible, JPEG otherwise. PNG was costing roughly
  // 500KB-1.5MB per capture; WebP at this quality typically lands
  // around 40-80KB for the same screen, which is the difference
  // between tens of GB a month and a few.
  const encoded = await encodeScreenshot(image);
  const storagePath = session.companyId + '/' + session.employeeId + '/' +
    Date.now() + '.' + encoded.ext;

  const { error: upErr } = await supabase.storage.from('screenshots').upload(storagePath, encoded.buffer, {
    contentType: encoded.contentType
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

  // The loop keeps ticking while a policy EXISTS, even when monitoring
  // is currently switched off or unconsented -- it just doesn't
  // capture. Stopping the loop on disable meant nothing was left
  // running to notice a later re-enable, so monitoring stayed off
  // until the app was restarted, which is not what "switch it back
  // on" should mean.
  //
  // The tick itself is one small policy read per interval, and
  // captureAndUploadScreenshot() decides each time whether to
  // actually capture. Where no policy exists at all, this stops
  // properly rather than polling forever for a company that doesn't
  // use monitoring.
  if (!monitoringPolicy) return;

  const base = monitoringPolicy.screenshot_interval_seconds * 1000;
  const jitter = base * (0.8 + Math.random() * 0.4);

  captureTimer = setTimeout(() => {
    captureAndUploadScreenshot().catch((e) => console.error('[nestr] capture failed:', e));
    scheduleNextCapture();
  }, jitter);
}

async function startMonitoringIfApplicable() {
  await fetchMonitoringPolicy();
  // Started whenever a policy exists at all. If it's currently
  // switched off the loop simply doesn't capture -- but it's running,
  // so a later re-enable is picked up without needing a restart.
  if (!monitoringPolicy) return;

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

/* ----------------------------------------------------------
   Messaging -- rebuilt for the conversation-based backend
   (migrations 048-052). Every message now belongs to a
   conversation rather than directly to two people; a
   conversation separately tracks who's in it via
   conversation_participants. This mirrors messages.js's own
   rebuild for the same schema change -- same reasoning, ported
   to this app's IPC architecture rather than direct DOM access.

   Scoped deliberately: reads and participates in both 1:1 and
   group conversations correctly (someone on desktop can see and
   reply to a group message sent from the web app), but doesn't
   add a "create new group" UI here -- that's a larger, separate
   addition, not needed just to fix the regression this session's
   earlier group-chat work introduced for this app specifically.
   ---------------------------------------------------------- */

var conversationMeta = {}; // conversation_id -> {id, isGroup, name, participantIds}

function displayNameForConv(conv) {
  if (conv.isGroup) return conv.name || 'Group';
  var otherId = conv.participantIds.filter((id) => id !== session.employeeId)[0];
  return (people[otherId] && people[otherId].name) || 'Unknown';
}

async function loadMessagingData() {
  const peopleRes = await supabase.rpc('list_messageable_colleagues');
  if (peopleRes.error) throw new Error(peopleRes.error.message);

  people = {};
  (peopleRes.data || []).forEach((e) => { people[e.id] = { name: e.full_name, designation: e.designation, employeeNumber: e.employee_number, email: e.email }; });

  const myConvRes = await supabase
    .from('conversation_participants')
    .select('conversation_id, conversations(id, is_group, name, created_at)')
    .eq('employee_id', session.employeeId)
    .is('left_at', null);
  if (myConvRes.error) throw new Error(myConvRes.error.message);

  conversationMeta = {};
  const myConvIds = (myConvRes.data || []).map((r) => r.conversation_id);
  (myConvRes.data || []).forEach((r) => {
    const c = r.conversations;
    if (!c) return;
    conversationMeta[c.id] = { id: c.id, isGroup: c.is_group, name: c.name, participantIds: [] };
  });

  threads = {};
  if (myConvIds.length) {
    const [partRes, msgRes] = await Promise.all([
      supabase.from('conversation_participants').select('conversation_id, employee_id').in('conversation_id', myConvIds).is('left_at', null),
      supabase.from('messages').select('id, conversation_id, sender_id, recipient_id, body, read_at, created_at').in('conversation_id', myConvIds).order('created_at')
    ]);
    if (partRes.error) throw new Error(partRes.error.message);
    if (msgRes.error) throw new Error(msgRes.error.message);

    (partRes.data || []).forEach((p) => {
      const conv = conversationMeta[p.conversation_id];
      if (conv) conv.participantIds.push(p.employee_id);
    });
    (msgRes.data || []).forEach((m) => {
      (threads[m.conversation_id] = threads[m.conversation_id] || []).push(m);
    });
  }

  subscribeRealtime();
  return buildConversationList();
}

function buildConversationList() {
  // Requested explicitly: only real conversations (at least one
  // message already exchanged) show up here -- not the full
  // employee directory pre-listed as empty rows. Finding someone
  // new to message now happens through search instead, which
  // resolves the same lazy-conversation-creation path (see
  // resolveConversationId below) once an actual message is sent.
  var rows = Object.keys(conversationMeta)
    .filter((id) => (threads[id] || []).length > 0)
    .map((id) => {
      var conv = conversationMeta[id];
      var msgs = threads[id] || [];
      var last = msgs.length ? msgs[msgs.length - 1] : null;
      var unread = conv.isGroup ? 0 : msgs.filter((m) => m.recipient_id === session.employeeId && !m.read_at).length;
      return { id: id, isGroup: conv.isGroup, name: displayNameForConv(conv), last: last, unread: unread };
    });

  // Requested explicitly: unread conversations sort above read ones
  // as their own group, not just wherever their timestamp happens to
  // land -- then most-recent-first within each of those two groups.
  return rows.sort((a, b) => {
    var aUnread = a.unread > 0, bUnread = b.unread > 0;
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    if (a.last && b.last) return new Date(b.last.created_at) - new Date(a.last.created_at);
    if (a.last) return -1;
    if (b.last) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// Search over the full colleague directory (people, already fetched
// by loadMessagingData) rather than only whoever already has a
// conversation -- matches employee number, name, or email, the same
// three fields the web app's own message search already matches.
function searchPeople(query) {
  var q = (query || '').trim().toLowerCase();
  if (!q) return [];
  return Object.keys(people)
    .filter((id) => id !== session.employeeId)
    .map((id) => Object.assign({ id: id }, people[id]))
    .filter((p) => {
      return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
             (p.employeeNumber || '').toLowerCase().indexOf(q) !== -1 ||
             (p.email || '').toLowerCase().indexOf(q) !== -1;
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

async function resolveConversationId(id) {
  if (id.indexOf('new:') !== 0) return id;
  const otherId = id.slice(4);
  const res = await supabase.rpc('create_or_get_conversation', { p_employee_ids: [otherId], p_is_group: false });
  if (res.error) throw new Error(res.error.message);
  const realId = res.data;
  if (!conversationMeta[realId]) {
    conversationMeta[realId] = { id: realId, isGroup: false, name: null, participantIds: [session.employeeId, otherId] };
    threads[realId] = threads[realId] || [];
  }
  return realId;
}

async function doSendMessage(convOrNewId, body) {
  const conversationId = await resolveConversationId(convOrNewId);
  const conv = conversationMeta[conversationId];
  const recipientId = conv && !conv.isGroup ? conv.participantIds.filter((x) => x !== session.employeeId)[0] : null;

  const { data, error } = await supabase.from('messages').insert({
    company_id: session.companyId, conversation_id: conversationId,
    sender_id: session.employeeId, recipient_id: recipientId, body
  }).select('*').single();
  if (error) throw new Error(error.message);

  (threads[conversationId] = threads[conversationId] || []).push(data);
  return { conversationId: conversationId, message: data };
}

async function markThreadRead(conversationId) {
  const conv = conversationMeta[conversationId];
  if (!conv || conv.isGroup) return; // read receipts are 1:1-only, matching the web app
  const unread = (threads[conversationId] || []).filter((m) => m.recipient_id === session.employeeId && !m.read_at);
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
      // Broad by company rather than filtered to "sent to me" --
      // same reasoning as messages.js's own rebuild: a group
      // message has no single recipient to filter by. RLS is what
      // actually gates which rows this app receives.
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: 'company_id=eq.' + session.companyId
    }, (payload) => {
      const m = payload.new;
      if (!conversationMeta[m.conversation_id]) return; // a conversation not yet known locally
      (threads[m.conversation_id] = threads[m.conversation_id] || []).push(m);
      if (mainWindow) mainWindow.webContents.send('nestr:new-message', m);
      updateTrayMenu();
      notifyNewMessage(m.conversation_id, m);
    })
    .subscribe();
}

// On by default, no setting to turn it on -- only suppressed when the
// window is already focused, since the person is actively looking at
// the app at that point and a popup on top would just be redundant
// with what they can already see updating live.
function notifyNewMessage(conversationId, m) {
  if (!Notification.isSupported()) return;
  if (mainWindow && mainWindow.isFocused()) return;

  const conv = conversationMeta[conversationId];
  var title;
  if (conv && conv.isGroup) {
    // Group message -- title the notification with who actually
    // sent it, not the group name, since the group is already
    // implied by opening the thread.
    const sender = people[m.sender_id];
    title = (sender ? sender.name : 'Someone') + ' in ' + (conv.name || 'a group');
  } else {
    const sender = people[m.sender_id];
    title = sender ? sender.name : 'New message';
  }
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
    mainWindow.webContents.send('nestr:open-thread', conversationId);
  });

  notification.show();
}

/* ----------------------------------------------------------
   Tray icon -- Break In/Out reachable without opening the main
   window, mirroring the web Punch Panel's own rule: only offer
   what's actually valid next.
   ---------------------------------------------------------- */

/**
 * Brings the window up so a punch can be made properly.
 *
 * Every punch needs a location, and only the renderer can obtain one.
 * The ellipsis on the tray labels signals that these open something
 * rather than acting immediately.
 */
function showWindowForPunch() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray) return;

  const items = [];
  items.push({ label: 'Open Nestr', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } });
  items.push({ type: 'separator' });

  if (!session) {
    items.push({ label: 'Not signed in', enabled: false });
  // These open the window rather than punching directly.
  //
  // They used to call doPunch() straight from the tray with NO
  // location argument -- which doPunch rejects, because every punch
  // must record where it happened. The error was then swallowed by the
  // catch below, so clicking these did nothing at all, silently, and
  // always had.
  //
  // The main process cannot obtain a location: geolocation lives in
  // the renderer, which is why every working punch path goes through
  // the window. So the honest fix is to open the window rather than
  // pretend the tray can do it.
  } else if (punchState.last === 'break_start') {
    items.push({
      label: 'End Break\u2026', click: () => { showWindowForPunch(); }
    });
  } else if (punchState.last === 'in' || punchState.last === 'break_end') {
    items.push({
      label: 'Start Break\u2026', click: () => { showWindowForPunch(); }
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

// Runs once at startup, before the renderer's first nestr:get-session
// call, so a restored session is already in place by the time it
// asks -- otherwise the renderer would see session === null on that
// first call regardless of what's actually saved on disk, and route
// to the login screen even though a valid session exists.
async function restoreSessionIfAny() {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data || !data.session) return;
    const restored = await buildSessionFromAuthUser(data.session.user, null);
    if (restored) {
      session = restored;
      await refreshPunchState();
      await startMonitoringIfApplicable();
      subscribePunchRealtime();
    }
  } catch (e) {
    // Corrupt or unreadable session file, expired refresh token, etc.
    // -- non-fatal, just falls through to the normal login screen.
    console.error('[nestr] session restore failed:', e);
  }
}

app.whenReady().then(async () => {
  await restoreSessionIfAny();
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

ipcMain.handle('nestr:login', async (_evt, { companyCode, employeeId, pin, location }) => {
  const s = await doLogin(companyCode, employeeId, pin, location);
  await refreshPunchState();
  await startMonitoringIfApplicable();
  subscribePunchRealtime();
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

ipcMain.handle('nestr:break-start', async (event, location) => {
  const s = await doPunch('break_start', location);
  return s;
});

ipcMain.handle('nestr:break-end', async (event, location) => {
  const s = await doPunch('break_end', location);
  return s;
});

ipcMain.handle('nestr:get-shift-info', async () => {
  const shift = await fetchEmployeeShift();
  return shift || null;
});

ipcMain.handle('nestr:check-in', async (event, location) => {
  const s = await doPunch('in', location);
  return s;
});

ipcMain.handle('nestr:check-out', async (event, location) => {
  const s = await doPunch('out', location);
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

ipcMain.handle('nestr:search-people', async (_evt, query) => {
  return searchPeople(query);
});

ipcMain.handle('nestr:get-thread', async (_evt, id) => {
  // id may be a real conversation_id, or a 'new:<employee_id>'
  // virtual row for someone with no conversation yet -- resolved
  // (creating the real conversation lazily if needed) before
  // marking read or returning anything, so the renderer gets back
  // the real id to use for any message it sends in this thread.
  const conversationId = await resolveConversationId(id);
  await markThreadRead(conversationId);
  return { conversationId: conversationId, messages: threads[conversationId] || [] };
});

ipcMain.handle('nestr:send-message', async (_evt, { conversationId, body }) => {
  return await doSendMessage(conversationId, body);
});
