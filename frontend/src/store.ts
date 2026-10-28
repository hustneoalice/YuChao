/* 全局状态：用户/主题/外观/功能卡开关 —— localStorage 持久化 + pub/sub */
import type { UserPublic } from "./api";

export type CardMode = "simple" | "detailed";
export interface CardPref { on: boolean; mode: CardMode; order: number }
export type CardPrefs = Record<string, CardPref>;

export const CARD_DEFS = [
  { id: "info", name: "基本信息", icon: "info", desc: "名称代码 / 最新价 / 行业概念 / 换手 / 市值 / PE / PB / 总股本（策影同款卡；daily_valuation 缺失时实时源兜底）。" },
  { id: "signals", name: "信号面板", icon: "lightning", desc: "六分段位置判定与操作提示，VIP 因子明细（趋势/位置）由服务端计算。" },
  { id: "moneyflow", name: "资金流", icon: "trend-up", desc: "超大 / 大 / 中 / 小单当日净流入结构与主力净额五日迷你走势。" },
  { id: "indicators", name: "技术指标", icon: "chart-line-up", desc: "MA / BOLL / RSI / KDJ 关键读数与 MA20 背离状态（开源口径）。" },
  { id: "valuation", name: "估值", icon: "database", desc: "PE-TTM / PB / PS-TTM 与总市值、流通市值（daily_valuation 最新行）。" },
  { id: "corepick", name: "核心标档案", icon: "target", desc: "该标的在追涨 / 低吸池中的档案与资金分（名单公开）。" },
] as const;

export interface AppState {
  user: UserPublic | null;
  theme: "dark" | "light";
  dir: "cn" | "intl";
  accent: "amber" | "teal" | "indigo" | "rose";
  cards: CardPrefs;
  watchlist: { symbol: string; name: string; group: string; ts: number }[];
  wlGroup: string;
}

const LS = {
  user: "yc_user", theme: "yc_theme", dir: "yc_dir", accent: "yc_accent",
  cards: "yc_cards", watchlist: "yc_watchlist",
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw) as T;
  } catch { return fallback; }
}

function loadCards(): CardPrefs {
  const raw = load<Record<string, Partial<CardPref>>>(LS.cards, {});
  const prefs: CardPrefs = {};
  CARD_DEFS.forEach((c, i) => {
    const r = raw[c.id] ?? {};
    prefs[c.id] = { on: r.on ?? true, mode: r.mode === "detailed" ? "detailed" : "simple", order: r.order ?? i };
  });
  return prefs;
}

const state: AppState = {
  user: load<UserPublic | null>(LS.user, null),
  theme: load<"dark" | "light">(LS.theme, "dark"),
  dir: load<"cn" | "intl">(LS.dir, "cn"),
  accent: load<AppState["accent"]>(LS.accent, "amber"),
  cards: loadCards(),
  watchlist: load<AppState["watchlist"]>(LS.watchlist, []),
  wlGroup: "",
};

type Listener = () => void;
const subs = new Set<Listener>();

/** 触发全局重渲染订阅者 */
export function emit(): void {
  subs.forEach((fn) => fn());
}
export function subscribe(fn: Listener): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getState(): Readonly<AppState> {
  return state;
}

export function setUser(u: UserPublic | null): void {
  state.user = u;
  if (u) localStorage.setItem(LS.user, JSON.stringify(u));
  else localStorage.removeItem(LS.user);
  emit();
}

export function patch<K extends "theme" | "dir" | "accent">(k: K, v: AppState[K]): void {
  state[k] = v as never;
  localStorage.setItem(LS[k], JSON.stringify(v));
  emit();
}

export function setCardPref(id: string, p: Partial<CardPref>): void {
  state.cards[id] = { ...state.cards[id], ...p };
  localStorage.setItem(LS.cards, JSON.stringify(state.cards));
  emit();
}
export function resetCards(): void {
  localStorage.removeItem(LS.cards);
  state.cards = loadCards();
  emit();
}

/* ── 自选（localStorage 客户端实现，F04 后端就绪后切换） ── */
export function isWatched(symbol: string): boolean {
  return state.watchlist.some((w) => w.symbol === symbol);
}
export function addWatch(symbol: string, name: string, group = "默认"): boolean {
  if (isWatched(symbol)) return false;
  state.watchlist.unshift({ symbol, name: name || symbol, group, ts: Date.now() });
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  emit();
  return true;
}
export function removeWatch(symbol: string): void {
  state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  emit();
}
export function moveWatchGroup(symbol: string, group: string): void {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  if (w) { w.group = group; localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist)); emit(); }
}
export function setWlGroup(g: string): void {
  state.wlGroup = g;
  emit();
}

/* ── 外观应用 ── */
export function applyAppearance(): void {
  const h = document.documentElement;
  h.dataset.theme = state.theme;
  h.dataset.dir = state.dir;
  h.dataset.accent = state.accent;
}

/** isVIP：以 /auth/me 实时 tier 为准 */
export function isVip(): boolean {
  return state.user?.tier === "pro";
}
