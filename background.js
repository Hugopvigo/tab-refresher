/* ════════════════════════════════════════════════════════════════
   Tab Refresher v2.3.0 — service worker
   Desarrollado por: Hugo Perez-Vigo / hugopvigo
   https://github.com/hugopvigo
   ════════════════════════════════════════════════════════════════ */

const TICK = 'refresh-tick';
const alarmName = (tabId) => `reload-${tabId}`;

const ACTIVE_ICON = { 16: 'icon-active-16.png', 32: 'icon-active-32.png', 48: 'icon-active-48.png' };
const DEFAULT_ICON = { 16: 'icon.png', 32: 'icon.png', 48: 'icon.png' };

/* ── Storage es la fuente de verdad (el worker MV3 se reinicia con frecuencia) ──
   Nota: refreshTab/upsert/reconcile hacen cada uno su propio load→modify→persist
   sin bloqueo mutuo. Con un solo usuario y eventos espaciados (alarmas >=30s,
   acciones manuales esporádicas) el riesgo real es perder un `lastRefresh`
   puntual en una colisión de milisegundos, que se autocorrige en el siguiente
   ciclo — no se ha añadido una cola de escritura por no justificarse aquí. */
async function load() {
  const d = await chrome.storage.local.get('configs');
  return d.configs || {};
}
async function persist(configs) {
  await chrome.storage.local.set({ configs });
}

/* ── Icono por pestaña: verde cuando esa pestaña tiene recarga activa.
   chrome.action.setIcon con tabId es per-tab: Chrome ya solo lo muestra
   cuando esa pestaña está activa, no hace falta escuchar tabs.onActivated. ── */
async function setTabIcon(tabId, active) {
  try {
    await chrome.action.setIcon({ tabId, path: active ? ACTIVE_ICON : DEFAULT_ICON });
  } catch (e) {
    console.warn(`Tab Refresher: setIcon falló para tab ${tabId}`, e);
  }
}

/* ── Evita que Chrome (Memory Saver) hiberne/descarte pestañas con recarga
   activa: autoDiscardable es una propiedad de la pestaña real, no de storage,
   así que hay que reafirmarla tras cada reinicio de Chrome (ver reconcile). ── */
async function setAutoDiscardable(tabId, discardable) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: discardable });
  } catch (e) {
    console.warn(`Tab Refresher: autoDiscardable(${discardable}) falló para tab ${tabId}`, e);
  }
}

/* ── Alarmas ──
   Nota: periodInMinutes < 1 (intervalos <60s) solo funciona en extensiones
   sin empaquetar (modo desarrollador). Si algún día se publica en la Web
   Store, Chrome clamparía esos intervalos a 1 minuto. */
function ensureAlarm(configs, tabId) {
  const c = configs[tabId];
  if (c && c.active && c.interval > 0) {
    chrome.alarms.create(alarmName(tabId), { periodInMinutes: Math.max(c.interval, 30) / 60 });
  } else {
    chrome.alarms.clear(alarmName(tabId));
  }
}

/* ── Estadísticas de keep-alive ── */
async function bumpStats() {
  try {
    const { stats } = await chrome.storage.local.get('stats');
    const s = stats || { total: 0 };
    s.total += 1;
    await chrome.storage.local.set({ stats: s });
  } catch (e) { /* las stats nunca deben romper el refresco */ }
}

/* ── Refresco de una pestaña ── */
async function refreshTab(tabId) {
  const configs = await load();
  const c = configs[tabId];
  if (!c || !c.active) return;

  if (await isPaused()) return;

  /* Smart Focus: si el usuario está EN esta pestaña, NO recargar.
     La alarma periódica volverá a disparar en un intervalo. */
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.focused) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (activeTab?.id === tabId) {
        return;
      }
    }
  } catch (e) {
    console.warn('Tab Refresher: focus check falló', e);
  }

  c.lastRefresh = Date.now();
  await persist(configs);
  try {
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await bumpStats();
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.discarded) {
      console.warn(`Tab Refresher: tab ${tabId} sigue descartada tras reload, forzando navegación`);
      await chrome.tabs.update(tabId, { url: t.url }).catch(
        (e) => console.warn(`Tab Refresher: fallback de navegación falló para tab ${tabId}`, e)
      );
      await setTabIcon(tabId, true);
    }
  } catch (e) {
    const open = await chrome.tabs.get(tabId).catch(() => null);
    if (!open) {
      delete configs[tabId];
      chrome.alarms.clear(alarmName(tabId));
      await persist(configs);
      await clearTabBadge(tabId);
    }
    console.warn(`Tab Refresher: reload falló para tab ${tabId}`, e);
  }
  await updateBadge();
}

/* ── Helpers para atajos y menú contextual ──
   Mismo criterio que el popup (isUsable): no crear configs sobre páginas
   internas, quedarían como alarmas zombi que fallan en silencio. */
function isUsableUrl(url) {
  return !!url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://');
}

async function toggleTabRefresh(tabId) {
  const configs = await load();
  const prev = configs[tabId];
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isUsableUrl(tab.url)) return;
  const active = !(prev?.active);
  const interval = prev?.interval || 90;
  await upsert(tabId, { url: tab.url, title: tab.title, interval, active });
}

/* Apagar sin machacar el intervalo configurado: se conserva para cuando
   se reactive por Alt+R o desde el popup. */
async function pauseTabRefresh(tabId) {
  const configs = await load();
  const prev = configs[tabId];
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !prev) return;
  await upsert(tabId, { url: tab.url, title: tab.title, interval: prev.interval || 90, active: false });
}

/* ── Refresco manual ── */
async function refreshNow(tabId) {
  const configs = await load();
  const c = configs[tabId];
  if (!c) return;
  try {
    await chrome.tabs.reload(tabId, { bypassCache: false });
    c.lastRefresh = Date.now();
    await persist(configs);
    await bumpStats();
  } catch (e) { /* noop */ }
  await updateBadge();
}

/* ── Badge por-pestaña ──
   El badge es global si no se pasa tabId: todas las pestañas mostrarían
   el mismo countdown, lo que no tiene sentido con varias configuradas.
   Correcto: badge solo en las pestañas con refresco activo (su propia
   cuenta atrás), y global vacío para que el resto herede ''. */
function fmtCountdown(secs) {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function badgeText(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 600) return fmtCountdown(secs);
  return `${Math.floor(secs / 60)}m`;
}

/* El estado per-tab del badge no muere solo al quitar la config: hay que
   limpiarlo explícitamente o la pestaña se queda con un contador zombi. */
async function clearTabBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) { /* la pestaña pudo cerrarse */ }
}

async function isPaused() {
  const { pausedUntil } = await chrome.storage.local.get('pausedUntil');
  return Date.now() < (pausedUntil || 0);
}

async function updateBadge() {
  const configs = await load();
  const now = Date.now();
  const paused = await isPaused();
  for (const [idStr, c] of Object.entries(configs)) {
    const tabId = parseInt(idStr);
    try {
      if (!paused && c.active && c.lastRefresh) {
        const remaining = Math.max(0, Math.ceil((c.lastRefresh + c.interval * 1000 - now) / 1000));
        await chrome.action.setBadgeText({ tabId, text: badgeText(remaining) });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: '#34a853' });
      } else {
        await chrome.action.setBadgeText({ tabId, text: '' });
      }
    } catch (e) { /* la pestaña pudo cerrarse entre medias */ }
  }
  /* Fallback global vacío: las pestañas sin config no muestran nada */
  try {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#9aa0a6' });
  } catch (e) { /* noop */ }
}

/* ── Aplicar cambios desde el popup ── */
async function upsert(tabId, { url, title, interval, active }) {
  const configs = await load();
  const prev = configs[tabId];
  const lastRefresh = (prev && prev.lastRefresh) || Date.now();
  configs[tabId] = { url, title, interval, active, lastRefresh };
  ensureAlarm(configs, tabId);
  await persist(configs);
  await setTabIcon(tabId, active);
  await setAutoDiscardable(tabId, !active);
  await updateBadge();
}

async function removeConfig(tabId) {
  const configs = await load();
  if (!configs[tabId]) return;
  delete configs[tabId];
  chrome.alarms.clear(alarmName(tabId));
  await persist(configs);
  await setTabIcon(tabId, false);
  await clearTabBadge(tabId);
  await setAutoDiscardable(tabId, true);
  await updateBadge();
}

async function clearAll() {
  const configs = await load();
  const resets = [];
  for (const id of Object.keys(configs)) {
    chrome.alarms.clear(alarmName(id));
    resets.push(setTabIcon(parseInt(id), false));
    resets.push(clearTabBadge(parseInt(id)));
    if (configs[id].active) resets.push(setAutoDiscardable(parseInt(id), true));
  }
  await Promise.allSettled(resets);
  await persist({});
  await updateBadge();
}

/* ── Alarmas ── */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) {
    updateBadge();
  } else if (alarm.name.startsWith('reload-')) {
    refreshTab(parseInt(alarm.name.slice('reload-'.length)));
  }
});

/* ── Pestaña cerrada → eliminar su config ── */
chrome.tabs.onRemoved.addListener((tabId) => {
  removeConfig(tabId);
});

/* ── Pestaña navegada a otra URL → mantener la config sincronizada, para que
   el emparejamiento por URL de reconcile() no vincule mal tras un reinicio ── */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const configs = await load();
  const c = configs[tabId];
  if (!c) return;
  c.url = changeInfo.url;
  await persist(configs);
});

/* ── Atajo Alt+R: alterna refresco de la pestaña actual ── */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-refresh') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) toggleTabRefresh(tab.id);
    });
  }
});

/* ── Menú contextual: Auto-refrescar ▸ 30s · 1m · 5m · 10m · Apagar ── */
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'autorefresh-parent',
      title: 'Auto-refrescar',
      contexts: ['page', 'tab'],
    });
    [30, 60, 300, 600].forEach((sec) => {
      chrome.contextMenus.create({
        id: `autorefresh-${sec}`,
        parentId: 'autorefresh-parent',
        title: sec < 60 ? `${sec}s` : `${sec / 60}m`,
        contexts: ['page', 'tab'],
      });
    });
    chrome.contextMenus.create({
      id: 'autorefresh-off',
      parentId: 'autorefresh-parent',
      title: 'Apagar',
      contexts: ['page', 'tab'],
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !isUsableUrl(tab.url)) return;
  if (info.menuItemId === 'autorefresh-off') {
    pauseTabRefresh(tab.id);
  } else if (String(info.menuItemId).startsWith('autorefresh-')) {
    const sec = parseInt(String(info.menuItemId).split('-')[1], 10);
    if (!Number.isNaN(sec)) {
      upsert(tab.id, { url: tab.url, title: tab.title, interval: sec, active: true });
    }
  }
});

/* ── Mensajes del popup ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === 'upsert') {
      await upsert(msg.tabId, msg.config);
      sendResponse({ ok: true });
    } else if (msg.action === 'remove') {
      await removeConfig(msg.tabId);
      sendResponse({ ok: true });
    } else if (msg.action === 'get') {
      const [cfg, extra] = await Promise.all([
        load(),
        chrome.storage.local.get(['pausedUntil', 'stats']),
      ]);
      sendResponse({ configs: cfg, pausedUntil: extra.pausedUntil || 0, stats: extra.stats || { total: 0 } });
    } else if (msg.action === 'set-pause') {
      if (msg.until && msg.until > Date.now()) {
        await chrome.storage.local.set({ pausedUntil: msg.until });
      } else {
        await chrome.storage.local.remove('pausedUntil');
      }
      await updateBadge();
      sendResponse({ ok: true });
    } else if (msg.action === 'clear-all') {
      await clearAll();
      sendResponse({ ok: true });
    } else if (msg.action === 'refresh-now') {
      await refreshNow(msg.tabId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

/* ── Reconciliación al arrancar: recuperar config vigente ── */
async function reconcile() {
  const configs = await load();
  const tabs = await chrome.tabs.query({});
  const openIds = new Set(tabs.map(t => t.id));
  const byUrl = new Map();
  for (const t of tabs) {
    if (t.url && !byUrl.has(t.url)) byUrl.set(t.url, t.id);
  }

  const next = {};
  const usedIds = new Set();
  for (const [idStr, c] of Object.entries(configs)) {
    const id = parseInt(idStr);
    let newId = id;
    if (!openIds.has(id)) {
      const match = byUrl.get(c.url);
      if (match === undefined || usedIds.has(match)) continue;
      newId = match;
    }
    if (usedIds.has(newId)) continue;
    usedIds.add(newId);
    if (!c.lastRefresh) c.lastRefresh = Date.now();
    next[newId] = c;
  }

  for (const id of Object.keys(next)) ensureAlarm(next, parseInt(id));
  chrome.alarms.getAll().then(all => {
    for (const a of all) {
      if (a.name.startsWith('reload-')) {
        const id = parseInt(a.name.slice('reload-'.length));
        if (!next[id]) chrome.alarms.clear(a.name);
      }
    }
  });
  await persist(next);

  /* Reaplicar icono por-pestaña y autoDiscardable a los tabId nuevos:
     ambos son estado de la pestaña real del navegador, no de storage,
     así que no sobreviven a un reinicio de Chrome aunque la config sí. */
  for (const [idStr, c] of Object.entries(next)) {
    const id = parseInt(idStr);
    await setTabIcon(id, c.active);
    if (c.active) await setAutoDiscardable(id, false);
  }

  await updateBadge();
}

chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);

/* Badge ticker para mantener la cuenta atrás viva */
chrome.alarms.create(TICK, { periodInMinutes: 0.5 });