(function () {
  'use strict';

  // Stop the browser from restoring whatever scroll position was in effect
  // when the page was last unloaded. Without this, a reload (or coming
  // back via history) can land with the page scrolled part-way down —
  // which, combined with the sticky header above every .screen, reads as
  // "the top bar is covering part of the page" until you manually scroll
  // up. We always want a fresh load to start at the true top.
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }
  window.scrollTo(0, 0);

  // ------------------------------------------------------------
  // State
  // ------------------------------------------------------------
  // Exposed on window so the live connection can be inspected from
  // chrome://inspect's console while debugging (e.g. window.pbState.pc.iceConnectionState).
  const state = window.pbState = {
    user: null,
    googleClientId: null,
    pendingAction: null, // 'create' | 'join' - what to do after login
    mode: null, // 'together' | 'long_distance'
    photoCount: 3,
    room: null, // latest room object from server
    role: null, // 'host' | 'partner'
    ws: null,
    wsReconnectTimer: null,
    peerDebugTimer: null,
    localStream: null,
    pc: null, // RTCPeerConnection (long distance)
    facingMode: 'user',
    // Starts muted on join by design: two people connecting fresh (often
    // mid-setup, phone speaker right next to the mic) shouldn't be hot-mic'd
    // into each other before either has chosen to talk. Track.enabled is set
    // to match this the moment the stream is created in initLocalCamera(),
    // and every place that paints the mic icon reads this flag rather than
    // assuming "on".
    micOn: false,
    // Guards runCountdownLD() against running twice concurrently. A rapid
    // double-tap on the shutter (or a duplicate 'countdown_start' broadcast
    // — see the guard added server-side in apply_room_action) used to start
    // a second countdown loop on top of the first, still-running one on
    // BOTH clients. That produced two independent capture()+wsSend() calls
    // for the same photo in quick succession, which could land the second
    // one after 'next_photo' had already moved current_photo forward,
    // writing a capture into the wrong slot — the intermittent "error on
    // photo 3 or 4" (later photos = people moving/tapping faster, more
    // likely to double-tap) with no error actually being visible on screen.
    ldCountdownInFlight: false,
    capturedThisPhoto: {}, // {host: dataUrl, partner: dataUrl} for current photo (long distance, client-side before compose)
    finalPhotos: [], // array of composed data URLs (one per photo index), full res
    customization: {
      bgColor: null, frameColor: null, frameWidth: null,
      title: '', subtitle: '', showDate: true, textColor: null,
      orientation: 'vertical', layout: 'strip', spacing: 10,
      stickers: null, filter: 'none',
    },
    templateId: 'minimal-white',
    // See the one-time document listener right below the state object:
    // tracks whether this page has seen a real tap/click yet, independent
    // of the mic button. Used purely to satisfy browser autoplay policy
    // for the *incoming* audio/video element (see ontrack) — it used to be
    // piggybacked on the mic button's click, which wrongly tied "can I
    // hear my partner" to "have I turned my own mic on".
    hasUserGesture: false,
  };

  // Browsers block autoplay of an unmuted <video> unless playback starts
  // from (or after) a real user gesture on the page — attaching a WebRTC
  // track never itself counts as one. Rather than gate that on any one
  // specific button (which wrongly couples it to whatever that button
  // otherwise does), listen once for literally the first tap/click
  // anywhere on the page. By the time anyone reaches the long-distance
  // call screen they've already tapped through several screens to get
  // here (mode choice, room code, camera permission, etc.), so this is
  // almost always already true well before ontrack ever fires — this
  // listener mainly exists as a safety net for the rare case it isn't.
  document.addEventListener('pointerdown', () => {
    if (state.hasUserGesture) return;
    state.hasUserGesture = true;
    // Covers the edge case where ontrack already fired (and force-muted
    // the element for autoplay safety) before this, the page's first
    // tap, happened — unmute whichever remote tile is currently attached.
    // In the ordinary case this is a no-op: hasUserGesture is normally
    // already true well before ontrack ever runs (see comment above).
    const remoteEl = $(state.role === 'host' ? 'ld-video-partner' : 'ld-video-host');
    if (remoteEl && remoteEl.srcObject) remoteEl.muted = false;
  }, true);

  // Placeholder until loadConfig() fetches the real (possibly TURN-enabled)
  // list from the server. STUN-only here as a safety fallback so the app
  // still works (on same/open networks) even if that fetch ever fails.
  let RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // ------------------------------------------------------------
  // Long-distance session persistence — lets a page reload (or a briefly
  // closed tab) rejoin the SAME room automatically instead of dropping back
  // to having to re-enter the room code. Deliberately scoped to
  // long_distance only: 'together' mode is a single device with no server-
  // side photo progress worth resuming, so there's nothing meaningful to
  // reconnect to there.
  const SESSION_KEY = 'pb_ld_session';
  function saveSession(code) {
    try { localStorage.setItem(SESSION_KEY, code); } catch (e) { /* storage unavailable — resume just won't work, not fatal */ }
  }
  function loadSession() {
    try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  // Marks a session as genuinely OVER for this person — used at the two
  // "you're done" landing points (host reaching the customizer, partner
  // reaching the "Thanks for using Photobooth!" screen) rather than only
  // at the final finish/'completed' event. Without this, reloading (or
  // closing and reopening) from either of those screens would resume
  // straight back into the same finished-in-spirit room instead of
  // offering a fresh start. The notice flag survives the reload itself
  // (persisted, not just an in-memory toast) so the "join a new session"
  // nudge still shows up on the NEXT load, once, even though nothing is
  // running yet to show a toast in the moment they actually reload.
  const NEW_SESSION_NOTICE_KEY = 'pb_show_new_session_notice';
  function markSessionEnded() {
    clearSession();
    try { localStorage.setItem(NEW_SESSION_NOTICE_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function toast(msg) {
    const c = $('toast-container');
    const el = document.createElement('div');
    el.className = 'fade-in bg-mp-dark text-white font-bold py-2 px-5 rounded-full shadow-lg text-sm mb-1';
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(() => el.remove(), 2600);
  }

  // Small inline icon set (no external icon font/dependency). Used anywhere
  // an icon needs to change at runtime (e.g. mic on/off); static icons live
  // directly in photobooth.html.
  const ICONS = {
    micOn: '<svg class="icon" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg class="icon" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>',
  };

  function renderProgressDots(containerId, total, currentIndex) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = 'pd' + (i < currentIndex ? ' done' : '') + (i === currentIndex ? ' current' : '');
      el.appendChild(dot);
    }
  }

  function showScreen(id) {
    qsa('.screen').forEach(s => s.classList.remove('active', 'screen-pop'));
    const next = $(id);
    next.classList.add('active');
    // Force a reflow before adding the animation class so the animation
    // reliably restarts even when navigating back to the SAME screen id
    // twice in a row (e.g. error -> retry -> error again) — without this,
    // re-adding a class the element already animated once wouldn't replay it.
    void next.offsetWidth;
    next.classList.add('screen-pop');
    // Always scroll the whole PAGE back to its true top, not just this
    // element into view. scrollIntoView({block:'start'}) was anchoring the
    // .screen section itself flush against the viewport top, which — since
    // the "Manythings Printing" header lives in normal flow above it, not
    // fixed — pushed that header off-screen above the visible area on every
    // navigation, matching the "top bar covering part of the page, have to
    // scroll up" report.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  function showError(message) {
    $('error-message').textContent = message;
    showScreen('screen-error');
  }

  async function api(path, options) {
    const res = await fetch(path, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Mirrors a live self-preview <video> to match how people expect to see
  // themselves (like a mirror), which also reads correctly for framing a
  // shot — un-mirrored feels reversed/wrong-angle on a front camera. Only
  // applies to the front/selfie camera: mirroring the rear camera would
  // flip real-world text and disorient framing, which no camera app does.
  // Shared by both together mode and long-distance mode's own self-video
  // element (never the long-distance remote partner element — their video
  // should show as they actually appear, not mirrored to us).
  function setMirrored(videoEl) {
    videoEl.style.transform = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';
  }

  // ------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------
  async function loadConfig() {
    const cfg = await api('/api/config');
    state.googleClientId = cfg.google_client_id_valid ? cfg.google_client_id : null;
    // Includes a TURN relay (server-configured or the free fallback) so
    // long-distance mode can connect two people on different networks, not
    // just STUN-reachable ones on the same/open network.
    if (Array.isArray(cfg.ice_servers) && cfg.ice_servers.length) {
      RTC_CONFIG = { iceServers: cfg.ice_servers };
    }
  }

  async function checkAuth() {
    const data = await api('/api/auth/me');
    if (data.authenticated) {
      state.user = data.user;
      renderUserChip();
    }
    return data.authenticated;
  }

  function renderUserChip() {
    if (!state.user) return;
    $('user-chip').classList.remove('hidden');
    $('user-chip').classList.add('flex');
    $('user-avatar').src = state.user.avatar_url || '';
    $('user-name').textContent = (state.user.name || '').split(' ')[0] || 'You';
  }

  function initGoogleSignIn() {
    if (!state.googleClientId) {
      $('google-config-warning').classList.remove('hidden');
      $('google-config-warning').textContent =
        'Google sign-in is not configured yet. The server needs a valid GOOGLE_CLIENT_ID environment variable (the one provided had a formatting error).';
      return;
    }
    if (!window.google || !window.google.accounts) {
      setTimeout(initGoogleSignIn, 200);
      return;
    }
    window.google.accounts.id.initialize({
      client_id: state.googleClientId,
      callback: onGoogleCredential,
    });
    window.google.accounts.id.renderButton($('google-btn-container'), {
      theme: 'outline', size: 'large', shape: 'pill', width: 280,
    });
  }

  async function onGoogleCredential(response) {
    try {
      const data = await api('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential: response.credential }),
      });
      state.user = data.user;
      renderUserChip();
      toast(`Welcome, ${(state.user.name || '').split(' ')[0] || 'friend'}!`);
      afterLogin();
    } catch (e) {
      showError(e.message || 'Google sign-in failed.');
    }
  }

  function afterLogin() {
    if (state.pendingAction === 'create') showScreen('screen-mode');
    else if (state.pendingAction === 'join') showScreen('screen-join');
    else showScreen('screen-entry');
  }

  function requireLogin(nextAction) {
    if (state.user) {
      if (nextAction === 'create') showScreen('screen-mode');
      else if (nextAction === 'join') showScreen('screen-join');
      return true;
    }
    state.pendingAction = nextAction;
    showScreen('screen-login');
    initGoogleSignIn();
    return false;
  }

  // ------------------------------------------------------------
  // Entry screen
  // ------------------------------------------------------------
  $('btn-create-room').addEventListener('click', () => requireLogin('create'));
  $('btn-join-room').addEventListener('click', () => requireLogin('join'));
  $('login-back').addEventListener('click', () => showScreen('screen-entry'));
  $('join-back').addEventListener('click', () => showScreen('screen-entry'));
  $('error-home-btn').addEventListener('click', () => {
    clearSession();
    closeAllConnections();
    state.room = null;
    state.role = null;
    state.mode = null;
    showScreen('screen-entry');
  });

  // ------------------------------------------------------------
  // Mode selection -> photo count -> create room
  // ------------------------------------------------------------
  qsa('.mode-card').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.add('tap-bounce');
      state.mode = btn.dataset.mode;
      showScreen('screen-count');
    });
  });

  qsa('.count-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('tap-bounce');
      state.photoCount = parseInt(btn.dataset.count, 10);
      try {
        const data = await api('/api/rooms', {
          method: 'POST',
          body: JSON.stringify({ mode: state.mode, photo_count: state.photoCount }),
        });
        state.room = data.room;
        state.role = data.role;
        if (state.mode === 'together') {
          startTogetherMode();
        } else {
          saveSession(state.room.room_code);
          connectWS(state.room.room_code);
          $('waiting-code').textContent = state.room.room_code;
          showScreen('screen-waiting');
        }
      } catch (e) {
        showError(e.message);
      }
    });
  });

  $('copy-code-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(state.room.room_code).then(() => toast('Code copied!'));
  });
  $('share-code-btn').addEventListener('click', async () => {
    const shareData = { title: 'Join my Photobooth', text: `Join my photobooth room: ${state.room.room_code}`, url: location.origin + '/photobooth?join=' + state.room.room_code };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (e) { /* cancelled */ }
    } else {
      navigator.clipboard.writeText(shareData.url).then(() => toast('Link copied!'));
    }
  });

  // Lets someone deliberately leave a room they no longer want to be
  // resumed into — without this, the "resume after reload" feature has no
  // escape hatch: the persisted room code would just keep sending them
  // straight back into the old room on every future load, blocking them
  // from starting or joining a different one. Available both while still
  // waiting for a partner and once the live camera screen is up.
  function exitRoom() {
    if (!confirm('Exit this room? You can join or start a different one afterward.')) return;
    clearSession();
    closeAllConnections();
    // Fully forget the old room/role rather than just navigating away from
    // it, so nothing left over (e.g. the stale-close guard above, or a
    // stray resync tick) can act on it after this point.
    state.room = null;
    state.role = null;
    state.mode = null;
    showScreen('screen-entry');
    toast('Left the room');
  }
  $('waiting-exit-btn').addEventListener('click', exitRoom);
  $('ld-exit-btn').addEventListener('click', exitRoom);
  $('customize-exit-btn').addEventListener('click', exitRoom);

  // ------------------------------------------------------------
  // Join room
  // ------------------------------------------------------------
  $('join-code-submit').addEventListener('click', doJoin);
  $('join-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  async function doJoin() {
    const code = $('join-code-input').value.trim().toUpperCase();
    $('join-error').classList.add('hidden');
    if (!code) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST' });
      state.room = data.room;
      state.role = data.role;
      state.mode = data.room.mode;
      state.photoCount = data.room.photo_count;
      saveSession(state.room.room_code);
      connectWS(state.room.room_code);
      if (state.role === 'host') {
        startLongDistanceMode();
      } else {
        startLongDistanceMode();
      }
    } catch (e) {
      $('join-error').textContent = e.message;
      $('join-error').classList.remove('hidden');
    }
  }

  // Auto-join via ?join=CODE
  (function checkJoinParam() {
    const params = new URLSearchParams(location.search);
    const joinCode = params.get('join');
    if (joinCode) {
      state.pendingAction = 'join';
      window.addEventListener('DOMContentLoaded', () => {}); // no-op, handled in boot()
      window._autoJoinCode = joinCode.toUpperCase();
    }
  })();

  // ------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------
  function connectWS(roomCode) {
    if (state.ws) { try { state.ws.close(); } catch (e) {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/room/${roomCode}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      if (state.ws !== ws) return; // superseded before the connection even finished opening
      updateConnectionDot(true);
      // Don't rely solely on catching a one-shot 'partner_joined' broadcast —
      // if this connection is a reconnect (e.g. after the free-tier host
      // process went idle/restarted, or the WS briefly dropped), that
      // message may have fired while nobody was listening, and the host
      // would be stuck showing "waiting for partner" forever even though
      // the partner already joined. So every time a WS connection opens
      // (first connect AND every reconnect), re-fetch the room over HTTP
      // and catch the host up if it's still behind.
      syncRoomState(roomCode);
    });
    ws.addEventListener('close', () => {
      // This close handler is bound to THIS specific socket and this
      // specific roomCode via closure. If a newer connectWS() call has
      // already replaced state.ws (e.g. exiting this room and immediately
      // starting/joining another, or a fast double-reconnect), that
      // replacement happens SYNCHRONOUSLY, but the browser still fires
      // this old socket's 'close' event asynchronously afterward. Without
      // this guard, this now-stale handler would go on to check
      // state.room — which by then already points at the NEW room, so it
      // reads as "not completed" — and schedule a reconnect back to the
      // OLD roomCode from this closure, silently pulling the person back
      // into the room they just left. This was the actual cause of
      // "have to Exit Room before I can join a new one".
      if (state.ws !== ws) return;
      updateConnectionDot(false);
      if (state.room && !['completed'].includes(state.room.state)) {
        state.wsReconnectTimer = setTimeout(() => connectWS(roomCode), 1500);
      }
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleWSMessage(msg);
    });
  }

  async function syncRoomState(roomCode) {
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(roomCode)}`);
      if (data.room) state.room = data.room;
      if (data.role) state.role = data.role;
      // TEMP DIAGNOSTIC — remove once the "host stuck on code screen" issue
      // is confirmed fixed. Shows exactly what this function saw and which
      // way the guard below decided, so a stuck host can be diagnosed from
      // the console instead of guessed at blind.
      console.log('[diag] syncRoomState', {
        mode: state.mode, role: state.role,
        has_partner: state.room && state.room.has_partner,
        pc_exists: !!state.pc,
      });
      if (
        state.mode === 'long_distance' &&
        state.role === 'host' &&
        state.room &&
        state.room.has_partner &&
        !state.pc
      ) {
        console.log('[diag] syncRoomState -> calling startLongDistanceMode()');
        startLongDistanceMode().catch(e => console.error('[diag] startLongDistanceMode threw', e));
      }
    } catch (e) { console.error('[diag] syncRoomState failed', e); }
  }

  function wsSend(action, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      toast('Reconnecting…');
      return false;
    }
    state.ws.send(JSON.stringify({ action, payload: payload || {} }));
    return true;
  }

  function updateConnectionDot(connected) {
    const dot = $('ld-connection-dot');
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (connected ? 'bg-green-500' : 'bg-gray-300');
  }

  function handleWSMessage(msg) {
    if (msg.room) {
      // No broadcast (including 'session_complete') carries the full photos
      // history — every one is kept small on purpose (see app.py). Don't
      // let a room update wipe out the photos this client has already
      // cached locally — carry them forward unless the server explicitly
      // sent a fresh, complete photos array (currently only the plain HTTP
      // GET /api/rooms/<code> response does that; see onSessionCompleteLD's
      // fallback fetch).
      const cachedPhotos = state.room ? state.room.photos : undefined;
      state.room = msg.room;
      if (!('photos' in msg.room) && cachedPhotos) state.room.photos = cachedPhotos;
    }

    switch (msg.type) {
      case 'ping':
        wsSend('pong');
        break;
      case 'partner_joined':
        toast('Partner joined!');
        $('ld-partner-placeholder').classList.add('hidden');
        // TEMP DIAGNOSTIC — remove once confirmed fixed.
        console.log('[diag] partner_joined event received', { role: state.role, pc_exists: !!state.pc });
        if (state.role === 'host') {
          if (!state.pc) {
            // Host was still sitting on the "waiting for partner" screen and
            // never set up its camera/peer connection — do that now. Once
            // state.room.has_partner is true, initPeerConnection() will make
            // the offer itself.
            console.log('[diag] partner_joined -> calling startLongDistanceMode()');
            startLongDistanceMode().catch(e => console.error('[diag] startLongDistanceMode threw', e));
          } else {
            console.log('[diag] partner_joined -> pc already exists, calling makeOffer()');
            makeOffer();
          }
        }
        break;
      case 'presence':
        // Uses ld-rtc-status-msg (not ld-status-msg) — this is connection
        // health, same bucket as the ICE state messages above, kept
        // separate from capture-flow progress so the two can never clobber
        // each other (see the HTML comment by ld-rtc-status-msg).
        if (msg.who === 'partner') {
          if (msg.status === 'connected') {
            $('ld-rtc-status-msg').classList.add('hidden');
            toast('Partner reconnected');
            // If we were mid-flow waiting on their photo when they dropped,
            // don't wait for the next 4s resync tick — check right away now
            // that they're actually back, so a reconnect resolves as fast
            // as the network allows instead of adding up to 4 more seconds
            // of "stuck" on top of however long they were disconnected.
            if (state.room && state.room.current_photo != null) {
              resyncCurrentPhoto(state.room.current_photo);
            }
          } else {
            $('ld-rtc-status-msg').textContent = 'Partner disconnected — reconnecting…';
            $('ld-rtc-status-msg').classList.remove('hidden');
            toast('Partner left or disconnected');
            const dot = $('ld-dot-partner');
            if (dot) { dot.classList.remove('live'); dot.classList.add('pulse'); }
          }
        } else if (msg.who === 'host' && state.role === 'partner') {
          if (msg.status !== 'connected') {
            $('ld-rtc-status-msg').textContent = 'Host disconnected — reconnecting…';
            $('ld-rtc-status-msg').classList.remove('hidden');
            toast('Host left or disconnected');
            const dot = $('ld-dot-host');
            if (dot) { dot.classList.remove('live'); dot.classList.add('pulse'); }
          } else {
            $('ld-rtc-status-msg').classList.add('hidden');
            toast('Host reconnected');
          }
        }
        break;
      case 'countdown_start':
        runCountdownLD();
        break;
      case 'photo_captured':
        onPhotoCapturedRemote(msg);
        break;
      case 'retake':
        ldResetPhotoUI();
        break;
      case 'next_photo':
        onNextPhotoLD();
        break;
      case 'session_complete':
        onSessionCompleteLD();
        break;
      case 'template_changed':
      case 'customization_changed':
        if (state.role === 'partner') { /* partner has no customize UI, nothing to do */ }
        break;
      case 'completed':
        onHostFinishedLD();
        break;
      case 'chat':
        addChatMessage(msg);
        break;
      case 'reaction':
        // Only the OTHER person's reaction arrives here (the WS relay
        // excludes the sender), so this is always "they just tapped an
        // emoji" — play it floating up from their side of the video pair.
        spawnFloatingReaction(msg.emoji, msg.who);
        break;
      case 'mic_state': {
        // Previously hardcoded "Partner microphone…" regardless of who
        // actually toggled — since the server already tells us via
        // msg.who ("host" or "partner"), and the WS relay excludes the
        // sender, this event only ever reaches the *other* person anyway.
        // Reading msg.who (rather than assuming it's always the "partner"
        // role) is what makes the toast correct when the host is the one
        // who joins as, e.g., the partner's screen — and keeps it correct
        // if this event's routing ever changes.
        const who = msg.who === 'host' ? 'Host' : 'Partner';
        toast(`${who} microphone ${msg.on ? 'on' : 'muted'}`);
        break;
      }
      case 'webrtc_offer':
        if (msg.from !== state.role) handleRemoteOffer(msg.data);
        break;
      case 'webrtc_answer':
        if (msg.from !== state.role) handleRemoteAnswer(msg.data);
        break;
      case 'webrtc_ice':
        if (msg.from !== state.role) handleRemoteIce(msg.data);
        break;
      case 'error':
        toast(msg.message);
        // If this arrived while we were mid-capture-round-trip in
        // long-distance mode (shutter already hidden/disabled, Retake/Next
        // not up yet because bothIn never got a chance to become true),
        // there was previously no way back — the shutter only re-arms via
        // ldResetPhotoUI(), which only ever ran on a *successful*
        // 'retake'/'next_photo' broadcast. A rejected or failed capture
        // (e.g. the "Message too large" backstop in app.py, or any other
        // server-side rejection) left the screen with zero working
        // buttons. Re-arm the shutter so the host can just tap it again,
        // instead of the session being stuck for good over one bad photo.
        if (state.mode === 'long_distance' && state.role === 'host' &&
            $('ld-host-controls').classList.contains('hidden') &&
            $('ld-host-review').classList.contains('hidden')) {
          ldResetPhotoUI();
        }
        break;
    }
  }

  // ------------------------------------------------------------
  // TOGETHER MODE (single camera)
  // ------------------------------------------------------------
  let togetherCurrentPhoto = 0;
  let togetherStream = null;

  async function startTogetherMode() {
    togetherCurrentPhoto = 0;
    state.finalPhotos = [];
    updateTogetherProgress();
    showScreen('screen-together');
    $('together-camera-error').classList.add('hidden');
    try {
      togetherStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      $('together-video').srcObject = togetherStream;
      setMirrored($('together-video'));
    } catch (e) {
      $('together-camera-error').textContent = 'Camera access was denied or unavailable. Please allow camera permission and try again.';
      $('together-camera-error').classList.remove('hidden');
    }
  }

  function updateTogetherProgress() {
    $('together-progress').textContent = `PHOTO ${togetherCurrentPhoto + 1} / ${state.photoCount}`;
    renderProgressDots('together-progress-dots', state.photoCount, togetherCurrentPhoto);
  }

  $('together-flip').addEventListener('click', async () => {
    $('together-flip').classList.remove('toggle-pop'); void $('together-flip').offsetWidth; $('together-flip').classList.add('toggle-pop');
    const previousFacingMode = state.facingMode;
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
    if (togetherStream) togetherStream.getTracks().forEach(t => t.stop());
    try {
      togetherStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode }, audio: false });
      $('together-video').srcObject = togetherStream;
      setMirrored($('together-video'));
    } catch (e) {
      // Revert — see the matching comment in ld-flip-btn's handler. This
      // mode doesn't have that handler's audio-conflict bug (it never
      // requests audio at all, on either the initial stream or here), but
      // it should still land back on a *working* camera state rather than
      // an unavailable one after a genuine failure (e.g. no back camera
      // on this device).
      state.facingMode = previousFacingMode;
      try {
        togetherStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode }, audio: false });
        $('together-video').srcObject = togetherStream;
        setMirrored($('together-video'));
      } catch (e2) { /* camera was already working before this tap; leave it be */ }
      toast('Could not switch camera');
    }
  });

  $('together-shutter').addEventListener('click', async () => {
    await runCountdown($('together-count'));
    // mirrorOutput=true only on front camera — matches setMirrored()'s own
    // condition, so the saved photo agrees with whatever the live preview
    // was actually showing when the shutter was pressed.
    capturePhotoFromVideo($('together-video'), $('together-canvas'), state.facingMode === 'user').then(dataUrl => {
      flashScreen($('together-flash'));
      $('together-preview-img').src = dataUrl;
      $('together-preview-img').classList.remove('hidden');
      $('together-video').classList.add('hidden');
      $('together-controls').classList.add('hidden');
      $('together-review').classList.remove('hidden');
      state._togetherPendingShot = dataUrl;
    });
  });

  $('together-retake').addEventListener('click', () => {
    $('together-preview-img').classList.add('hidden');
    $('together-video').classList.remove('hidden');
    $('together-review').classList.add('hidden');
    $('together-controls').classList.remove('hidden');
  });

  $('together-next').addEventListener('click', () => {
    state.finalPhotos[togetherCurrentPhoto] = state._togetherPendingShot;
    togetherCurrentPhoto++;
    if (togetherCurrentPhoto >= state.photoCount) {
      if (togetherStream) togetherStream.getTracks().forEach(t => t.stop());
      openCustomizer();
      return;
    }
    updateTogetherProgress();
    $('together-preview-img').classList.add('hidden');
    $('together-video').classList.remove('hidden');
    $('together-review').classList.add('hidden');
    $('together-controls').classList.remove('hidden');
  });

  async function runCountdown(el) {
    for (let n = 3; n >= 1; n--) {
      el.textContent = n;
      el.classList.remove('hidden');
      el.classList.remove('flash-count');
      void el.offsetWidth;
      el.classList.add('flash-count');
      await sleep(600);
    }
    el.classList.add('hidden');
  }

  function flashScreen(el) {
    el.classList.remove('flash-white');
    void el.offsetWidth;
    el.classList.add('flash-white');
  }

  async function capturePhotoFromVideo(video, canvas, mirrorOutput) {
    const nativeW = video.videoWidth || 640;
    const nativeH = video.videoHeight || 480;
    // Phone cameras commonly report 1080p+ native resolution. Encoding a
    // photo at full resolution produces a multi-MB base64 JSON payload,
    // which is sent over the websocket and written straight into a Postgres
    // JSONB column. json.loads() on the server is pure CPU and cannot yield
    // to gevent, so a multi-MB parse (plus the DB write) blocks the whole
    // worker process for long enough to freeze *every other* connection
    // in the same room — which is what caused the "0/2 connected" /
    // WORKER TIMEOUT crashes. Capping the longest edge keeps payloads to a
    // few hundred KB, which is plenty for the photobooth output size.
    const MAX_EDGE = 1280;
    const scale = Math.min(1, MAX_EDGE / Math.max(nativeW, nativeH));
    const w = Math.round(nativeW * scale);
    const h = Math.round(nativeH * scale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // mirrorOutput is an explicit caller decision, NOT inferred from the
    // video element's own live-preview transform. Those are two different
    // questions: "does MY screen mirror MY own video so it feels like a
    // mirror" (always yes on front camera — see setMirrored) vs "should
    // the saved FILE be mirrored" (a real product tradeoff, not a
    // correctness question, whenever the file is shown to someone other
    // than the person who captured it).
    //
    // Long-distance mode: this exact photo is shown as-is to the *other*
    // person too (see entry.images.host/.partner, rendered identically on
    // both screens) — there's no single mirror state that's correct for
    // both viewers. The long-distance call site currently passes
    // mirrorOutput=true (an explicit, confirmed choice): the photo matches
    // what the person who took it was looking at on their own live
    // preview, at the cost of looking backwards (reversed text, wrong-side
    // hair parting, etc.) to their partner. Pass false instead for a true,
    // unmirrored recording that's correct for both viewers but won't match
    // either person's own mirrored self-preview.
    //
    // Together mode: mirrorOutput=true has no such tradeoff and is simply
    // correct — both people are in front of the same phone, the photo
    // never leaves this browser tab (no websocket send — see
    // state.finalPhotos), so "captured by" and "eventually viewed by" are
    // the same person on the same device.
    if (mirrorOutput) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    // Downsizing the resolution (above) keeps most photos well under the
    // server's 700,000-byte hard cap on an incoming websocket message (see
    // MAX_WS_MESSAGE_BYTES in app.py) — but JPEG size at a fixed quality
    // still varies a lot with image *content*, not just pixel count: a
    // background or subject with fine, busy detail (hair, patterned
    // wallpaper, foliage) encodes to noticeably more bytes than a plain
    // wall at the same resolution and quality. A capture that happened to
    // land over the server's cap was rejected outright with no retry path
    // — from the user's side that looked exactly like "it just stops
    // working partway through," and more so on busier/detailed shots.
    // Step quality down and re-encode (cheap — same already-drawn canvas,
    // no re-capture needed) until it's comfortably under that cap, so this
    // class of failure shouldn't happen rather than needing to be noticed
    // and recovered from afterward.
    const SAFE_BYTES = 650_000;
    let quality = 0.85;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > SAFE_BYTES && quality > 0.4) {
      quality -= 0.15;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    return dataUrl;
  }

  // ------------------------------------------------------------
  // LONG DISTANCE MODE
  // ------------------------------------------------------------
  async function startLongDistanceMode() {
    state.stripThumbs = {}; // fresh session — don't show a previous session's thumbnails
    showScreen('screen-ld');
    updateLDProgress();
    setupLDControlsVisibility();
    await initLocalCamera();
    await initPeerConnection();
    startPeerCountDebug();
  }

  // Shows how many WebSocket connections the server actually has registered
  // for this room, right on screen. If it's stuck at 1/2 while both people
  // are on this screen, the WebSocket signaling never linked the two
  // browsers together server-side — that's the real fault, separate from
  // (and upstream of) any WebRTC/TURN video issue, since chat/offer/answer
  // all ride on this same connection.
  //
  // Also shows each video element's actual live CSS transform (M = mirrored
  // via scaleX(-1), — = not). This is a temporary diagnostic for the "is my
  // video mirrored for my partner" question: mirroring genuinely only ever
  // touches the self element in this code (see setMirrored() call sites),
  // so if "rem" ever reads M here, that's real evidence of a bug to
  // investigate — versus mirrored-video-of-someone-else just reading as
  // subjectively "off" to the eye without actually being flipped, which is
  // otherwise very hard to tell apart from a glance.
  function startPeerCountDebug() {
    if (state.peerDebugTimer) clearInterval(state.peerDebugTimer);
    const check = async () => {
      try {
        const data = await api(`/api/rooms/${encodeURIComponent(state.room.room_code)}/debug`);
        const el = $('ld-debug-peers');
        const selfEl = $(state.role === 'host' ? 'ld-video-host' : 'ld-video-partner');
        const remoteEl = $(state.role === 'host' ? 'ld-video-partner' : 'ld-video-host');
        const mirrorFlag = (v) => (v && v.style.transform === 'scaleX(-1)') ? 'M' : '—';
        if (el) el.textContent = `${data.live_connections}/2 linked  self:${mirrorFlag(selfEl)} rem:${mirrorFlag(remoteEl)}`;
      } catch (e) { /* ignore */ }
    };
    check();
    state.peerDebugTimer = setInterval(check, 4000);
  }

  function updateLDProgress() {
    $('ld-progress').textContent = `PHOTO ${(state.room.current_photo || 0) + 1} / ${state.room.photo_count}`;
    renderProgressDots('ld-progress-dots', state.room.photo_count, state.room.current_photo || 0);
    renderLDPhotoStrip();
  }

  // Cache of thumbnails already composed, keyed by photo index, so a strip
  // re-render (e.g. on every progress update) never redoes the canvas work
  // for a slot whose photo hasn't changed. Cleared per-room in
  // resetRoomLocalState-adjacent spots below.
  state.stripThumbs = state.stripThumbs || {};

  // Renders the "your strip so far" row under the shutter on the
  // long-distance screen: one slot per photo the session will take, each
  // showing a small composed thumbnail once both sides are in, a dashed
  // placeholder if it hasn't been taken yet, and a blue outline on
  // whichever slot is currently up. Cheap to call often — it only redoes
  // the (async) composeSideBySide work for a slot when that slot's images
  // actually changed since the last render.
  async function renderLDPhotoStrip() {
    const el = $('ld-photo-strip');
    if (!el || !state.room) return;
    const count = state.room.photo_count || 0;
    const current = state.room.current_photo || 0;
    const photos = state.room.photos || [];

    // Build/update slots in place rather than wiping innerHTML every call,
    // so an in-flight thumbnail render for slot N doesn't get orphaned by a
    // later render clearing the DOM out from under it.
    while (el.children.length > count) el.removeChild(el.lastChild);
    for (let i = 0; i < count; i++) {
      let slot = el.children[i];
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'strip-slot empty';
        slot.innerHTML = `<span class="strip-num"></span>`;
        el.appendChild(slot);
      }
      slot.classList.toggle('current', i === current);

      const entry = photos[i];
      const imgs = entry && entry.images;
      const hasBoth = imgs && imgs.host && imgs.partner;
      const hasOne = imgs && (imgs.host || imgs.partner);
      const cacheKey = hasBoth
        ? imgs.host + '|' + imgs.partner + '|' + !!imgs.host_mirrored + '|' + !!imgs.partner_mirrored
        : (hasOne ? (imgs.host || imgs.partner) : null);

      if (!cacheKey) {
        slot.className = `strip-slot empty${i === current ? ' current' : ''}`;
        slot.innerHTML = `<span class="strip-num">${i + 1}</span>`;
        continue;
      }
      if (state.stripThumbs[i] && state.stripThumbs[i].key === cacheKey) continue; // already up to date

      let thumbSrc = imgs.host || imgs.partner;
      if (hasBoth) {
        // Only ever mirror the HOST's own slice, never the partner's. Both
        // this strip and the "Customize" export only ever get composed on
        // the HOST's device, and on that device the partner's tile is
        // NEVER shown with a self-mirror (that CSS mirror only applies to
        // whichever tile is "my own" on the viewing device — see
        // evaluateCaptureState). So the partner's raw/unmirrored frame is
        // exactly what the host has been looking at all session; flipping
        // it here (even though the partner's OWN device did mirror it for
        // them) would make it stop matching what the host just watched.
        try { thumbSrc = await composeSideBySide(imgs.host, imgs.partner, !!imgs.host_mirrored, false); }
        catch (e) { /* fall back to single-side thumb below */ }
      }
      state.stripThumbs[i] = { key: cacheKey, src: thumbSrc };

      // Re-select in case the DOM shifted while composeSideBySide awaited.
      slot = el.children[i];
      if (!slot) continue;
      slot.className = `strip-slot done pop${i === current ? ' current' : ''}`;
      slot.innerHTML = `<img src="${thumbSrc}" alt="Photo ${i + 1}"/><span class="strip-num">${i + 1}</span>`;
    }
  }

  function setupLDControlsVisibility() {
    const isHost = state.role === 'host';
    // Always show "myself" on the left, "my partner" on the right —
    // regardless of which role (host/partner) that happens to be. The
    // underlying host/partner tiles never move in the DOM (so all the
    // id-based lookups elsewhere stay correct); this just flips their
    // visual left/right order for whoever is currently looking at the
    // screen. Same tiles are reused for the post-capture frozen preview,
    // so this keeps that in sync too.
    $('cam-pair').classList.toggle('self-partner', !isHost);
    $('ld-host-controls').classList.toggle('hidden', !isHost);
    $('ld-host-controls').classList.toggle('flex', isHost);
    $('ld-partner-wait-msg').classList.toggle('hidden', isHost);
    // Reflects actual state.micOn (starts false / muted) rather than always
    // painting the "on" icon — this ran unconditionally before, so the
    // button looked live from the first frame even though the track itself
    // was muted, which is the "mic function is not working" look-broken
    // report.
    $('ld-mic-btn').innerHTML = state.micOn ? ICONS.micOn : ICONS.micOff;
    updateCamDots();
  }

  // Small per-tile live/connecting indicator, separate from the overall
  // WebSocket connection dot — this one reflects whether each participant's
  // actual video feed is attached.
  function updateCamDots() {
    const hostDot = $('ld-dot-host');
    const partnerDot = $('ld-dot-partner');
    if (hostDot) {
      const hostLive = !!(state.role === 'host' ? state.localStream : $('ld-video-host').srcObject);
      hostDot.classList.toggle('live', hostLive);
      hostDot.classList.toggle('pulse', !hostLive);
    }
    if (partnerDot) {
      const partnerLive = !!(state.role === 'partner' ? state.localStream : $('ld-video-partner').srcObject);
      partnerDot.classList.toggle('live', partnerLive);
      partnerDot.classList.toggle('pulse', !partnerLive);
    }
  }

  async function initLocalCamera() {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        // Lower than before (480x640 vs 960x1280) — this only affects the
        // live video feed sent to your partner over the network, not photo
        // quality. Photos are captured from this same local stream directly
        // on-device, so they stay full resolution regardless of what's
        // actually transmitted for the live preview. A smaller feed means
        // far less bandwidth needed to keep the call alive on a weak
        // connection.
        video: { facingMode: state.facingMode, width: { ideal: 640 }, height: { ideal: 854 } },
        audio: true,
      });
      // getUserMedia() always hands back an enabled (live) audio track
      // regardless of state.micOn — enabling it here is what actually
      // makes "mic off by default" true, not just the flag's initial
      // value. Every later toggle (ld-mic-btn click) also writes through
      // to this same track via getAudioTracks().forEach(...).enabled.
      state.localStream.getAudioTracks().forEach(t => { t.enabled = state.micOn; });
      const selfEl = $(state.role === 'host' ? 'ld-video-host' : 'ld-video-partner');
      selfEl.srcObject = state.localStream;
      selfEl.muted = true;
      setMirrored(selfEl);
      updateCamDots();
    } catch (e) {
      toast('Camera/mic permission needed for long-distance mode.');
    }
  }

  $('ld-flip-btn').addEventListener('click', async () => {
    $('ld-flip-btn').classList.remove('toggle-pop'); void $('ld-flip-btn').offsetWidth; $('ld-flip-btn').classList.add('toggle-pop');
    const previousFacingMode = state.facingMode;
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
    try {
      // Video-only request — the existing audio track (and its mic on/off
      // state, and its RTCRtpSender in the peer connection) is left
      // completely alone. This used to ask for a brand new audio+video
      // stream while the ORIGINAL audio track from initLocalCamera was
      // still open and in use — most phones (Android Chrome especially)
      // refuse a second getUserMedia audio request while the page already
      // holds the mic, so this failed with "Could not switch camera" on
      // basically every attempt, not intermittently. On top of that, even
      // on a browser that did allow it, that new stream's audio track was
      // never wired into the peer connection (only the video track got
      // replaceTrack'd below) — so state.localStream ended up pointing at
      // an audio track nobody was actually sending, silently breaking the
      // mic toggle for the rest of the call after the first flip.
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facingMode },
        audio: false,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (state.pc) {
        const sender = state.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
          applyVideoBitrateCap(state.pc);
        }
      }
      const oldAudioTrack = state.localStream ? state.localStream.getAudioTracks()[0] : null;
      if (state.localStream) state.localStream.getVideoTracks().forEach(t => t.stop());
      // Rebuild localStream as the new video track plus the SAME,
      // untouched, still-live audio track — so getAudioTracks() (used by
      // the mic toggle, and by initLocalCamera's initial mute-on-join)
      // keeps referring to the exact track actually wired into the peer
      // connection, both before and after any number of camera flips.
      state.localStream = oldAudioTrack ? new MediaStream([newVideoTrack, oldAudioTrack]) : newStream;
      const selfEl = $(state.role === 'host' ? 'ld-video-host' : 'ld-video-partner');
      selfEl.srcObject = state.localStream;
      setMirrored(selfEl);
    } catch (e) {
      // Revert — a failed switch previously left facingMode flipped even
      // though the camera never actually changed, so the NEXT tap would
      // try to go the wrong direction (e.g. user -> environment failed,
      // but the next tap would then attempt environment -> user, when the
      // camera was still genuinely on 'user' the whole time).
      state.facingMode = previousFacingMode;
      toast('Could not switch camera');
    }
  });

  $('ld-mic-btn').addEventListener('click', () => {
    state.micOn = !state.micOn;
    if (state.localStream) state.localStream.getAudioTracks().forEach(t => t.enabled = state.micOn);
    $('ld-mic-btn').innerHTML = state.micOn ? ICONS.micOn : ICONS.micOff;
    $('ld-mic-btn').classList.remove('toggle-pop'); void $('ld-mic-btn').offsetWidth; $('ld-mic-btn').classList.add('toggle-pop');
    wsSend('mic_state', { on: state.micOn });
    // Only ever touches YOUR OWN outgoing track (above) — no longer also
    // unmutes the remote element here. That unmuting is now handled
    // separately by the page-wide first-gesture listener near the top of
    // the file (a click on this exact button also satisfies that, so
    // remote audio still reliably starts playing the first time anyone
    // taps anything on this screen, mic button included) — see the
    // ontrack comment for why coupling it specifically to this button was
    // the actual bug: it made hearing your partner depend on your OWN mic
    // state instead of on autoplay policy, which is what it's actually for.
  });

  // Quick reactions (see the "Send a reaction" bar under the strip). Tap
  // -> send to the other person -> ALSO spawn locally right away, since
  // the WS relay excludes the sender (see broadcast_to_room/exclude_ws
  // server-side), so without this the tapper would never see their own
  // emoji float.
  $('ld-reaction-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.reaction-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    wsSend('reaction', { emoji });
    spawnFloatingReaction(emoji, state.role);
  });

  // Maps each reaction emoji to its Apple/iOS-style image on the
  // emoji-datasource-apple CDN, so a reaction looks the same (the actual
  // iOS glyph) on every device instead of falling back to whatever emoji
  // font each phone's OS happens to ship — Android's system emoji look
  // noticeably different from iOS for the same character otherwise.
  const REACTION_IMAGES = {
    '❤️': '2764-fe0f',
    '😂': '1f602',
    '😍': '1f60d',
    '🔥': '1f525',
    '👏': '1f44f',
    '😮': '1f62e',
  };
  const APPLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/';

  function spawnFloatingReaction(emoji, who) {
    const layer = $('cam-pair');
    if (!layer) return;
    const el = document.createElement('span');
    el.className = 'floating-reaction';
    const file = REACTION_IMAGES[emoji];
    if (file) {
      const img = document.createElement('img');
      img.src = APPLE_EMOJI_CDN + file + '.png';
      img.alt = emoji;
      img.onerror = () => { el.textContent = emoji; }; // offline/CDN-down fallback
      el.appendChild(img);
    } else {
      el.textContent = emoji; // unknown emoji somehow got through — still show something
    }
    // Rises up from whichever half of the video pair VISUALLY belongs to
    // the person who sent it. This is NOT simply "host = left" — #cam-pair
    // swaps which tile renders on which side depending on whose device is
    // looking at it (see the .self-partner rule: each person's own tile is
    // always shown on their own left). So "left half" only means "host's
    // tile" when this device is NOT viewing itself as partner.
    const isSelfPartnerView = layer.classList.contains('self-partner');
    const onRight = isSelfPartnerView ? (who === 'host') : (who === 'partner');
    const halfWidth = layer.clientWidth / 2;
    const base = onRight ? halfWidth : 0;
    const jitter = Math.random() * (halfWidth - 40) + 10;
    el.style.left = `${base + jitter}px`;
    layer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    // Fallback removal in case animationend doesn't fire for any reason
    // (e.g. the screen is switched away from mid-flight) — an orphaned
    // absolutely-positioned span left behind would otherwise sit invisible
    // in the DOM forever, harmless but sloppy.
    setTimeout(() => el.remove(), 2600);
  }

  // Limits the outgoing video track to a modest bitrate (~250kbps) so the
  // call stays connectable and audio stays smooth even on a weak/limited
  // network, instead of WebRTC trying to push as much video data as the
  // camera/encoder can produce. 250kbps is plenty for a small preview-sized
  // face-to-face video feed; it's not used for the actual printed photos.
  async function applyVideoBitrateCap(pc) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 250_000; // ~250kbps
      await sender.setParameters(params);
    } catch (e) { /* not fatal if unsupported on this browser */ }
  }

  // --- WebRTC signaling via our WebSocket (host = offerer) ---
  //
  // "Perfect negotiation" glare handling: on flaky/high-latency links (real
  // cross-network conditions — mobile data, different ISPs) it's common for
  // both sides to end up mid-negotiation at once, e.g. the host's automatic
  // ICE-restart offer crossing with a message still in flight from the
  // partner. Without a deterministic tie-breaker, whichever side calls
  // setRemoteDescription(offer) while its own signalingState is
  // "have-local-offer" (not "stable") throws, and since the old code never
  // caught that, the connection just silently wedged for the rest of the
  // session. That's a timing race, not a TURN/credentials problem — which is
  // why it looked random and "usually works" on fast/same-network links but
  // failed unpredictably across real separate networks.
  //
  // Fix: give each side a fixed, stable role - host is "impolite" (its
  // offer always wins a collision), partner is "polite" (it detects the
  // collision, rolls back its own in-flight offer, and accepts the host's
  // instead). This is the standard pattern from the WebRTC spec's
  // perfect-negotiation example, adapted to reuse the host/partner role this
  // app already assigns instead of introducing a separate polite/impolite
  // flag.
  state.makingOffer = false;
  state.ignoreOffer = false;

  async function initPeerConnection() {
    state.pc = new RTCPeerConnection(RTC_CONFIG);
    // Derived here (rather than alongside the 3 separate spots that set
    // state.role) so it's always in sync with whatever role is current the
    // moment negotiation actually starts.
    state.polite = state.role === 'partner';

    if (state.localStream) {
      state.localStream.getTracks().forEach(track => state.pc.addTrack(track, state.localStream));
    }

    // Cap outgoing video bitrate so a weak/limited connection (common on
    // mobile data or a busy network) doesn't get overwhelmed trying to push
    // full-rate video — that's what tends to cause stalled/frozen frames or
    // ICE dropping out entirely on poor networks. Audio isn't capped here:
    // it's a tiny fraction of the bandwidth video uses, and losing audio
    // quality would hurt the "actually talk to each other" experience far
    // more than a lower-bitrate video preview would.
    applyVideoBitrateCap(state.pc);

    state.pc.ontrack = (ev) => {
      const remoteEl = $(state.role === 'host' ? 'ld-video-partner' : 'ld-video-host');
      if (remoteEl.srcObject !== ev.streams[0]) {
        remoteEl.srcObject = ev.streams[0];
        $('ld-partner-placeholder').classList.add('hidden');
        updateCamDots();
        // Browsers block autoplay of any <video> that has audio and isn't
        // muted, unless playback started from a user gesture — and attaching
        // a WebRTC track never counts as one. Without this, the remote video
        // silently never plays (looks like "never connects") on a page that
        // hasn't seen any gesture yet.
        //
        // Previously this checked state.micOn instead of a dedicated
        // gesture flag — which meant hearing your partner was tied to
        // whether *you'd* turned your own mic on, not whether it was safe
        // to autoplay. Two people could both have working mics and audio
        // correctly flowing over WebRTC in both directions, and each would
        // still hear silence until they personally tapped their own mic
        // button — indistinguishable from "the mic doesn't work", and from
        // either side's perspective it looked like it was waiting on the
        // *other* person. state.hasUserGesture (set by the page-wide
        // listener above, near the top of the file) is about whether THIS
        // page has seen any real tap at all — normally already true by the
        // time anyone reaches this screen — which is what autoplay policy
        // actually cares about, not the mic toggle.
        //
        // Still guarded (not an unconditional `= true`) because ontrack can
        // fire again later on the same element — a mid-call ICE restart or
        // reconnect re-negotiates and re-fires ontrack with a new
        // MediaStream even though it's the same person's audio. Re-muting
        // an element that's already playing fine would silently cut audio
        // mid-call for no reason visible in the UI.
        if (!state.hasUserGesture) remoteEl.muted = true;
        remoteEl.play().catch(() => {
          // Autoplay was blocked despite the above (e.g. a browser with a
          // stricter policy than "any gesture on the page"). Not fatal —
          // fall back to muted so playback at least starts, and the
          // tap-to-unmute handler below still offers a manual recovery.
          remoteEl.muted = true;
          remoteEl.play().catch(() => {});
        });
        if (!remoteEl.dataset.tapToUnmuteBound) {
          remoteEl.dataset.tapToUnmuteBound = '1';
          remoteEl.addEventListener('click', () => {
            remoteEl.muted = !remoteEl.muted;
          });
        }
      }
    };

    state.pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend('webrtc_ice', { data: ev.candidate });
    };

    // Surfaces real connection status instead of leaving people staring at
    // "Connecting…" forever with zero information. Also attempts one
    // automatic ICE restart on failure (common on flaky mobile networks),
    // and tells the person plainly if that doesn't work either.
    state.pc.oniceconnectionstatechange = () => {
      const st = state.pc.iceConnectionState;
      // Its own element, separate from ld-status-msg (photo-capture
      // progress) -- see the HTML comment next to ld-rtc-status-msg for
      // why these can no longer share one element.
      const statusEl = $('ld-rtc-status-msg');
      if (st === 'checking') {
        statusEl.textContent = 'Connecting to your partner…';
        statusEl.classList.remove('hidden');
      } else if (st === 'connected' || st === 'completed') {
        statusEl.classList.add('hidden');
        updateConnectionDot(true);
        // Log which candidate pair actually won, so the console shows
        // whether the connection went direct (host/srflx — same network
        // or open NAT) or through TURN (relay — required across most
        // real-world separate networks/carriers). Fastest way to confirm
        // whether a cross-network failure is the carrier blocking the
        // TURN relay itself vs. something else.
        state.pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              const local = stats.get(report.localCandidateId);
              const remote = stats.get(report.remoteCandidateId);
              console.log('[webrtc] connected via', {
                localType: local && local.candidateType,
                remoteType: remote && remote.candidateType,
                protocol: local && local.protocol,
              });
            }
          });
        }).catch(() => {});
      } else if (st === 'disconnected') {
        statusEl.textContent = 'Connection unstable — trying to recover…';
        statusEl.classList.remove('hidden');
        updateConnectionDot(false);
      } else if (st === 'failed') {
        updateConnectionDot(false);
        if (state.role === 'host' && !state.pc._iceRestarted) {
          // One automatic retry via ICE restart before giving up.
          state.pc._iceRestarted = true;
          statusEl.textContent = 'Connection failed — retrying…';
          statusEl.classList.remove('hidden');
          makeOffer(true);
        } else {
          statusEl.textContent = 'Could not connect to your partner. This usually means your networks need a TURN relay server to talk to each other — try switching either phone off WiFi onto mobile data (or vice versa), disable any VPN, then leave and rejoin the room.';
          statusEl.classList.remove('hidden');
        }
      }
    };

    state.pc.onicecandidateerror = (ev) => {
      // Surfaces TURN auth/reachability failures (e.g. bad credentials,
      // expired free-tier quota) in the console instead of failing silently.
      console.warn('ICE candidate error', ev.errorCode, ev.errorText, ev.url);
    };

    state.pc.onconnectionstatechange = () => {
      if (state.pc.connectionState === 'connected') updateConnectionDot(true);
    };

    // Handle any offer/ICE that arrived on the WS before this peer connection
    // existed, before doing anything else with it.
    await flushPendingSignaling();

    if (state.role === 'host' && state.room.has_partner) {
      await makeOffer();
    }
    // if partner joins later, 'partner_joined' event triggers offer from host
  }

  async function makeOffer(iceRestart) {
    if (!state.pc) return;
    try {
      state.makingOffer = true;
      // setLocalDescription() with no args (implicit createOffer) would be
      // the textbook perfect-negotiation call, but this codebase already
      // builds the offer explicitly to pass iceRestart, so keep that and
      // just track the in-flight window around it instead.
      const offer = await state.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await state.pc.setLocalDescription(offer);
      wsSend('webrtc_offer', { data: offer });
    } finally {
      state.makingOffer = false;
    }
  }

  // Offers/answers/ICE candidates can arrive over the WebSocket before this
  // side has finished creating its own RTCPeerConnection (e.g. the host
  // fires its offer the instant it sees has_partner, which can easily beat
  // the partner's own initPeerConnection() call). Previously these handlers
  // just did `if (!state.pc) return;` and silently dropped the message —
  // no error, no retry — which is exactly what caused "local camera shows,
  // remote video never arrives" with no visible failure anywhere. Buffer
  // anything that arrives early and flush it once initPeerConnection() runs.
  state.pendingOffer = null;
  state.pendingIce = [];

  async function handleRemoteOffer(offer) {
    if (!state.pc) { state.pendingOffer = offer; return; }

    // Collision: we're either mid-way through sending our own offer, or we
    // already have one outstanding (signalingState "have-local-offer") when
    // the other side's offer arrives. Previously this was never checked, so
    // setRemoteDescription() below would throw on whichever side happened to
    // lose the race - intermittently, since it depends on both sides'
    // message timing lining up. host = impolite (ignore their offer, ours
    // wins), partner = polite (drop ours, roll back, take theirs).
    const offerCollision =
      state.makingOffer || state.pc.signalingState !== 'stable';

    state.ignoreOffer = !state.polite && offerCollision;
    if (state.ignoreOffer) return;

    if (offerCollision) {
      // Only the polite side reaches here. Roll back our own in-flight
      // local offer before accepting theirs, so setRemoteDescription below
      // lands on a clean "stable" state instead of throwing.
      await Promise.all([
        state.pc.setLocalDescription({ type: 'rollback' }),
        state.pc.setRemoteDescription(new RTCSessionDescription(offer)),
      ]);
    } else {
      await state.pc.setRemoteDescription(new RTCSessionDescription(offer));
    }

    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    wsSend('webrtc_answer', { data: answer });
  }

  async function handleRemoteAnswer(answer) {
    if (!state.pc) return;
    // Only valid when we're the one who sent the outstanding offer this
    // answers. Checking specifically for "have-local-offer" (rather than
    // the old "!== 'stable'") avoids calling setRemoteDescription() from
    // some other in-between state, which is the other spot this could throw
    // uncaught on a badly-timed message.
    if (state.pc.signalingState === 'have-local-offer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async function handleRemoteIce(candidate) {
    if (!state.pc) { state.pendingIce.push(candidate); return; }
    try { await state.pc.addIceCandidate(candidate); } catch (e) { /* ignore */ }
  }

  async function flushPendingSignaling() {
    if (state.pendingOffer) {
      const offer = state.pendingOffer;
      state.pendingOffer = null;
      await handleRemoteOffer(offer);
    }
    if (state.pendingIce.length) {
      const queued = state.pendingIce.splice(0);
      for (const c of queued) await handleRemoteIce(c);
    }
  }

  // --- Host shutter flow ---
  $('ld-shutter').addEventListener('click', () => {
    // Belt: ignore a rapid double-tap before the first 'start_countdown'
    // has even gotten a 'countdown_start' broadcast back yet, so it can
    // never queue up a second wsSend for the same photo. Disabled state is
    // cleared in ldResetPhotoUI() (see there) once it's genuinely safe to
    // shoot the NEXT photo. The button is also already hidden for the rest
    // of the countdown by runCountdownLD() below (ld-host-controls) — this
    // covers only the narrow gap before that broadcast round-trip returns.
    if ($('ld-shutter').disabled) return;
    $('ld-shutter').disabled = true;
    wsSend('start_countdown');
  });

  async function runCountdownLD() {
    // Suspenders: even if two 'countdown_start' broadcasts do arrive (e.g.
    // a duplicate delivery after a reconnect replays a message the server
    // already sent once — see the server-side start_countdown guard in
    // apply_room_action for the matching fix there), never let a second
    // countdown loop run concurrently with one already in progress on this
    // device. Without this, both loops independently reach their own
    // capturePhotoFromVideo()+wsSend('capture', ...) a beat apart, and the
    // second one can land after 'next_photo' already advanced
    // current_photo — writing a capture into the wrong photo's slot. That
    // was the intermittent, no-visible-error "breaks on photo 3 or 4"
    // report (later photos = faster taps = more likely to double-fire).
    if (state.ldCountdownInFlight) return;
    state.ldCountdownInFlight = true;
    try {
      $('ld-host-controls').classList.add('hidden');
      for (let n = 3; n >= 1; n--) {
        $('ld-count').textContent = n;
        $('ld-count').classList.remove('hidden');
        $('ld-count').classList.remove('flash-count');
        void $('ld-count').offsetWidth;
        $('ld-count').classList.add('flash-count');
        await sleep(600);
      }
      $('ld-count').classList.add('hidden');
      flashScreen($('ld-flash'));

      // Each client captures its own local video and sends to server.
      // mirrorOutput=false — this is a genuine change from the prior
      // behavior (mirrorOutput=true), made after confirming the actual
      // failure mode: the FILE was being flipped to match the capturing
      // person's own mirrored self-preview, but their PARTNER never had a
      // mirrored view of them to begin with (setMirrored() is only ever
      // called on each person's own selfEl — see initLocalCamera/
      // ld-flip-btn — never on the remote element). So the file was
      // correct for exactly one specific viewer (the person who took it,
      // looking at their own past self-preview) and backwards for
      // literally everyone else looking at that same file: their partner
      // live, their partner's frozen thumbnail, and the final exported
      // strip. A static, unmoving subject (e.g. a ceiling fan) makes this
      // unmistakable — no motion to blur the comparison, just a flipped
      // blade layout every time.
      //
      // The fix: capture the TRUE, unmirrored camera frame (what
      // everyone's un-transformed view of this person already correctly
      // shows) and apply the "look like a mirror to yourself" effect
      // ONLY as a display-side CSS transform on each person's own frozen
      // thumbnail after the fact — see the freezeEl mirroring right below.
      // That gets both things right at once: the underlying file (and
      // everyone else's view of it) is never touched, while the person who
      // took the photo still sees a mirrored version of themselves,
      // exactly matching what their live self-preview looked like a
      // moment earlier.
      const selfVideo = $(state.role === 'host' ? 'ld-video-host' : 'ld-video-partner');
      const tmpCanvas = document.createElement('canvas');
      const dataUrl = await capturePhotoFromVideo(selfVideo, tmpCanvas, false);
      const freezeEl = $(state.role === 'host' ? 'ld-frozen-host' : 'ld-frozen-partner');
      freezeEl.src = dataUrl;
      freezeEl.classList.remove('hidden');
      // Mirrors ONLY this device's own frozen thumbnail of ITSELF, purely
      // for display — never the data that gets sent. Matches setMirrored()'s
      // own front-camera-only condition so it's consistent with the live
      // preview the person was just looking at seconds earlier.
      freezeEl.style.transform = state.facingMode === 'user' ? 'scaleX(-1)' : 'none';

      wsSend('capture', {
        photo: dataUrl,
        // Lets the server-side entry (and therefore the final compose and
        // the strip thumbnails) know this specific shot was taken on THIS
        // person's front camera, so their own slice can be flipped back to
        // match what they saw in their mirrored preview/frozen frame —
        // without guessing "front camera" for everyone, or baking a mirror
        // into the file itself (see mirrorOutput=false above for why that
        // broke the partner's/export's view previously).
        mirrored: state.facingMode === 'user',
      }); // 'who' is derived server-side from the authenticated sender
    } finally {
      // Always releases, even if a step above throws (e.g. capture failing
      // on a dropped camera permission mid-session) — a stuck `true` here
      // would silently disable the shutter for every remaining photo with
      // no visible error, which is its own bad failure mode.
      state.ldCountdownInFlight = false;
    }
  }

  function onPhotoCapturedRemote(msg) {
    // The server now sends just the single changed entry as msg.photo
    // (not the whole photos history — see app.py) to keep broadcasts small
    // and reliable at any point in the session. Merge it into our own
    // running local cache so composeSideBySide() still has every photo by
    // the time the session finishes.
    const idx = msg.index;
    const entry = msg.photo || (state.room.photos || [])[idx];
    if (!entry) return;
    state.room.photos = state.room.photos || [];
    state.room.photos[idx] = entry;
    evaluateCaptureState(idx);
  }

  // Applies whatever we currently know about photo `idx` to the UI: shows
  // each side's frozen frame as it comes in, and — once both are present —
  // reveals the host's Retake/Next controls.
  //
  // Both roles submit a capture independently (see the "capture" comment in
  // app.py — it's intentionally not host-only), and each one's own
  // "photo_captured" broadcast can independently get dropped or delayed on
  // a weak connection. Previously ONLY the host had a resync safety net
  // here — if it was actually the PARTNER's incoming broadcast (of the
  // host's own photo) that stalled, nothing was scheduled to ever recheck,
  // and the partner side would sit frozen with no way to recover short of
  // a manual retake/refresh. This is what produced the "stuck forever on a
  // random photo, even with a fine connection" report: it was never about
  // connection quality, it was that one specific role had zero retry path.
  function evaluateCaptureState(idx) {
    const entry = (state.room.photos || [])[idx];
    if (!entry) return;
    // entry.images.host/.partner are now always the TRUE, unmirrored camera
    // frame (see mirrorOutput=false in runCountdownLD above) — correct
    // as-is for whichever tile shows the OTHER person. Only the tile
    // showing YOUR OWN captured self gets a display-only mirror here, to
    // match the live self-preview you were just looking at. Applied on
    // every call (not just your own local capture in runCountdownLD)
    // because this same function also runs when the OTHER person's
    // broadcast is what delivers your own photo back to you, and — via
    // resyncCurrentPhoto — on a plain HTTP re-fetch after a dropped
    // message, neither of which should skip the mirror your own tile needs.
    const ownFrozenId = state.role === 'host' ? 'ld-frozen-host' : 'ld-frozen-partner';
    if (entry.images.host) {
      $('ld-frozen-host').src = entry.images.host;
      $('ld-frozen-host').classList.remove('hidden');
      $('ld-frozen-host').style.transform =
        ('ld-frozen-host' === ownFrozenId && state.facingMode === 'user') ? 'scaleX(-1)' : 'none';
    }
    if (entry.images.partner) {
      $('ld-frozen-partner').src = entry.images.partner;
      $('ld-frozen-partner').classList.remove('hidden');
      $('ld-frozen-partner').style.transform =
        ('ld-frozen-partner' === ownFrozenId && state.facingMode === 'user') ? 'scaleX(-1)' : 'none';
    }
    renderLDPhotoStrip();
    const bothIn = !!(entry.images.host && entry.images.partner);
    if (bothIn) {
      clearInterval(state.ldWaitResyncTimer);
      clearTimeout(state.ldStuckRetryTimer);
      $('ld-stuck-retry').classList.add('hidden');
      if (state.role === 'host') {
        $('ld-status-msg').classList.add('hidden');
        $('ld-host-review').classList.remove('hidden');
        $('ld-host-review').classList.add('flex');
        toast('Both ready — take a look!');
      } else {
        toast('Both ready — waiting for host to review');
      }
    } else {
      if (state.role === 'host') {
        $('ld-status-msg').textContent = "Both ready? Waiting for partner's photo…";
        $('ld-status-msg').classList.remove('hidden');
      } else {
        toast('Photo captured');
      }
      // Safety net, now for BOTH roles: if the other side's own
      // "photo_captured" broadcast never arrives (a dropped/slow WebSocket
      // message), don't leave either person stuck on this screen forever
      // with no way to proceed. Re-fetch the room over plain HTTP a few
      // seconds later and pick up from whatever actually landed
      // server-side. Also now RETRIES on a fixed interval instead of firing
      // once — a single attempt landing on a still-slow connection (or a
      // save that completes a beat after this particular check runs) used
      // to mean no further checks would ever happen for this photo, so a
      // one-off miss looked identical to "stuck forever" from the screen.
      clearInterval(state.ldWaitResyncTimer);
      state.ldWaitResyncTimer = setInterval(() => resyncCurrentPhoto(idx), 4000);
      // Belt-and-suspenders on top of the resync poll above: if this is
      // still unresolved after a stretch (the other side's capture was
      // rejected outright rather than merely delayed — e.g. too large, or
      // they lost their connection entirely — so no amount of polling the
      // current state will ever find it), the host previously had no way
      // to escape short of leaving the room. Surface a manual retry.
      // Host-only: the partner has no controls on this screen to retry
      // with (see setupLDControlsVisibility), so there's nothing useful to
      // show them here beyond the "Photo captured" toast above.
      if (state.role === 'host') {
        clearTimeout(state.ldStuckRetryTimer);
        state.ldStuckRetryTimer = setTimeout(() => {
          $('ld-stuck-retry').classList.remove('hidden');
        }, 8000);
      }
    }
  }

  async function resyncCurrentPhoto(idx) {
    if (!state.room || !state.room.room_code) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(state.room.room_code)}`);
      if (data.room) {
        state.room.photos = data.room.photos || state.room.photos;
        state.room.current_photo = data.room.current_photo;
        state.room.state = data.room.state;
      }
      // Only act on it if we're still waiting on this same photo — the
      // session may have already moved on (retake/next_photo/finish) by
      // the time this resolves, for either role.
      if (state.room.current_photo === idx) evaluateCaptureState(idx);
    } catch (e) { /* best-effort; interval keeps retrying, and a manual retake/shutter tap still works */ }
  }

  function ldResetPhotoUI() {
    clearInterval(state.ldWaitResyncTimer);
    clearTimeout(state.ldStuckRetryTimer);
    $('ld-stuck-retry').classList.add('hidden');
    $('ld-frozen-host').classList.add('hidden');
    $('ld-frozen-partner').classList.add('hidden');
    // Cleared alongside hiding, not just left stale — evaluateCaptureState()
    // always recomputes this explicitly before either element is shown
    // again, so this isn't load-bearing, but it keeps a hidden element from
    // sitting there with a leftover inline transform from a previous photo.
    $('ld-frozen-host').style.transform = 'none';
    $('ld-frozen-partner').style.transform = 'none';
    $('ld-host-review').classList.add('hidden');
    $('ld-host-review').classList.remove('flex');
    $('ld-host-controls').classList.remove('hidden');
    $('ld-host-controls').classList.add('flex');
    // Re-arms the shutter for the next photo — this fires on both 'retake'
    // and 'next_photo', both of which mean it's genuinely safe to shoot
    // again. Pairs with the disable in the ld-shutter click handler above.
    $('ld-shutter').disabled = false;
    // On a retake this also runs for the CURRENT (not yet advanced) index —
    // drop its local cache so the strip doesn't keep showing the
    // about-to-be-replaced thumbnail as "done" while the retake is in
    // flight; it'll pop back in fresh once the new capture broadcasts.
    const idx = state.room && (state.room.current_photo || 0);
    if (state.room && state.room.photos) state.room.photos[idx] = null;
    if (state.stripThumbs) delete state.stripThumbs[idx];
    renderLDPhotoStrip();
  }

  $('ld-retake').addEventListener('click', () => wsSend('retake'));
  $('ld-next').addEventListener('click', () => wsSend('next_photo'));
  // Manual escape hatch for a stalled capture round trip — see where this
  // button is revealed in evaluateCaptureState(). Sends the same 'retake'
  // action the Retake button does: server-authoritative, clears this
  // photo's slot back to empty and re-arms the shutter on broadcast (see
  // the 'retake' case in handleWSMessage). Deliberately not a purely local
  // UI reset — the server's copy of this photo may genuinely have only one
  // side filled in, and leaving it that way would just make the *next*
  // capture attempt land on top of stale state instead of a clean slate.
  $('ld-stuck-retry').addEventListener('click', () => {
    $('ld-stuck-retry').classList.add('hidden');
    toast('Retrying this photo…');
    wsSend('retake');
  });

  function onNextPhotoLD() {
    ldResetPhotoUI();
    updateLDProgress();
  }

  // Does state.room.photos actually have both sides for every photo the
  // session was supposed to take? The 'session_complete' broadcast no
  // longer carries the photos array (see app.py) — only the host's own
  // running cache from each 'photo_captured' broadcast during the session
  // — so this is what tells us whether that cache is trustworthy or
  // whether we need to go pull the authoritative copy instead.
  function ldPhotosComplete(photos) {
    const count = state.room.photo_count || 0;
    if (!Array.isArray(photos) || photos.length < count) return false;
    for (let i = 0; i < count; i++) {
      const imgs = photos[i] && photos[i].images;
      if (!imgs || !imgs.host || !imgs.partner) return false;
    }
    return true;
  }

  async function onSessionCompleteLD() {
    // Only the host actually uses the composed photos (customizer +
    // export below) — the partner just waits for the host's finished
    // image later, over in onHostFinishedLD(). So the partner's screen
    // transition never needs to touch state.room.photos at all, and can
    // never get stuck here regardless of what did or didn't arrive over
    // WebSocket during the session.
    if (state.role !== 'host') {
      // This is the "Thanks for using Photobooth!" landing screen — from
      // here the partner is just waiting on the host's final image, with
      // nothing left for THEM to do in this room. Treat it the same as
      // done: a reload/reopen from here should offer a fresh session, not
      // silently reattach to this one.
      markSessionEnded();
      showScreen('screen-partner-wait');
      return;
    }

    // Best case: the host's own local cache (built up as each photo was
    // taken) already has both sides of every photo, and no extra round
    // trip is needed. If a 'photo_captured' broadcast got dropped at some
    // point on a shaky connection, fall back to a plain HTTP GET of this
    // same room — small, ordinary, and retryable, unlike a single giant
    // WebSocket frame — with a couple of retries since this is the last
    // chance to get it right before the host would otherwise be stuck.
    if (!ldPhotosComplete(state.room.photos)) {
      for (let attempt = 0; attempt < 3 && !ldPhotosComplete(state.room.photos); attempt++) {
        try {
          const data = await api(`/api/rooms/${encodeURIComponent(state.room.room_code)}`);
          if (data.room && data.room.photos) state.room.photos = data.room.photos;
        } catch (e) { /* try again below, or fall through best-effort */ }
        if (!ldPhotosComplete(state.room.photos)) await sleep(800);
      }
    }

    // Compose all photo pairs into final images. Best-effort per entry —
    // one bad/missing image should never throw and strand the whole
    // session on this screen; skip just that entry and keep going so the
    // host always reaches the editor.
    //
    // Only the HOST's own slice ever gets mirrored back to match their
    // self-preview — the partner's slice is composed exactly as the host
    // has been watching it live all session (never mirrored on the host's
    // screen, see the matching note in renderLDPhotoStrip above). Flipping
    // partner's slice too was tried and reverted: it made the export match
    // the PARTNER's own memory of themselves, but no longer match what the
    // HOST (the only person who ever sees this comparison, since only the
    // host has this review screen) actually watched during the session.
    const composed = [];
    for (const entry of (state.room.photos || [])) {
      const imgs = entry && entry.images || {};
      try {
        if (imgs.host && imgs.partner) {
          composed.push(await composeSideBySide(imgs.host, imgs.partner, !!imgs.host_mirrored, false));
        } else if (imgs.host || imgs.partner) {
          const only = imgs.host || imgs.partner;
          composed.push(await maybeMirrorImage(only, imgs.host ? !!imgs.host_mirrored : false));
        }
      } catch (e) {
        console.error('[ld] failed to compose photo', entry && entry.index, e);
      }
    }
    state.finalPhotos = composed;
    openCustomizer();
  }

  function onHostFinishedLD() {
    if (state.role === 'partner') {
      clearSession(); // this session is over — nothing left to resume into
      const finalImg = state.room.customization && state.room.customization.final_image;
      if (finalImg) {
        $('partner-final-img').src = finalImg;
        $('partner-final-wrap').classList.remove('hidden');
        $('partner-download-btn').onclick = () => downloadDataUrl(finalImg, 'photobooth.png');
      }
      showScreen('screen-partner-wait');
    }
  }

  // ------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------
  $('ld-chat-btn').addEventListener('click', () => {
    $('chat-sheet').showModal();
    $('ld-chat-badge').classList.add('hidden');
  });
  $('chat-close').addEventListener('click', () => $('chat-sheet').close());
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    wsSend('chat', { text });
    addChatMessage({ text, who: state.role, ts: Date.now() / 1000, self: true });
    input.value = '';
  });

  function addChatMessage(msg) {
    const wrap = $('chat-messages');
    const mine = msg.self || msg.who === state.role;
    const row = document.createElement('div');
    row.className = 'flex ' + (mine ? 'justify-end' : 'justify-start');
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[75%] rounded-2xl px-3 py-2 text-sm ' + (mine ? 'bg-mp-pink text-white' : 'bg-gray-100 text-mp-dark');
    bubble.textContent = msg.text;
    row.appendChild(bubble);
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
    if (!$('chat-sheet').open && !mine) $('ld-chat-badge').classList.remove('hidden');
  }

  // ------------------------------------------------------------
  // Customizer (host only)
  // ------------------------------------------------------------
  function openCustomizer() {
    // From here on, this room is "done" from the host's point of view —
    // never resume back into it, even if they reload or close the tab
    // before ever tapping Finish.
    markSessionEnded();
    closeAllConnections(false);
    showScreen('screen-customize');
    buildTemplateTabs();
    buildStickerGrid();
    buildFilterGrid();
    buildOrderList();
    const tpl = findTemplate(state.templateId);
    $('bg-color-input').value = tpl.bg;
    $('frame-color-input').value = tpl.frameColor || tpl.bg;
    $('frame-width-input').value = tpl.frameWidth || 14;
    $('text-color-input').value = tpl.textColor || '#1F2937';
    updatePreview();
  }

  // Lets the host reorder the captured photos before export — a lightweight
  // up/down list rather than a full drag-and-drop canvas, which keeps this
  // simple and reliable across touch and mouse.
  function buildOrderList() {
    const wrap = $('order-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.finalPhotos.forEach((src, i) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 brutal-border rounded-lg p-1.5 bg-white';
      const img = document.createElement('img');
      img.src = src;
      img.className = 'w-10 h-10 object-cover rounded-md';
      const label = document.createElement('span');
      label.className = 'flex-1 text-xs font-bold text-gray-500';
      label.textContent = `Photo ${i + 1}`;
      const upBtn = document.createElement('button');
      upBtn.className = 'btn-press icon-btn w-7 h-7 rounded-full brutal-border bg-white disabled:opacity-30';
      upBtn.innerHTML = '<svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      upBtn.disabled = i === 0;
      upBtn.title = 'Move up';
      upBtn.addEventListener('click', () => {
        [state.finalPhotos[i - 1], state.finalPhotos[i]] = [state.finalPhotos[i], state.finalPhotos[i - 1]];
        buildOrderList();
        schedulePreview();
      });
      const downBtn = document.createElement('button');
      downBtn.className = 'btn-press icon-btn w-7 h-7 rounded-full brutal-border bg-white disabled:opacity-30';
      downBtn.innerHTML = '<svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
      downBtn.disabled = i === state.finalPhotos.length - 1;
      downBtn.title = 'Move down';
      downBtn.addEventListener('click', () => {
        [state.finalPhotos[i], state.finalPhotos[i + 1]] = [state.finalPhotos[i + 1], state.finalPhotos[i]];
        buildOrderList();
        schedulePreview();
      });
      row.append(img, label, upBtn, downBtn);
      wrap.appendChild(row);
    });
  }

  function buildStickerGrid() {
    const wrap = $('sticker-grid');
    wrap.innerHTML = '';
    STICKER_LIBRARY.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'btn-press brutal-border rounded-xl bg-white aspect-square flex items-center justify-center';
      btn.title = s.label;
      btn.dataset.stickerId = s.id;
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      drawSticker(c.getContext('2d'), s.id, 16, 16, 22, '#FF7EB6');
      btn.appendChild(c);
      btn.addEventListener('click', () => {
        const active = state.customization.stickers ? state.customization.stickers.slice() : (findTemplate(state.templateId).stickers || []).slice();
        const idx = active.indexOf(s.id);
        if (idx >= 0) active.splice(idx, 1); else active.push(s.id);
        state.customization.stickers = active.slice(0, 2);
        refreshStickerSelection();
        schedulePreview();
      });
      wrap.appendChild(btn);
    });
    refreshStickerSelection();
  }

  function refreshStickerSelection() {
    const active = state.customization.stickers || findTemplate(state.templateId).stickers || [];
    qsa('#sticker-grid button').forEach(btn => {
      btn.classList.toggle('selected-sticker', active.includes(btn.dataset.stickerId));
      btn.style.outline = active.includes(btn.dataset.stickerId) ? '3px solid #FF7EB6' : 'none';
      btn.style.outlineOffset = '2px';
    });
  }

  function buildFilterGrid() {
    const wrap = $('filter-grid');
    wrap.innerHTML = '';
    FILTER_PRESETS.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'filter-btn btn-press brutal-border rounded-xl bg-white text-xs font-bold py-3';
      btn.textContent = f.label;
      btn.dataset.filterId = f.id;
      btn.addEventListener('click', () => {
        state.customization.filter = f.id;
        qsa('.filter-btn', wrap).forEach(b => { b.classList.remove('bg-mp-pink', 'text-white'); b.classList.add('bg-white', 'text-mp-dark'); });
        btn.classList.add('bg-mp-pink', 'text-white');
        btn.classList.remove('bg-white', 'text-mp-dark');
        schedulePreview();
      });
      if (f.id === state.customization.filter) { btn.classList.add('bg-mp-pink', 'text-white'); }
      else { btn.classList.add('bg-white', 'text-mp-dark'); }
      wrap.appendChild(btn);
    });
  }

  $('reset-btn').addEventListener('click', () => {
    state.customization = {
      bgColor: null, frameColor: null, frameWidth: null,
      title: '', subtitle: '', showDate: true, textColor: null,
      orientation: 'vertical', layout: 'strip', spacing: 10,
      stickers: null, filter: 'none',
    };
    $('title-input').value = '';
    $('subtitle-input').value = '';
    $('show-date-input').checked = true;
    $('spacing-input').value = 10;
    qsa('.orient-btn').forEach(b => { b.classList.remove('bg-mp-pink', 'text-white'); b.classList.add('bg-white', 'text-mp-dark'); });
    qs('.orient-btn[data-orient="vertical"]').classList.add('bg-mp-pink', 'text-white');
    qsa('.layout-btn').forEach(b => { b.classList.remove('bg-mp-pink', 'text-white'); b.classList.add('bg-white', 'text-mp-dark'); });
    qs('.layout-btn[data-layout="strip"]').classList.add('bg-mp-pink', 'text-white');
    const tpl = findTemplate(state.templateId);
    $('bg-color-input').value = tpl.bg;
    $('frame-color-input').value = tpl.frameColor || tpl.bg;
    $('frame-width-input').value = tpl.frameWidth || 14;
    $('text-color-input').value = tpl.textColor || '#1F2937';
    refreshStickerSelection();
    buildFilterGrid();
    schedulePreview();
    toast('Customization reset');
  });

  function buildTemplateTabs() {
    const wrap = $('template-categories');
    wrap.innerHTML = '';
    TEMPLATE_CATEGORIES.forEach(cat => {
      const section = document.createElement('div');
      section.className = 'mb-4 last:mb-0';
      const h = document.createElement('p');
      h.className = 'text-xs font-bold text-gray-400 mb-2 uppercase tracking-wide';
      h.textContent = cat.label;
      section.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-3 gap-2';
      cat.templates.forEach(t => {
        const sw = document.createElement('button');
        sw.className = 'tpl-swatch brutal-border' + (t.id === state.templateId ? ' selected' : '');
        sw.style.background = t.bg;
        sw.title = t.name;
        sw.innerHTML = `<span style="position:absolute;bottom:4px;left:4px;right:4px;font-size:9px;font-weight:800;color:${t.textColor};text-align:center;">${t.name}</span>`;
        sw.addEventListener('click', () => {
          state.templateId = t.id;
          qsa('.tpl-swatch', wrap).forEach(s => s.classList.remove('selected'));
          sw.classList.add('selected');
          $('bg-color-input').value = t.bg;
          $('frame-color-input').value = t.frameColor || t.bg;
          $('frame-width-input').value = t.frameWidth || 14;
          $('text-color-input').value = t.textColor || '#1F2937';
          state.customization.bgColor = null;
          state.customization.frameColor = null;
          state.customization.frameWidth = null;
          state.customization.textColor = null;
          state.customization.stickers = null;
          refreshStickerSelection();
          updatePreview();
          if (state.role === 'host' && state.mode === 'long_distance') wsSend('set_template', { template_id: t.id });
        });
        grid.appendChild(sw);
      });
      section.appendChild(grid);
      wrap.appendChild(section);
    });
  }

  qsa('.cust-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      qsa('.cust-tab').forEach(t => { t.classList.remove('bg-mp-pink', 'text-white'); t.classList.add('bg-white', 'text-mp-dark'); });
      tab.classList.add('bg-mp-pink', 'text-white');
      tab.classList.remove('bg-white', 'text-mp-dark');
      qsa('.cust-panel').forEach(p => p.classList.add('hidden'));
      $('tab-' + tab.dataset.tab).classList.remove('hidden');
    });
  });

  let previewDebounce = null;
  function schedulePreview() {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(updatePreview, 60);
  }

  $('bg-color-input').addEventListener('input', (e) => { state.customization.bgColor = e.target.value; schedulePreview(); });
  $('frame-color-input').addEventListener('input', (e) => { state.customization.frameColor = e.target.value; schedulePreview(); });
  $('frame-width-input').addEventListener('input', (e) => { state.customization.frameWidth = parseInt(e.target.value, 10); schedulePreview(); });
  $('title-input').addEventListener('input', (e) => { state.customization.title = e.target.value; schedulePreview(); });
  $('subtitle-input').addEventListener('input', (e) => { state.customization.subtitle = e.target.value; schedulePreview(); });
  $('text-color-input').addEventListener('input', (e) => { state.customization.textColor = e.target.value; schedulePreview(); });
  $('show-date-input').addEventListener('change', (e) => { state.customization.showDate = e.target.checked; schedulePreview(); });
  $('spacing-input').addEventListener('input', (e) => { state.customization.spacing = parseInt(e.target.value, 10); schedulePreview(); });
  qsa('.orient-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.customization.orientation = btn.dataset.orient;
      qsa('.orient-btn').forEach(b => { b.classList.remove('bg-mp-pink', 'text-white'); b.classList.add('bg-white', 'text-mp-dark'); });
      btn.classList.add('bg-mp-pink', 'text-white');
      btn.classList.remove('bg-white', 'text-mp-dark');
      schedulePreview();
    });
  });
  qsa('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.customization.layout = btn.dataset.layout;
      qsa('.layout-btn').forEach(b => { b.classList.remove('bg-mp-pink', 'text-white'); b.classList.add('bg-white', 'text-mp-dark'); });
      btn.classList.add('bg-mp-pink', 'text-white');
      btn.classList.remove('bg-white', 'text-mp-dark');
      schedulePreview();
    });
  });

  async function updatePreview() {
    if (!state.finalPhotos.length) return;
    const tpl = findTemplate(state.templateId);
    const canvas = $('preview-canvas');
    await renderStrip(canvas, state.finalPhotos, tpl, state.customization, 1);
  }

  $('download-btn').addEventListener('click', async () => {
    const tpl = findTemplate(state.templateId);
    const exportCanvas = document.createElement('canvas');
    await renderStrip(exportCanvas, state.finalPhotos, tpl, state.customization, 3);
    const dataUrl = exportCanvas.toDataURL('image/png');
    downloadDataUrl(dataUrl, 'photobooth-strip.png');
  });

  $('print-btn').addEventListener('click', async () => {
    const tpl = findTemplate(state.templateId);
    const exportCanvas = document.createElement('canvas');
    await renderStrip(exportCanvas, state.finalPhotos, tpl, state.customization, 3);
    const dataUrl = exportCanvas.toDataURL('image/png');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Print</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;"><img src="${dataUrl}" style="max-width:100%;" onload="window.print()"/></body></html>`);
    w.document.close();
  });

  $('share-btn').addEventListener('click', async () => {
    const tpl = findTemplate(state.templateId);
    const exportCanvas = document.createElement('canvas');
    await renderStrip(exportCanvas, state.finalPhotos, tpl, state.customization, 3);
    const dataUrl = exportCanvas.toDataURL('image/png');
    // Prefer the Web Share API (with a real file, where supported) so this
    // hands off straight into Messages/Instagram/etc.; fall back to a plain
    // download if sharing files isn't supported on this browser.
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'photobooth-strip.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Photobooth Strip' });
        return;
      }
    } catch (e) { /* fall through to download */ }
    downloadDataUrl(dataUrl, 'photobooth-strip.png');
    toast('Sharing not supported here — downloaded instead');
  });

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  $('finish-btn').addEventListener('click', async () => {
    if (state.mode === 'long_distance') {
      const tpl = findTemplate(state.templateId);
      const exportCanvas = document.createElement('canvas');
      await renderStrip(exportCanvas, state.finalPhotos, tpl, state.customization, 2);
      const finalImage = exportCanvas.toDataURL('image/jpeg', 0.9);
      wsSend('customize', { customization: { ...state.customization, final_image: finalImage } });
      wsSend('finish');
    }
    toast('All done!');
    clearSession();
    closeAllConnections();
    state.room = null;
    state.role = null;
    state.mode = null;
    showScreen('screen-entry');
  });

  // ------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------
  function closeAllConnections(closeWS = true) {
    clearInterval(state.ldWaitResyncTimer);
    clearTimeout(state.ldStuckRetryTimer);
    if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
    if (togetherStream) { togetherStream.getTracks().forEach(t => t.stop()); togetherStream = null; }
    if (state.pc) { try { state.pc.close(); } catch (e) {} state.pc = null; }
    if (closeWS && state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    clearTimeout(state.wsReconnectTimer);
  }

  window.addEventListener('beforeunload', () => closeAllConnections());

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------
  // Reattaches to a long-distance room after a reload/reopen instead of
  // dropping the person back to "enter a room code". Reads the persisted
  // room code, re-fetches the room fresh from the server (never trusts
  // anything cached beyond the code itself — role, state, and photos so
  // far all come from this call), and either lands back on the waiting
  // screen or straight back into the live camera/review flow, matching
  // wherever the room actually is right now.
  async function resumeSession() {
    const code = loadSession();
    if (!code) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(code)}`);
      if (!data.room || !data.role || data.room.mode !== 'long_distance' || data.room.state === 'completed') {
        clearSession(); // not a member anymore, wrong mode, or already finished — nothing to resume
        return;
      }
      state.room = data.room;
      state.role = data.role;
      state.mode = data.room.mode;
      state.photoCount = data.room.photo_count;
      connectWS(state.room.room_code);
      if (data.room.state === 'waiting') {
        // Only reachable for the host, before a partner has ever joined.
        $('waiting-code').textContent = state.room.room_code;
        showScreen('screen-waiting');
      } else if (data.room.state === 'customizing') {
        // onSessionCompleteLD() already branches on role internally (host
        // rebuilds the composed strip and opens the customizer; partner
        // just lands on the wait screen for the host's 'completed'
        // broadcast) — exactly what a resume needs here too, no separate
        // partner-only branch required.
        await onSessionCompleteLD();
      } else {
        await startLongDistanceMode();
        // Restores the frozen Retake/Next review UI immediately if the
        // room was already sitting mid-review when the page reloaded,
        // instead of leaving both people staring at live camera feeds
        // for a photo that's technically already been taken.
        evaluateCaptureState(state.room.current_photo || 0);
      }
      toast('Reconnected to your session');
    } catch (e) {
      // Room gone (expired/deleted) or this device is no longer a member —
      // silently fall back to the normal entry screen rather than erroring.
      clearSession();
    }
  }

  async function boot() {
    try {
      await loadConfig();
      await checkAuth();
    } catch (e) { /* not fatal */ }

    if (window._autoJoinCode && state.user) {
      $('join-code-input').value = window._autoJoinCode;
      showScreen('screen-join');
      doJoin();
    } else if (window._autoJoinCode) {
      requireLogin('join');
    } else if (state.user) {
      await resumeSession();
      // Only surface this once, on the very next load after a session
      // genuinely ended (see markSessionEnded()) — consumed immediately so
      // it doesn't reappear on every later reload. Skipped entirely if an
      // explicit join link or an in-progress room just resumed above; this
      // is specifically for "you were done, here's the reminder to start
      // fresh" and would be noise in either of those cases.
      let justEnded = false;
      try { justEnded = !!localStorage.getItem(NEW_SESSION_NOTICE_KEY); localStorage.removeItem(NEW_SESSION_NOTICE_KEY); } catch (e) { /* ignore */ }
      if (justEnded && !state.room) {
        toast('Join or start a new session to continue');
      }
    }
  }

  boot();
})();
