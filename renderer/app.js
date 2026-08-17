(function () {
  'use strict';

  var session = null;
  var companyCode = '';
  var conversations = [];
  var activeThreadId = null;
  var timerHandle = null;

  function el(id) { return document.getElementById(id); }
  function initials(name) {
    return (name || '').split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function two(n) { return n < 10 ? '0' + n : String(n); }

  // Wraps the browser's geolocation API in a promise -- Electron's
  // renderer process is a real browser window (unlike the main
  // process, where this API doesn't exist at all), so this can live
  // here directly. Same error-message reasoning as the web app's
  // own copy of this helper: permission-denied needs different
  // guidance than a timeout.
  function getLocation() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        console.warn('[nestr] this device has no geolocation support');
        resolve(null);
        return;
      }
      // These options replace { enableHighAccuracy: true, timeout:
      // 15000, maximumAge: 0 }, which is close to the worst possible
      // combination for a desktop PC.
      //
      // maximumAge is the important one. It defaults to 0, meaning
      // "resolve a fresh position every time, never reuse one". A
      // laptop with GPS manages that; a desktop has no GPS at all, so
      // Windows locates it by scanning nearby Wi-Fi networks. On a
      // machine that is wired, or has Wi-Fi switched off, there is
      // nothing to scan and Windows reports POSITION_UNAVAILABLE --
      // which is exactly the "couldn't determine your location"
      // message people were seeing while Windows logged the request as
      // successfully received.
      //
      // Allowing a position from the last five minutes means a machine
      // that resolved once keeps working, instead of failing on every
      // punch.
      //
      // enableHighAccuracy stays false deliberately: it asks for GPS,
      // which a desktop does not have, and makes the request slower
      // and MORE likely to fail on exactly the hardware struggling
      // here. Attendance needs to know the building, not the desk.
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        function (err) {
          var msg;
          if (err.code === err.PERMISSION_DENIED) {
            // Named specifically rather than generically -- this app
            // only ever runs on Windows (no Mac/Linux build exists),
            // so there's no reason to hedge with vague, cross-platform
            // wording the way the web app's equivalent message
            // correctly does, since that one genuinely runs
            // everywhere. The second sentence covers the specific,
            // real case this session actually ran into on a client
            // laptop: Settings shows location as already on, but a
            // corporate/MDM policy silently overrides that at a level
            // no in-app message could detect directly -- naming this
            // possibility at least points someone toward asking IT,
            // rather than leaving them stuck re-checking a setting
            // that already looks correct.
            msg = 'Location access is blocked for Nestr. Enable it in Windows Settings \u2192 Privacy & security \u2192 Location, then try again. If it\u2019s already turned on there and this keeps happening, your organization\u2019s IT policy may be blocking it \u2014 worth checking with them.';
          } else if (err.code === err.TIMEOUT) {
            msg = 'Getting your location took too long. Check your device\u2019s location/GPS is on, then try again.';
          } else {
            // POSITION_UNAVAILABLE. On a desktop this is usually not a
            // settings problem at all -- Windows locates a machine
            // without GPS by scanning Wi-Fi, so a wired PC with Wi-Fi
            // off has nothing to work from. Saying "check location is
            // on" sends people to a setting that is already correct,
            // which is where this message previously left them.
            msg = 'Windows couldn\u2019t work out where this computer is. ' +
                  'Desktop PCs have no GPS, so Windows uses nearby Wi-Fi networks \u2014 ' +
                  'if this machine is on a wired connection with Wi-Fi switched off, turn Wi-Fi on ' +
                  '(it doesn\u2019t need to be connected) and try again. ' +
                  'Otherwise you can check in from the Nestr website on your phone.';
          }
          // Resolved rather than rejected.
          //
          // The main process now records a punch or sign-in without
          // coordinates when the device cannot supply them, so
          // rejecting here would block the very case that change was
          // made to allow -- a wired desktop, which Windows cannot
          // locate at all.
          //
          // The message is still logged, so the reason is visible when
          // someone asks why their location is missing.
          console.warn('[nestr] location unavailable:', msg);
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 }
      );
    });
  }

  var SCREENS = ['company', 'login', 'consent', 'checkin', 'dashboard', 'messenger'];
  function showScreen(which) {
    SCREENS.forEach(function (s) { el(s + '-screen').hidden = s !== which; });
  }

  /* ---------------- Theme ---------------- */
  var ICON_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_LOGOUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';

  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    var btn = el('theme-toggle-btn');
    if (btn) btn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
  }

  function initTheme() {
    window.nestrAPI.getTheme().then(applyTheme);
    el('theme-toggle-btn').innerHTML = ICON_MOON;
    el('logout-btn').innerHTML = ICON_LOGOUT;
  }

  el('theme-toggle-btn').addEventListener('click', function () {
    var current = document.body.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    window.nestrAPI.setTheme(next).then(applyTheme);
  });

  /* ---------------- 1. Company code ---------------- */
  el('company-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var val = el('company-code').value.trim();
    if (!val) return;
    companyCode = val;
    el('login-company-code').textContent = companyCode;
    showScreen('login');
    el('employee-id').focus();
  });

  /* ---------------- 2. Employee login ---------------- */
  var loginForm = el('login-form');
  var loginBtn = el('login-btn');
  var loginError = el('login-error');

  el('login-back-btn').addEventListener('click', function () {
    loginError.hidden = true;
    showScreen('company');
  });

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in\u2026';

    var employeeId = el('employee-id').value.trim();
    var pin = el('pin').value;

    // Location is mandatory at login here too, matching the web app
    // -- same reasoning as the four punch handlers above.
    getLocation()
      .then(function (loc) { return window.nestrAPI.login(companyCode, employeeId, pin, loc); })
      .then(function (s) {
        session = s;
        el('pin').value = '';
        return window.nestrAPI.getMonitoringStatus();
      })
      .then(function (status) {
        if (status.enabled && !status.consented) {
          el('consent-text').textContent = status.disclosureText || '';
          showScreen('consent');
        } else {
          routeAfterAuth();
        }
      })
      .catch(function (err) {
        loginError.textContent = (err && err.message) || 'Sign in failed. Try again.';
        loginError.hidden = false;
      })
      .then(function () {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign in';
      });
  });

  /* ---------------- 3. Monitoring consent ---------------- */
  el('consent-accept-btn').addEventListener('click', function () {
    var btn = el('consent-accept-btn');
    btn.disabled = true;
    window.nestrAPI.acknowledgeMonitoring()
      .then(routeAfterAuth)
      .catch(function () { btn.disabled = false; });
  });

  /* ---------------- 4. Check in (mandatory, but only if not already checked in) ---------------- */

  // Login doesn't mean "not checked in yet" -- someone could already
  // be mid-day from an earlier launch, or from the web app entirely.
  // Ask the database what's actually true before deciding whether to
  // show Check In at all, rather than assuming a fresh login always
  // means a fresh day.
  function routeAfterAuth() {
    return window.nestrAPI.getPunchState().then(function (state) {
      if (state.last === 'in' || state.last === 'break_start' || state.last === 'break_end') {
        enterDashboard(state);
      } else {
        goToCheckIn();
      }
    });
  }

  function goToCheckIn() {
    el('checkin-name').textContent = 'Welcome, ' + (session.fullName || '').split(' ')[0];
    showScreen('checkin');

    // Soft warning only, per the confirmed design -- check-in is
    // still allowed either way, this just flags it clearly rather
    // than silently accepting or blocking it outright. Fetched fresh
    // each time this screen is shown, not cached across it, since
    // the point is to reflect "right now" against the shift.
    var warnEl = el('checkin-warning');
    warnEl.hidden = true;
    window.nestrAPI.getShiftInfo().then(function (shift) {
      if (!shift || !shift.start_time) return;
      var now = new Date();
      var parts = shift.start_time.split(':');
      var shiftStart = new Date(now);
      shiftStart.setHours(+parts[0], +parts[1], 0, 0);
      var diffMins = Math.round((now - shiftStart) / 60000);
      var graceMins = (shift.grace_minutes != null) ? shift.grace_minutes : 15;

      if (diffMins < -60 || diffMins > graceMins) {
        var label = diffMins < 0
          ? Math.abs(diffMins) + ' minutes before your shift starts'
          : diffMins + ' minutes after your shift started';
        warnEl.textContent = 'This is ' + label + ' (' + shift.name + ', ' + shift.start_time.slice(0, 5) + ').';
        warnEl.hidden = false;
      }
    });
  }

  el('checkin-btn').addEventListener('click', function () {
    var btn = el('checkin-btn');
    var errEl = el('checkin-error');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Checking in\u2026';

    // Location is mandatory for every punch, same as the web app --
    // captured fresh right before the action, not cached.
    getLocation()
      .then(function (loc) { return window.nestrAPI.checkIn(loc); })
      .then(function (state) { enterDashboard(state); })
      .catch(function (err) {
        errEl.textContent = (err && err.message) || 'Could not check in.';
        errEl.hidden = false;
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Check in';
      });
  });

  /* ---------------- 5. Dashboard ---------------- */
  function enterDashboard(knownState) {
    el('who-name').textContent = session.fullName;
    el('who-avatar').textContent = initials(session.fullName);
    showScreen('dashboard');
    // Use the state the check-in call itself just returned rather than
    // immediately re-fetching -- a fresh read right after that write
    // risks a race where it hasn't landed yet, which would incorrectly
    // bounce someone back to check-in right after they just succeeded.
    if (knownState) renderPunchState(knownState);
    else refreshPunchStatus();
    refreshUnreadBadge();
  }

  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return two(Math.floor(s / 3600)) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60);
  }

  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }

  function startTimer(firstIn, breakMs) {
    stopTimer();
    function tick() {
      var elapsed = Date.now() - new Date(firstIn).getTime() - (breakMs || 0);
      el('punch-timer').textContent = fmtElapsed(elapsed);
    }
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  function renderPunchState(state) {
    el('punch-error').hidden = true;
    var breakBtn = el('break-btn');
    var checkoutBtn = el('checkout-btn');

    if (!state.last || state.last === 'out') {
      // Reachable if someone got checked out from elsewhere (e.g. the
      // web app) while this session was open -- back to check-in
      // rather than showing a dashboard for a day that already ended.
      stopTimer();
      goToCheckIn();
      return;
    }

    if (state.last === 'break_start') {
      el('punch-status').textContent = "You're on a break";
      el('punch-since').textContent = '';
      el('punch-timer').textContent = 'On break';
      stopTimer();
      breakBtn.textContent = 'End break';
      breakBtn.onclick = function () { doPunchAction(getLocation().then(function (loc) { return window.nestrAPI.breakEnd(loc); })); };
      checkoutBtn.disabled = false;
      return;
    }

    el('punch-status').textContent = "You're checked in";
    el('punch-since').textContent = state.firstIn ? ('Since ' + timeLabel(state.firstIn)) : '';
    startTimer(state.firstIn, state.breakMs);
    breakBtn.textContent = 'Start break';
    breakBtn.onclick = function () { doPunchAction(getLocation().then(function (loc) { return window.nestrAPI.breakStart(loc); })); };
    checkoutBtn.disabled = false;
  }

  function doPunchAction(promise) {
    el('break-btn').disabled = true;
    el('checkout-btn').disabled = true;
    promise.then(renderPunchState).catch(function (err) {
      el('punch-error').textContent = (err && err.message) || 'Could not record that.';
      el('punch-error').hidden = false;
    }).then(function () {
      el('break-btn').disabled = false;
      el('checkout-btn').disabled = false;
    });
  }

  function refreshPunchStatus() {
    window.nestrAPI.getPunchState().then(renderPunchState).catch(function () {
      el('punch-status').textContent = 'Could not load your status';
    });
  }

  el('checkout-btn').addEventListener('click', function () {
    doPunchAction(
      getLocation()
        .then(function (loc) { return window.nestrAPI.checkOut(loc); })
        .then(function (state) {
          stopTimer();
          return state;
        })
    );
  });

  el('logout-btn').addEventListener('click', function () {
    stopTimer();
    window.nestrAPI.logout().then(function () {
      session = null; companyCode = ''; conversations = []; activeThreadId = null;
      el('company-code').value = '';
      showScreen('company');
    });
  });

  window.nestrAPI.onLoggedOut(function () {
    stopTimer();
    session = null;
    showScreen('company');
  });

  window.nestrAPI.onPunchUpdated(function (state) {
    // A break toggled from the tray while the window was open.
    renderPunchState(state);
  });

  /* ---------------- 6. Messenger ---------------- */
  el('messenger-btn').addEventListener('click', function () {
    showScreen('messenger');
    activeThreadId = null;
    el('thread-view').hidden = true;
    el('conv-search').value = '';
    loadConversations();
  });
  el('messenger-back-btn').addEventListener('click', function () { showScreen('dashboard'); });
  el('thread-back').addEventListener('click', function () {
    el('thread-view').hidden = true;
    // Covers the case where the thread was opened via search and a
    // message was just sent -- that search result is now a real
    // conversation, so a clean reload rather than re-showing
    // whatever was on screen before (stale search results, or a
    // conv-list that hasn't picked up the new conversation yet).
    el('conv-search').value = '';
    loadConversations();
  });

  // Small debounce -- this is a local IPC call, not a network
  // request, but a large company's colleague list is still real
  // computation to redo on every single keystroke.
  var searchDebounce = null;
  el('conv-search').addEventListener('input', function () {
    var query = this.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      if (!query.trim()) { renderConvList(); return; }
      window.nestrAPI.searchPeople(query).then(renderSearchResults);
    }, 150);
  });

  // Android-style badge convention: cap the displayed count rather
  // than showing an arbitrarily long number.
  function fmtBadgeCount(n) {
    return n > 99 ? '99+' : String(n);
  }

  function refreshUnreadBadge() {
    window.nestrAPI.getConversations().then(function (rows) {
      conversations = rows;
      var total = rows.reduce(function (sum, r) { return sum + (r.unread || 0); }, 0);
      var badge = el('messenger-badge');
      badge.textContent = fmtBadgeCount(total);
      badge.hidden = total === 0;
    });
  }

  function loadConversations() {
    window.nestrAPI.getConversations().then(function (rows) {
      conversations = rows;
      renderConvList();
      refreshUnreadBadge();
    });
  }

  function renderConvList() {
    var listEl = el('conv-list');
    if (!conversations.length) {
      listEl.innerHTML = '<div class="empty-state">No messages yet. Search above to message a colleague.</div>';
      return;
    }
    listEl.innerHTML = conversations.map(function (r) {
      var preview = r.last ? (r.last.sender_id === session.employeeId ? 'You: ' : '') + r.last.body : 'No messages yet';
      var avatar = r.isGroup ? '\u{1F465}' : initials(r.name);
      return '<div class="conv-row" data-id="' + r.id + '">' +
        '<div class="avatar"' + (r.isGroup ? ' style="background:#64748b;"' : '') + '>' + avatar + '</div>' +
        '<div style="min-width:0; flex:1;">' +
          '<p class="conv-name">' + r.name + (r.isGroup ? ' <span style="font-weight:400; opacity:0.65;">(group)</span>' : '') + '</p>' +
          '<p class="conv-preview">' + preview + '</p>' +
        '</div>' +
        (r.unread ? '<span class="conv-unread">' + fmtBadgeCount(r.unread) + '</span>' : '') +
      '</div>';
    }).join('');
    listEl.querySelectorAll('.conv-row').forEach(function (row) {
      row.addEventListener('click', function () { openThread(row.getAttribute('data-id')); });
    });
  }

  // Search results render into the same #conv-list element as regular
  // conversations -- one list, showing one or the other depending on
  // whether the search box has anything typed into it, rather than a
  // second, separate list competing for space on a narrow window.
  function renderSearchResults(results) {
    var listEl = el('conv-list');
    if (!results.length) {
      listEl.innerHTML = '<div class="empty-state">No one matches that search.</div>';
      return;
    }
    listEl.innerHTML = results.map(function (p) {
      return '<div class="conv-row" data-id="new:' + p.id + '">' +
        '<div class="avatar">' + initials(p.name) + '</div>' +
        '<div style="min-width:0; flex:1;">' +
          '<p class="conv-name">' + p.name + '</p>' +
          '<p class="conv-preview">' + (p.designation || p.email || '') + '</p>' +
        '</div>' +
      '</div>';
    }).join('');
    listEl.querySelectorAll('.conv-row').forEach(function (row) {
      row.addEventListener('click', function () { openThread(row.getAttribute('data-id')); });
    });
  }

  function openThread(id) {
    var row = conversations.find(function (c) { return c.id === id; });
    el('thread-name').textContent = row ? row.name : '';
    el('thread-view').hidden = false;
    window.nestrAPI.getThread(id).then(function (result) {
      // id might have been a 'new:<employee_id>' virtual row -- the
      // real, resolved conversation_id comes back here, and every
      // call after this point (sending, matching incoming realtime
      // events) needs to use that real id, not the virtual one.
      activeThreadId = result.conversationId;
      renderThread(result.messages);
    });
  }

  function renderThread(messages) {
    var box = el('thread-bubbles');
    if (!messages.length) {
      box.innerHTML = '<div class="empty-state">No messages yet. Say something.</div>';
      return;
    }
    box.innerHTML = messages.map(function (m) {
      var mine = m.sender_id === session.employeeId;
      return '<div class="bubble-row' + (mine ? ' is-mine' : '') + '">' +
        '<div class="bubble">' + m.body + '<span class="bubble-time">' + timeLabel(m.created_at) + '</span></div>' +
      '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function sendCurrentMessage() {
    var input = el('thread-input');
    var body = input.value.trim();
    if (!body || !activeThreadId) return;
    input.value = '';
    window.nestrAPI.sendMessage(activeThreadId, body).then(function () {
      window.nestrAPI.getThread(activeThreadId).then(function (result) {
        activeThreadId = result.conversationId;
        renderThread(result.messages);
      });
    }).catch(function () { input.value = body; });
  }
  el('thread-send').addEventListener('click', sendCurrentMessage);
  el('thread-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendCurrentMessage(); });

  window.nestrAPI.onNewMessage(function (m) {
    refreshUnreadBadge();
    // Only refreshes the visible list if it's actually showing
    // conversations right now -- an incoming message shouldn't wipe
    // out someone's in-progress search results out from under them.
    if (!el('messenger-screen').hidden && !el('conv-search').value.trim()) loadConversations();
    if (activeThreadId && m.conversation_id === activeThreadId) {
      window.nestrAPI.getThread(activeThreadId).then(function (result) {
        renderThread(result.messages);
      });
    }
  });

  window.nestrAPI.onOpenThread(function (conversationId) {
    showScreen('messenger');
    (conversations.length ? Promise.resolve() : window.nestrAPI.getConversations().then(function (rows) {
      conversations = rows;
      renderConvList();
    })).then(function () { openThread(conversationId); });
  });

  /* ---------------- boot ---------------- */
  initTheme();
  // A restored session (see main.js's restoreSessionIfAny) means
  // skipping the company-code/login screens entirely, not just
  // defaulting to showing them regardless. Same monitoring-consent
  // check as the login flow itself, for the same reason: policy
  // could have changed since whatever earlier login actually
  // established this persisted session.
  window.nestrAPI.getSession().then(function (s) {
    if (!s) { showScreen('company'); return; }
    session = s;
    return window.nestrAPI.getMonitoringStatus().then(function (status) {
      if (status.enabled && !status.consented) {
        el('consent-text').textContent = status.disclosureText || '';
        showScreen('consent');
      } else {
        return routeAfterAuth();
      }
    });
  }).catch(function () { showScreen('company'); });
})();
