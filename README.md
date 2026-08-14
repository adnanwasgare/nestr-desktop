# Nestr Desktop

A Windows desktop companion for Nestr: sign in, Break In / Break Out, and
direct messaging. Built with Electron, using the exact same Supabase
project, auth flow, and database logic as the web app — nothing new was
added on the backend.

## Easiest way to get a real .exe: GitHub Actions

This repo includes `.github/workflows/build-windows.yml`, which builds
the actual Windows installer on GitHub's own hosted Windows machines —
no local Node.js, no Windows machine on your end, nothing to install
yourself.

1. Push this folder to a new GitHub repository (public or private —
   private repos get free CI minutes too, just a lower monthly cap).
2. Go to the repo's **Actions** tab. The build starts automatically on
   push, or click **"Build Windows Installer" → "Run workflow"** to
   trigger it manually.
3. Once it finishes (a few minutes), open the completed run and
   download the **nestr-desktop-windows** artifact from the Summary
   page — that's the real, compiled `.exe`.

Nothing is published anywhere public by this — the artifact is only
visible to people with access to the repo, and only for a limited
retention period (GitHub's default is 90 days).

## Message notifications

Native Windows notifications for new messages, on by default — no
setting to turn on, nothing extra to configure. Suppressed only when
the app window is already focused, since a popup on top of what
you're already looking at would just be redundant. Clicking a
notification brings the app to the front and opens that conversation
directly.

## Monitoring (screen activity + periodic screenshots)

Entirely gated by your company's own `monitoring_policies` row —
nothing here is hardcoded. If `is_enabled` is off, none of this runs
at all; nothing is captured, no consent prompt appears. When it's on:

- On login, the app checks whether you've acknowledged the **current**
  version of the disclosure. If not, you see the actual disclosure
  text from the database and must accept before anything is captured.
  A persisted acknowledgement is versioned — if the company changes
  the policy later, you're asked again for the new version specifically.
- A small banner stays visible in the main window the whole time
  monitoring is active, so it's never silent or hidden.
- Screenshots are taken at a randomized interval around whatever
  `screenshot_interval_seconds` is configured (currently 600s / 10min
  for this company — **not** a hardcoded 15 minutes; it reads the real
  policy value, which is why it won't match if you were expecting 15).
  Randomized rather than a fixed clock tick, same reasoning real
  monitoring tools use.
- Only captures while actually checked in (not on break, not clocked
  out) if `capture_only_when_checked_in` is on — which it is by
  default for this company.
- If `blur_screenshots` is on, the stored image itself is blurred
  (shrunk and rescaled), not just displayed blurred later — the raw
  file on disk is genuinely altered, not just styled differently when
  viewed.
- Device registration and hourly activity aggregates
  (`activity_days` — active/idle seconds, in-shift vs outside-shift)
  update automatically in the background.

**Not included yet**: the web app's admin page for actually *viewing*
this data (`page-activity-screenshots.php`) is still the same static
placeholder it's been all session — this app writes real data into
the real tables, but nothing on the web side reads it yet. That's a
separate, substantial follow-up, not done here.

## What this does NOT include (by design)

- **Clock In / Clock Out.** Only Break In/Out, matching what was asked
  for. The `punch()` database function only allows a break to start if
  you're already clocked in — so Break In here will correctly fail
  with a clear message if you haven't clocked in from the web app
  first. This app doesn't offer clock in/out at all, so that's expected,
  not a bug.
- Anything beyond messaging and attendance breaks — no other pages,
  no admin features, nothing else from the web app.

## Setup for local development (alternative to GitHub Actions)

You'll need [Node.js](https://nodejs.org) installed (18+ recommended).

```
npm install
```

This pulls in Electron, Supabase's JS client, and electron-builder.
Requires internet access — this step could not be run in the sandbox
this app was built in, so it's genuinely untested end-to-end. Report
back anything that breaks here and it can be fixed quickly.

## Run it during development

```
npm start
```

Opens the app in a window, exactly as it'll behave once installed —
useful for testing without building an installer each time.

## Build the actual Windows installer

```
npm run build:win
```

Produces a `.exe` installer in `dist/` using `electron-builder` (NSIS
installer, matching the config already in `package.json`). This step
also needs internet access the first time, since electron-builder
downloads a small Electron binary for Windows if you're not building
on Windows itself.

## The full screen flow

Six screens now, not a single login form: Company Code → Employee ID +
PIN → Monitoring Consent (only shown if your company has monitoring
enabled and you haven't acknowledged the current version) → Check In
(mandatory, no skip — you can't reach the dashboard without it) → a
single unified Dashboard with a live worked-time timer, Start
Break/End Break, Check Out, and a Messenger button with an unread
badge → Messenger, reached from that button, not a separate tab.

**Why consent comes after login, not before**: the disclosure text and
consent tracking are both scoped to a specific company
(`monitoring_policies`/`monitoring_acknowledgements` are keyed to
`company_id`), and the only way to know which company's policy to
check is by actually completing sign-in with all three fields. The
Company Code screen exists as its own step for pacing, but the real
authentication call only fires once Employee ID and PIN are submitted
too.

Same three fields under the hood as always: Company Code, Employee ID,
PIN. An anonymous Supabase session is created, then the existing
`sign-in` Edge Function (already live — same one the web app calls)
validates the PIN and attaches company/employee claims, then the
session is refreshed to pick those up. Nothing new to deploy for this
to work.

Per your choice earlier: **the PIN is required every time the app
launches.** There's no persistent login — the session lives only in
memory for as long as the app process is running, and quitting the app
(not just closing the window) clears it completely.

## Installer monitoring notice (experimental, likely needs iteration)

An additional page during installation, checked by default: an
acknowledgement that the device is company equipment subject to
monitoring, matching the equipment-use agreement companies already
have employees sign separately. **This is not the real consent
mechanism and can't be** — the installer runs before anyone signs in,
so there's no employee or company to attach a real record to. The
actual, mandatory consent gate (tied to a real employee and a real
policy version, written to `monitoring_acknowledgements`) is still the
in-app screen after login, completely unchanged by this.

**Honest risk flag**: this is written in NSIS, a different scripting
language from the rest of this project, and nothing about it could be
compiled or tested in the environment this was built in — unlike
every other file here. If `npm run build:win` fails specifically at
the installer-build step, that's the most likely place, not a sign
something else broke. Paste back the exact error and it can be fixed
directly. The script lives in `installer/monitoring-notice.nsh` if
you want to look at or adjust the wording yourself.

## Check In / Check Out

This is new scope beyond the original "Break In/Out only" request —
confirmed before building. Uses the same `punch()` function as
everything else, just with `p_type: 'in'`/`'out'` instead of
`'break_start'`/`'break_end'`. If something else checks you out
externally (the web app, for instance) while this app is open, the
dashboard notices on its next refresh and sends you back to the
Check In screen rather than showing a dashboard for a day that
already ended.

## Light / dark theme

Defaults to matching your Windows system theme on first launch, with
a manual toggle (top-right of the dashboard) to override it. Unlike
the login session, your theme choice is deliberately allowed to
persist across launches — it's a UI preference, not anything
security-sensitive, so it's saved to a small local settings file kept
entirely separate from anything session-related.

## Releasing updates without reinstalling

Once you have a GitHub account, three one-time setup steps, then
releases work automatically from there on:

1. Create a repository named `nestr-desktop` (public or private, both
   work) and push this project to it.
2. Open `package.json` and replace `YOUR_GITHUB_USERNAME` under
   `build.publish.owner` with your actual GitHub username.
3. Commit and push that change.

**From then on, releasing an update is just two commands:**

```
npm version patch
git push --follow-tags
```

`npm version patch` bumps the version number in `package.json`
automatically (use `minor` or `major` instead of `patch` for bigger
changes) and creates a matching git tag. Pushing that tag is what
triggers the GitHub Actions workflow to build *and actually publish* a
real release this time — not just a downloadable build artifact like
a plain push produces.

Anyone who already has the app installed will pick up that new
version automatically: the app checks for updates on launch and every
4 hours while it's running in the tray, downloads in the background,
and prompts to restart when it's ready. Nobody needs to visit
anywhere or download an installer again after their first install.

**A plain push to `main`** (not a version tag) still just builds, the
same as before this feature was added — useful for confirming
something compiles without publishing a public release every time you
commit.

## Tray icon

Closing the window hides it to the system tray rather than quitting —
Break In/Out stays reachable from the tray icon's right-click menu
without the main window open. The tray menu only shows whichever
action is actually valid next (Start Break / End Break / a disabled
note if you're not clocked in), matching how the web Punch Panel
behaves. Quitting the app is a separate, explicit option in that same
menu.

## One thing worth fixing separately, found while building this

Both `attendance.js` and `punch.js` in the **web app** call the
`company_timezone` database function with no argument, even though it
requires `p_company_id` with no default. Both calls silently catch the
resulting error and fall back to a hardcoded `Asia/Kolkata`, so nothing
ever surfaced this — but it likely means "what day is today" has been
computed using the wrong timezone for any company not actually in
Asia/Kolkata, across the whole product, this whole time. This desktop
app calls the same function correctly (with `p_company_id`). Worth a
quick follow-up fix in the web app's two files — did not touch them
here since it's outside this app's scope.
