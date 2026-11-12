// =============================================================
// Supabase Auth for every page.
//
// Load it synchronously in <head>, right after supabase-js and before
// sync.js / topbar.js:
//     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//     <script src="auth.js"></script>
//
// - One shared Supabase client (window.appAuth.client) with a persistent,
//   auto-refreshing session (survives browser restarts).
// - App pages stay hidden until a session is confirmed; no session →
//   /auth.html?next=<this page>. Sign-out or an expired/revoked session
//   anywhere → back to /auth.html.
// - Device data (localStorage) belongs to one account: it is wiped on
//   sign-out and when a different account signs in on this device.
//
// The publishable key below is meant to be public. It grants nothing on
// its own: Row Level Security (supabase/auth-migration.sql) limits every
// signed-in user to their own rows. Never put a service-role/secret key
// in frontend code.
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://wrkvressribywjmsvmsy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_vXOAfADTf6WRicVvAdpaXg_rAXJqByV';
  const STORAGE_KEY = 'personal-os-auth';   // where supabase-js keeps the session
  const OWNER_KEY = 'app:owner';            // which account the device data belongs to
  const AUTH_PAGE = '/auth.html';

  const path = (location.pathname || '').toLowerCase();
  const isAuthPage = path.endsWith('/auth.html') || path.endsWith('auth.html');
  const isEmbedded = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();

  // Hide app pages until we know who is signed in (no flash of data).
  if (!isAuthPage) {
    document.documentElement.classList.add('auth-pending');
    const st = document.createElement('style');
    st.id = 'auth-pending-style';
    st.textContent = 'html.auth-pending body { visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(st);
  }
  function reveal() { document.documentElement.classList.remove('auth-pending'); }

  let client = null;
  try {
    if (window.supabase && window.supabase.createClient) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          // Implicit flow: email links (confirm / reset password) work even
          // when opened on a different device or browser than the request.
          flowType: 'implicit',
          storageKey: STORAGE_KEY,
        },
      });
    }
  } catch (e) { client = null; }

  let session = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  function storedSession() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return s && s.access_token && s.user ? s : null;
    } catch (e) { return null; }
  }

  // Remove all app data from this device; keep only the auth session.
  function clearLocalData() {
    const keep = (k) => k === STORAGE_KEY || k.indexOf('sb-') === 0;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !keep(k)) keys.push(k);
    }
    keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    try { sessionStorage.clear(); } catch (e) {}
    // Cached copies of storage objects (progress photos) from the SW.
    try {
      if (window.caches) {
        caches.keys().then((names) => names.forEach((n) => {
          caches.open(n).then((c) => c.keys().then((reqs) => reqs.forEach((r) => {
            if (/\/storage\/v1\/object\//.test(r.url)) c.delete(r);
          })));
        }));
      }
    } catch (e) {}
  }

  // Claim this device's data for `userId`. Returns true if data belonging
  // to another account had to be wiped.
  function adoptDevice(userId) {
    let prev = null;
    try { prev = localStorage.getItem(OWNER_KEY); } catch (e) {}
    let wiped = false;
    if (prev && prev !== userId) { clearLocalData(); wiped = true; }
    try { localStorage.setItem(OWNER_KEY, userId); } catch (e) {}
    return wiped;
  }

  function safeNext(raw) {
    // Same-origin relative paths only (no open redirects).
    if (!raw || typeof raw !== 'string') return '/index.html';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '/index.html';
    if (/^\/auth\.html/i.test(raw)) return '/index.html';
    return raw;
  }
  function goToAuth(reason) {
    if (isAuthPage) return;
    if (isEmbedded) return; // the page around the embed handles it
    const next = location.pathname + location.search + location.hash;
    location.replace(AUTH_PAGE + '?next=' + encodeURIComponent(next) + (reason ? '&reason=' + reason : ''));
  }

  // Sync layers register a "save what's pending" hook here.
  const beforeSignOutHooks = [];
  function beforeSignOut(fn) { if (typeof fn === 'function') beforeSignOutHooks.push(fn); }

  async function signOut() {
    // Push anything not yet saved (max ~4 s), then end the session and wipe.
    try {
      await Promise.race([
        Promise.all(beforeSignOutHooks.map((f) => Promise.resolve().then(f).catch(() => {}))),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch (e) {}
    signingOut = true;
    try { if (client) await client.auth.signOut({ scope: 'local' }); } catch (e) {}
    clearLocalData();
    try { localStorage.removeItem(OWNER_KEY); } catch (e) {}
    location.replace(AUTH_PAGE + '?reason=signed_out');
  }
  let signingOut = false;

  window.appAuth = {
    client,
    ready,                       // Promise<session|null>
    get session() { return session; },
    get user() { return session && session.user ? session.user : null; },
    accessToken() { return session && session.access_token ? session.access_token : null; },
    url: SUPABASE_URL,
    key: SUPABASE_KEY,
    isAuthPage,
    signOut,
    beforeSignOut,
    adoptDevice,
    clearLocalData,
    safeNext,
  };

  if (client) {
    client.auth.onAuthStateChange((event, s) => {
      session = s || null;
      if (event === 'SIGNED_OUT' && !isAuthPage && !signingOut) {
        // Signed out elsewhere, or the refresh token expired / was revoked.
        clearLocalData();
        try { localStorage.removeItem(OWNER_KEY); } catch (e) {}
        goToAuth('expired');
      }
    });
  }

  (async function init() {
    if (!client) {
      // supabase-js couldn't load (offline, first visit) — allow the
      // offline copy only if this device already has a session.
      const s = storedSession();
      if (s && !isAuthPage) { session = s; reveal(); resolveReady(null); }
      else if (!isAuthPage) goToAuth();
      else resolveReady(null);
      return;
    }
    let s = null;
    try {
      const { data } = await client.auth.getSession();
      s = data ? data.session : null;
    } catch (e) {}
    if (!s && !isAuthPage) {
      // supabase-js deletes the stored session only when it is definitely
      // invalid (refresh token revoked/expired). If it is still there, the
      // refresh failed for a network reason: keep working locally and
      // retry when the connection comes back.
      const stored = storedSession();
      if (stored) {
        session = stored; reveal(); resolveReady(null);
        window.addEventListener('online', () => location.reload(), { once: true });
        return;
      }
    }
    session = s;
    if (isAuthPage) { resolveReady(s); return; }
    if (!s) { goToAuth(); return; }
    if (!isEmbedded && adoptDevice(s.user.id)) { location.reload(); return; }
    reveal();
    resolveReady(s);
  })();

  // Re-check the session when the app comes back to the foreground (an
  // expired session should land on the sign-in screen, not a dead page).
  if (!isAuthPage && client) {
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || !navigator.onLine) return;
      try {
        const { data } = await client.auth.getSession();
        if (data && data.session) { session = data.session; return; }
        if (!storedSession()) { clearLocalData(); goToAuth('expired'); } // definitively signed out
      } catch (e) {}
    });
  }
})();
