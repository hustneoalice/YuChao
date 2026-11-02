/* 全局状态：用户/主题/外观/功能卡开关 —— localStorage 持久化 + pub/sub */
import type { UserPublic } from "./api";

export type CardMode = "simple" | "detailed";
export interface CardPref { on: boolean; mode: CardMode; order: number }
export type CardPrefs = Record<string, CardPref>;

export const CARD_DEFS = [
  { id: "info", name: "基本信息", icon: "info", desc: "名称代码 / 最新价 / 行业概念 / 换手 / 市值 / 市盈率 / 市净率 / 总股本（没有当日估值数据时按实时行情兜底）。" },
  { id: "watch", name: "自选股", icon: "star", desc: "与左侧自选列表同步的实时看板：现价 / 涨跌幅 / 换手 / 成交额一屏速览，点击直达个股。" },
  { id: "signals", name: "信号面板", icon: "lightning", desc: "六分段位置判定与操作提示，VIP 因子明细（趋势/位置）由系统计算。" },
  { id: "trend", name: "趋势", icon: "chart-line", desc: "短线/中线多空状态（收盘价相对 MA10/MA45 的偏离）与六段位位置条，把颜色条信息收进卡片。" },
  { id: "moneyflow", name: "资金流", icon: "trend-up", desc: "超大 / 大 / 中 / 小单当日净流入结构，以及主力净额近五日迷你走势。" },
  { id: "indicators", name: "技术指标", icon: "chart-line-up", desc: "MA / BOLL / RSI / KDJ 关键读数与 MA20 背离状态。" },
  { id: "valuation", name: "估值", icon: "database", desc: "市盈率（TTM）/ 市净率 / 市销率，以及总市值、流通市值。" },
  { id: "corepick", name: "核心标档案", icon: "target", desc: "该标的在追涨 / 低吸池中的档案与资金分（名单公开）。" },
] as const;

export interface AppState {
  user: UserPublic | null;
  theme: "dark" | "light";
  dir: "cn" | "intl";
  accent: "amber" | "teal" | "indigo" | "rose";
  cards: CardPrefs;
  watchlist: WatchEntry[];
  /** 自选分组注册表（含尚未放股票的空分组），保证「新建分组」不丢 */
  watchGroups: string[];
  /** 分组筛选（多选：空数组 = 全部；否则取并集） */
  wlGroups: string[];
}

export interface WatchEntry {
  symbol: string;
  name: string;
  /** 一只股票可属于多个分组，至少含「默认」 */
  groups: string[];
  ts: number;
}

/** 旧数据迁移：group: string → groups: string[] */
function loadWatchlist(): WatchEntry[] {
  const raw = load<Array<{ symbol: string; name?: string; group?: string; groups?: string[]; ts?: number }>>(LS.watchlist, []);
  return raw.filter((w) => w && w.symbol).map((w) => ({
    symbol: w.symbol,
    name: w.name || w.symbol,
    groups: w.groups?.length ? w.groups : [w.group || "默认"],
    ts: w.ts || Date.now(),
  }));
}

const LS = {
  user: "yc_user", theme: "yc_theme", dir: "yc_dir", accent: "yc_accent",
  cards: "yc_cards", watchlist: "yc_watchlist", watchGroups: "yc_watch_groups",
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
  watchlist: loadWatchlist(),
  watchGroups: load<string[]>(LS.watchGroups, []),
  wlGroups: [],
};

type Listener = () => void;
const subs = new Set<Listener>();

/* 本地变更 → 云同步事件（sync.ts 监听去抖推送）；applying 期间（拉取回放）不回推 */
export type LocalKind = "prefs" | "watchlist" | "cards";
let applying = false;
export function isApplying(): boolean { return applying; }
export function beginApply(): void { applying = true; }
export function endApply(): void { applying = false; }
export function notifyLocal(kind: LocalKind): void {
  if (!applying) document.dispatchEvent(new CustomEvent("yc:local", { detail: kind }));
}

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
  notifyLocal("prefs");
  emit();
}

export function setCardPref(id: string, p: Partial<CardPref>): void {
  state.cards[id] = { ...state.cards[id], ...p };
  localStorage.setItem(LS.cards, JSON.stringify(state.cards));
  notifyLocal("cards");
  emit();
}
export function resetCards(): void {
  localStorage.removeItem(LS.cards);
  state.cards = loadCards();
  notifyLocal("cards");
  emit();
}

/* 云端数据回放（sync.ts 拉取后整批装载；applying 抑制回推） */
export function loadAppearance(v: { theme?: "dark" | "light"; dir?: "cn" | "intl"; accent?: AppState["accent"] }): void {
  if (v.theme) { state.theme = v.theme; localStorage.setItem(LS.theme, JSON.stringify(v.theme)); }
  if (v.dir) { state.dir = v.dir; localStorage.setItem(LS.dir, JSON.stringify(v.dir)); }
  if (v.accent) { state.accent = v.accent; localStorage.setItem(LS.accent, JSON.stringify(v.accent)); }
  applyAppearance();
  emit();
}
export function loadCardsFrom(prefs: CardPrefs): void {
  state.cards = prefs;
  localStorage.setItem(LS.cards, JSON.stringify(state.cards));
  emit();
}

/* ── 自选（F04：本地即时生效 + sync.ts 云同步） ── */
export function isWatched(symbol: string): boolean {
  return state.watchlist.some((w) => w.symbol === symbol);
}
export function addWatch(symbol: string, name: string, group = "默认"): boolean {
  if (isWatched(symbol)) return false;
  noteGroups([group]);
  state.watchlist.unshift({ symbol, name: name || symbol, groups: [group || "默认"], ts: Date.now() });
  saveWatchlist();
  return true;
}
export function removeWatch(symbol: string): void {
  state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
  saveWatchlist();
}
/** 整组覆盖（多选）：空数组自动回落「默认」，保证一只股票至少有一个组 */
export function setWatchGroups(symbol: string, groups: string[]): void {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  if (!w) return;
  const gs = Array.from(new Set(groups.map((g) => (g || "").trim()).filter(Boolean)));
  w.groups = gs.length ? gs : ["默认"];
  noteGroups(w.groups);
  saveWatchlist();
}
/** 勾选/取消某个分组（多选）；返回操作后是否仍在该组 */
export function toggleWatchGroup(symbol: string, group: string): boolean {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  if (!w) return false;
  const has = w.groups.includes(group);
  setWatchGroups(symbol, has ? w.groups.filter((g) => g !== group) : [...w.groups, group]);
  return !has;
}
/** 旧口径兼容：仅保留一个分组 */
export function moveWatchGroup(symbol: string, group: string): void {
  setWatchGroups(symbol, [group]);
}

function saveWatchlist(): void {
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  notifyLocal("watchlist");
  emit();
}

/** 分组名登记：自定义分组写进注册表，避免「空分组」因移出股票而消失 */
function noteGroups(names: string[]): void {
  let changed = false;
  names.forEach((g) => {
    const name = (g || "").trim();
    if (!name || name === "默认" || state.watchGroups.includes(name)) return;
    state.watchGroups.push(name);
    changed = true;
  });
  if (changed) localStorage.setItem(LS.watchGroups, JSON.stringify(state.watchGroups));
}

/** 全部分组名：默认在前 → 注册表顺序 → 再补 watchlist 里实际用到的 */
export function allWatchGroups(): string[] {
  const set = new Set<string>(["默认"]);
  state.watchGroups.forEach((g) => { if (g && g.trim()) set.add(g.trim()); });
  state.watchlist.forEach((w) => w.groups.forEach((g) => set.add(g || "默认")));
  return Array.from(set);
}

/** 新建空分组（持久化到 yc_watch_groups，收藏面板/自选页都能立刻看到） */
export function addWatchGroup(name: string): boolean {
  const g = name.trim();
  if (!g || allWatchGroups().includes(g)) return false;
  state.watchGroups.push(g);
  localStorage.setItem(LS.watchGroups, JSON.stringify(state.watchGroups));
  emit();
  return true;
}
/** 云端自选整批装载（applying 抑制回推） */
export function loadWatchlistFrom(items: WatchEntry[]): void {
  state.watchlist = items;
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  emit();
}
/** 分组筛选（多选）：空 = 全部；点「全部」清空；点某组则加入/移出 */
export function toggleWlGroup(g: string): void {
  if (g === "全部") state.wlGroups = [];
  else state.wlGroups = state.wlGroups.includes(g)
    ? state.wlGroups.filter((x) => x !== g)
    : [...state.wlGroups, g];
  emit();
}
export function setWlGroups(gs: string[]): void {
  state.wlGroups = gs.includes("全部") ? [] : gs;
  emit();
}
/** 股票是否命中当前分组筛选（多选取并集） */
export function inWlFilter(w: WatchEntry): boolean {
  return state.wlGroups.length === 0 || w.groups.some((g) => state.wlGroups.includes(g));
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
