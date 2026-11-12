// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two constants with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
//
// Several pages can share one appKey row (e.g. health.html and
// po-water.html both use 'health'). Each page only owns the keys it
// lists; when pushing, keys owned by other pages are preserved from
// the last-known remote state so one page never wipes another's data.
//
// Live updates, three layers:
//   1. Supabase Realtime (postgres_changes on app_state) — instant.
//      Requires app_state in the supabase_realtime publication; see
//      supabase/enable-realtime.sql.
//   2. Re-pull whenever the app comes back to the foreground, regains
//      focus or comes back online (phones suspend the socket in the
//      background), and re-subscribe if the channel drops.
//   3. A light poll (one single-row select every 20 s, only while the
//      page is visible) as a safety net.
// Pages redraw in place through onApplied; see cloudSyncRefresh().
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://wrkvressribywjmsvmsy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_vXOAfADTf6WRicVvAdpaXg_rAXJqByV';

  const POLL_MS = 20 * 1000;
  const RESUME_THROTTLE_MS = 1500;

  // Key-order-independent JSON. Postgres stores app_state.data as jsonb,
  // which reorders object keys, so plain JSON.stringify of the same data
  // differs between what we pushed and what comes back.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  window.cloudSyncCanon = canon;

  // ---------- "is the user in the middle of something?" ----------
  function isEditing() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' || el.isContentEditable)) return true;
    return !!document.querySelector('.modal-bg.show, .po-modal-bg.show');
  }

  // Run a page's redraw now, or as soon as the user stops typing / closes
  // a modal. Repeated calls while waiting collapse into the latest one.
  let pendingRefresh = null, refreshWatch = null;
  function flushRefresh() {
    if (!pendingRefresh || isEditing()) return;
    const fn = pendingRefresh;
    pendingRefresh = null;
    clearInterval(refreshWatch); refreshWatch = null;
    try { fn(); } catch (e) {}
  }
  window.cloudSyncRefresh = function (fn) {
    if (typeof fn !== 'function') return;
    pendingRefresh = fn;
    if (!isEditing()) { flushRefresh(); return; }
    if (!refreshWatch) refreshWatch = setInterval(flushRefresh, 500);
  };
  document.addEventListener('focusout', () => setTimeout(flushRefresh, 0), true);

  // Legacy: full reload once the user isn't editing. Kept for any page
  // that still uses it; the built-in pages redraw in place instead.
  window.cloudSyncReload = function () {
    window.cloudSyncRefresh(function () { location.reload(); });
  };

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    let supa = null;            // set once the first pull succeeded
    let channel = null;
    let pushTimer = null, pushInFlight = false;
    let suppressSync = false, lastSyncedJson = null;
    let remoteState = {};       // last-known full row data, including keys other pages own
    let dirtyOffline = false;   // local edits made before we ever reached the server
    let initInFlight = false, pullInFlight = false;
    let lastResume = 0, resubTimer = null, resubDelay = 2000;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    // Remote keys this page doesn't own + this page's local keys.
    function buildPayload() {
      const out = {};
      for (const k of Object.keys(remoteState)) {
        if (!matches(k)) out[k] = remoteState[k];
      }
      return Object.assign(out, collect());
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    function onLocalWrite(k) {
      if (suppressSync || !matches(k)) return;
      if (!supa) { dirtyOffline = true; return; }
      schedulePush();
    }
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { onLocalWrite(k); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { onLocalWrite(k); } catch (e) {}
    };
    function notify() {
      if (typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      try { window.dispatchEvent(new CustomEvent('cloud-sync-applied', { detail: { appKey } })); } catch (e) {}
    }
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      remoteState = remote;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const local = localStorage.getItem(k);
          let same = false;
          if (local != null) {
            try { same = canon(JSON.parse(local)) === canon(remote[k]); } catch (e) { same = false; }
          }
          if (!same) { try { origSet(k, JSON.stringify(remote[k])); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed) notify();
      return changed;
    }
    // A remote row arrived (realtime, pull or poll).
    function receive(data) {
      const incoming = canon(data);
      if (incoming === lastSyncedJson) return;           // nothing new / echo of our push
      if (pushTimer || pushInFlight) return;             // our newer local edit is about to win
      lastSyncedJson = incoming;
      applyRemote(data);
    }

    async function pushNow() {
      pushTimer = null;
      if (!supa) return;
      const state = buildPayload();
      const json = canon(state);
      if (json === lastSyncedJson) return;
      pushInFlight = true;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { lastSyncedJson = json; remoteState = state; }
      } catch (e) {}
      pushInFlight = false;
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      if (!supa) return; // never pulled yet — don't overwrite remote blindly
      const state = buildPayload();
      const json = canon(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
        clearTimeout(pushTimer); pushTimer = null;
      } catch (e) {}
    }

    async function fetchRow() {
      const { data, error } = await client.from('app_state').select('data').eq('key', appKey).maybeSingle();
      if (error) throw error;
      return data && data.data && typeof data.data === 'object' ? data.data : null;
    }

    // First successful contact with the server (retried until it works).
    async function init() {
      if (supa || initInFlight) return;
      initInFlight = true;
      try {
        const remote = await fetchRow();
        supa = client;
        if (dirtyOffline) {
          // Edited before we could reach the server: keep other pages' keys
          // from the row, let this device's edits win, and push them.
          remoteState = remote || {};
          dirtyOffline = false;
          schedulePush();
        } else if (remote && Object.keys(remote).length > 0) {
          lastSyncedJson = canon(remote);
          applyRemote(remote);
          if (canon(buildPayload()) !== lastSyncedJson) schedulePush();
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
        subscribe();
      } catch (e) {
        // Offline / server unreachable — stay local; resume/online/poll retries.
      } finally { initInFlight = false; }
    }

    // Catch up after the socket was asleep or a change was missed.
    async function pull() {
      if (!supa) { init(); return; }
      if (pullInFlight || pushTimer || pushInFlight) return;
      pullInFlight = true;
      try {
        const remote = await fetchRow();
        if (remote) receive(remote);
      } catch (e) {}
      pullInFlight = false;
    }

    function subscribe() {
      if (!supa) return;
      if (channel) { try { supa.removeChannel(channel); } catch (e) {} channel = null; }
      const ch = supa.channel('app_state_' + appKey + '_' + Math.random().toString(36).slice(2, 8));
      channel = ch;
      ch.on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (ch === channel && payload.new && payload.new.data) receive(payload.new.data);
        })
        .subscribe((status) => {
          if (ch !== channel) return; // a replaced channel reporting its own shutdown
          if (status === 'SUBSCRIBED') {
            resubDelay = 2000;
            pull(); // anything that changed while we were (re)connecting
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            scheduleResubscribe();
          }
        });
    }
    function scheduleResubscribe() {
      if (resubTimer || document.hidden) return;
      resubTimer = setTimeout(() => {
        resubTimer = null;
        subscribe();
      }, resubDelay);
      resubDelay = Math.min(resubDelay * 2, 60000);
    }
    function channelHealthy() {
      return !!channel && (channel.state === 'joined' || channel.state === 'joining');
    }

    function onResume() {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastResume < RESUME_THROTTLE_MS) return;
      lastResume = now;
      if (!supa) { init(); return; }
      if (!channelHealthy()) { clearTimeout(resubTimer); resubTimer = null; subscribe(); }
      pull();
    }

    init();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushOnUnload(); else onResume();
    });
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onResume);
    window.addEventListener('pageshow', (e) => { if (e.persisted) onResume(); });
    setInterval(() => { if (!document.hidden) pull(); }, POLL_MS);
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) onLocalWrite(e.key); });
  };
})();
