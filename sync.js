// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two constants with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
//
// Several pages can share one appKey row (e.g. health.html and
// po-water.html both use 'health'). Each page only owns the keys it
// lists; when pushing, keys owned by other pages are preserved from
// the last-known remote state so one page never wipes another's data.
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://wrkvressribywjmsvmsy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_vXOAfADTf6WRicVvAdpaXg_rAXJqByV';

  // Reload the page so it re-renders from freshly synced localStorage.
  // If the user is typing in a field, wait until they leave it.
  let reloadPending = false;
  window.cloudSyncReload = function () {
    if (reloadPending) return;
    reloadPending = true;
    function isEditing() {
      const el = document.activeElement;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' || el.isContentEditable);
    }
    function tryReload() {
      if (isEditing()) return;
      document.removeEventListener('focusout', onFocusOut, true);
      location.reload();
    }
    function onFocusOut() { setTimeout(tryReload, 0); }
    if (isEditing()) document.addEventListener('focusout', onFocusOut, true);
    else tryReload();
  };

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;
    let remoteState = {}; // last-known full row data, including keys other pages own

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
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      remoteState = remote;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      const state = buildPayload();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { lastSyncedJson = json; remoteState = state; }
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      if (!supa) return; // never pushed/pulled yet — don't overwrite remote blindly
      const state = buildPayload();
      const json = JSON.stringify(state);
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
      } catch (e) {}
    }
    (async function init() {
      const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await client.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) throw error;
        supa = client;
        if (data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
          // Push local-only keys this page owns that the row doesn't have yet.
          if (JSON.stringify(buildPayload()) !== lastSyncedJson) schedulePush();
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {
        // Couldn't read the row (offline etc.) — stay local-only this session
        // rather than risk overwriting other pages' keys with a partial row.
        return;
      }
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
