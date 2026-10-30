/* F04 · 云设置同步：登录拉取合并 · 本地变更去抖推送 · 登出冲刷。
 *
 * 合并策略（对齐「服务器为准，本地补缺」）：
 * - prefs：服务器有 → 服务器；服务器缺 → 本地补上并回推（首次登录即上传）
 * - watchlist / cards：服务器非空 → 覆盖本地；服务器为空且本地非空 → 推本地
 * - 推送统一 800ms 去抖；拉取回放期间 store.applying 抑制回推
 */
import { API_BASE, getToken, meApi, type CardItem, type WatchItem } from "./api";
import { setTrendPalette } from "./pages/kline";
import {
  CARD_DEFS, beginApply, endApply, getState,
  loadAppearance, loadCardsFrom, loadWatchlistFrom,
  type CardPrefs,
} from "./store";

type Prefs = Record<string, unknown>;

/* ── 本地偏好收集 / 回放 ── */

function localPrefs(): Prefs {
  const s = getState();
  const j = <T,>(k: string, fb: T): T => {
    try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v) as T; } catch { return fb; }
  };
  return {
    theme: s.theme, dir: s.dir, accent: s.accent,
    k_layout: localStorage.getItem("yc_klayout") || "single",
    k_autoh: localStorage.getItem("yc_autoh") ?? "1",
    trend_palette: localStorage.getItem("yc_trendpal") || "B",
    k_main: j<string[]>("yc_kmain", []),
    k_sub: j<string[]>("yc_ksub", []),
  };
}

function applyPrefs(p: Prefs): void {
  beginApply();
  try {
    const theme = p.theme === "light" ? "light" : p.theme === "dark" ? "dark" : undefined;
    const dir = p.dir === "intl" ? "intl" : p.dir === "cn" ? "cn" : undefined;
    const accent = ["amber", "teal", "indigo", "rose"].includes(p.accent as string)
      ? p.accent as "amber" | "teal" | "indigo" | "rose" : undefined;
    loadAppearance({ theme, dir, accent });
    if (typeof p.k_layout === "string") localStorage.setItem("yc_klayout", p.k_layout);
    if (p.k_autoh === "0" || p.k_autoh === "1") localStorage.setItem("yc_autoh", p.k_autoh);
    if (typeof p.trend_palette === "string") setTrendPalette(p.trend_palette);
    if (Array.isArray(p.k_main)) localStorage.setItem("yc_kmain", JSON.stringify(p.k_main));
    if (Array.isArray(p.k_sub)) localStorage.setItem("yc_ksub", JSON.stringify(p.k_sub));
  } finally {
    endApply();
  }
  // K线区偏好热应用（layout/指标在 boot 时才读 localStorage）
  document.dispatchEvent(new CustomEvent("yc:kprefs"));
}

/* ── 推送（去抖） ── */

const timers: Partial<Record<string, number>> = {};

function pushPrefs(): void {
  void meApi.putPrefs(localPrefs()).catch(() => { /* 离线静默，下次变更再试 */ });
}
function watchlistPayload(): WatchItem[] {
  return getState().watchlist.map((w) => ({
    symbol: w.symbol, name: w.name, group: w.group,
    ts: new Date(w.ts || Date.now()).toISOString(),
  }));
}
function pushWatchlist(): void {
  void meApi.putWatchlist(watchlistPayload()).catch(() => { /* 静默 */ });
}
function cardsPayload(): CardItem[] {
  return Object.entries(getState().cards).map(([card_id, c]) => ({
    card_id, enabled: c.on, sort: c.order, mode: c.mode,
  }));
}
function pushCards(): void {
  void meApi.putCards(cardsPayload()).catch(() => { /* 静默 */ });
}

const PUSH: Record<string, () => void> = {
  prefs: pushPrefs, watchlist: pushWatchlist, cards: pushCards,
};

function queuePush(kind: string): void {
  if (!getToken() || !getState().user) return;
  window.clearTimeout(timers[kind]);
  timers[kind] = window.setTimeout(() => {
    delete timers[kind];
    PUSH[kind]?.();
  }, 800);
}

/** 关页/登出前冲刷未落库的变更：去抖窗口内的变更用 keepalive fetch 立即发送
 *  （普通去抖推送在 800ms 内刷新页面会丢——启动合并是 server-wins，会把本地新值覆盖回旧值） */
export function flushSync(): void {
  const pending = Object.keys(timers);
  pending.forEach((k) => { window.clearTimeout(timers[k]); delete timers[k]; });
  const token = getToken();
  if (!pending.length || !token) return;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const send = (path: string, body: unknown): void => {
    try {
      void fetch(`${API_BASE}${path}`, {
        method: "PUT", headers, body: JSON.stringify(body), keepalive: true,
      }).catch(() => { /* 尽力而为 */ });
    } catch { /* 尽力而为 */ }
  };
  if (pending.includes("prefs")) send("/me/prefs", { prefs: localPrefs() });
  if (pending.includes("watchlist")) send("/me/watchlist", { items: watchlistPayload() });
  if (pending.includes("cards")) send("/me/cards", { items: cardsPayload() });
}

/* ── 拉取（登录后 / 带 token 启动时） ── */

export async function pullOnLogin(): Promise<void> {
  if (!getToken()) return;
  try {
    const [prefsR, wlR, cardsR] = await Promise.all([
      meApi.prefs(), meApi.watchlist(), meApi.cards(),
    ]);
    // prefs：服务器缺失键 → 本地补上（合并后回推一次）
    const local = localPrefs();
    const merged: Prefs = { ...local, ...prefsR.prefs };
    const missing = Object.keys(local).some((k) => !(k in prefsR.prefs));
    applyPrefs(merged);
    if (missing) void meApi.putPrefs(merged).catch(() => { /* 静默 */ });

    // watchlist：服务器空且本地非空 → 推本地；否则服务器覆盖本地
    if (wlR.items.length === 0 && getState().watchlist.length > 0) {
      pushWatchlist();
    } else if (wlR.items.length > 0) {
      beginApply();
      try {
        loadWatchlistFrom(wlR.items.map((i) => ({
          symbol: i.symbol, name: i.name || i.symbol, group: i.group || "默认",
          ts: i.ts ? Date.parse(i.ts) || Date.now() : Date.now(),
        })));
      } finally { endApply(); }
    }

    // cards：同 watchlist 策略
    if (cardsR.items.length === 0 && Object.keys(getState().cards).length > 0) {
      pushCards();
    } else if (cardsR.items.length > 0) {
      const prefs: CardPrefs = {};
      CARD_DEFS.forEach((c, i) => {
        const r = cardsR.items.find((x) => x.card_id === c.id);
        prefs[c.id] = {
          on: r ? r.enabled : true,
          mode: r?.mode === "detailed" ? "detailed" : "simple",
          order: r ? r.sort : i,
        };
      });
      beginApply();
      try { loadCardsFrom(prefs); } finally { endApply(); }
    }
  } catch {
    /* 拉取失败（离线/网络）：保持本地态，不打断使用 */
  }
}

/** boot 接线：本地变更 → 去抖推送；关页/切后台 → 冲刷；带 token 启动 → 静默拉取 */
export function initSync(): void {
  document.addEventListener("yc:local", (e) => queuePush((e as CustomEvent).detail as string));
  window.addEventListener("beforeunload", flushSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSync();
  });
  if (getToken()) void pullOnLogin();
}
