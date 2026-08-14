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

    window.nestrAPI.login(companyCode, employeeId, pin)
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

    window.nestrAPI.checkIn()
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
    window.nestrAPI.getMonitoringStatus().then(function (status) {
      el('monitoring-banner').hidden = !(status.enabled && status.consented);
    });
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
      breakBtn.onclick = function () { doPunchAction(window.nestrAPI.breakEnd()); };
      checkoutBtn.disabled = false;
      return;
    }

    el('punch-status').textContent = "You're checked in";
    el('punch-since').textContent = state.firstIn ? ('Since ' + timeLabel(state.firstIn)) : '';
    startTimer(state.firstIn, state.breakMs);
    breakBtn.textContent = 'Start break';
    breakBtn.onclick = function () { doPunchAction(window.nestrAPI.breakStart()); };
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
      window.nestrAPI.checkOut().then(function (state) {
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
    loadConversations();
  });
  el('messenger-back-btn').addEventListener('click', function () { showScreen('dashboard'); });
  el('thread-back').addEventListener('click', function () { el('thread-view').hidden = true; });

  function refreshUnreadBadge() {
    window.nestrAPI.getConversations().then(function (rows) {
      conversations = rows;
      var total = rows.reduce(function (sum, r) { return sum + (r.unread || 0); }, 0);
      var badge = el('messenger-badge');
      badge.textContent = total;
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
      listEl.innerHTML = '<div class="empty-state">No colleagues to message yet.</div>';
      return;
    }
    listEl.innerHTML = conversations.map(function (r) {
      var preview = r.last ? r.last.body : 'No messages yet';
      return '<div class="conv-row" data-id="' + r.id + '">' +
        '<div class="avatar">' + initials(r.person.name) + '</div>' +
        '<div style="min-width:0; flex:1;">' +
          '<p class="conv-name">' + r.person.name + '</p>' +
          '<p class="conv-preview">' + preview + '</p>' +
        '</div>' +
        (r.unread ? '<span class="conv-unread">' + r.unread + '</span>' : '') +
      '</div>';
    }).join('');
    listEl.querySelectorAll('.conv-row').forEach(function (row) {
      row.addEventListener('click', function () { openThread(row.getAttribute('data-id')); });
    });
  }

  function openThread(id) {
    activeThreadId = id;
    var person = conversations.find(function (c) { return c.id === id; }).person;
    el('thread-name').textContent = person.name;
    el('thread-view').hidden = false;
    window.nestrAPI.getThread(id).then(renderThread);
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
      window.nestrAPI.getThread(activeThreadId).then(renderThread);
    }).catch(function () { input.value = body; });
  }
  el('thread-send').addEventListener('click', sendCurrentMessage);
  el('thread-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendCurrentMessage(); });

  window.nestrAPI.onNewMessage(function (m) {
    refreshUnreadBadge();
    if (!el('messenger-screen').hidden) loadConversations();
    if (activeThreadId && (m.sender_id === activeThreadId || m.recipient_id === activeThreadId)) {
      window.nestrAPI.getThread(activeThreadId).then(renderThread);
    }
  });

  window.nestrAPI.onOpenThread(function (otherId) {
    showScreen('messenger');
    (conversations.length ? Promise.resolve() : window.nestrAPI.getConversations().then(function (rows) {
      conversations = rows;
      renderConvList();
    })).then(function () { openThread(otherId); });
  });

  /* ---------------- boot ---------------- */
  initTheme();
  showScreen('company');
})();
