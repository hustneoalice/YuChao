/* 全局状态：用户/主题/外观/功能卡开关 —— localStorage 持久化 + pub/sub */
import type { UserPublic } from "./api";

export type CardMode = "simple" | "detailed";
export interface CardPref { on: boolean; mode: CardMode; order: number }
export type CardPrefs = Record<string, CardPref>;

export type RightTabId = "market" | "chips" | "depth" | "holder";
/** 右侧抽屉的栏目：一个 tab 下可放多张卡片（CARD_DEFS.tab），后续可继续加 */
export const RIGHT_TABS = [
  { id: "market", name: "看盘" },
  { id: "chips", name: "筹码" },
  { id: "depth", name: "盘口" },
  { id: "holder", name: "股东" },
] as const;

export const CARD_DEFS = [
  { id: "watch", name: "自选股", icon: "star", tab: "market", desc: "与左侧自选列表同步的实时看板：现价 / 涨跌幅 / 换手 / 成交额一屏速览，点击直达个股。" },
  { id: "signals", name: "信号面板", icon: "lightning", tab: "market", desc: "六分段位置判定与操作提示，VIP 因子明细（趋势/位置）由系统计算。" },
  { id: "trend", name: "趋势", icon: "chart-line", tab: "market", desc: "60分 / 日 / 周 三周期短线趋势：多头红、空头绿，右侧为近 12/24 根趋势柱，附六段位。" },
  { id: "moneyflow", name: "资金流", icon: "trend-up", tab: "market", desc: "超大 / 大 / 中 / 小单当日净流入结构，以及主力净额近五日迷你走势。" },
  { id: "indicators", name: "技术指标", icon: "chart-line-up", tab: "market", desc: "均线 / BOLL / RSI / KDJ 关键读数与背离状态。" },
  { id: "valuation", name: "估值", icon: "database", tab: "market", desc: "市盈率（TTM）/ 市净率 / 市销率，以及总市值、流通市值。" },
  { id: "corepick", name: "核心标档案", icon: "target", tab: "market", desc: "该标的在追涨 / 低吸池中的档案与资金分（名单公开）。" },
  { id: "shareholders", name: "十大流通股东", icon: "user", tab: "holder", desc: "季度持股披露 / 持股数量变化 / 社保基金新进；进入仅表示新进入十大名单。" },
  { id: "chips", name: "筹码分布", icon: "list", tab: "chips", desc: "按日线换手衰减估算价格筹码：获利比例 / 平均成本 / 90% 成本区间 / 集中度，指数不适用。" },
  { id: "orderbook", name: "盘口", icon: "cell-signal-high", tab: "depth", desc: "盘口：名称概念 + 最高/开盘/昨收/振幅/涨跌停/量比/换手/市盈率/市净率/成交额/市值/内外盘 + 买卖五档 + 委比委差，一屏集中。" },
  { id: "trades", name: "成交明细", icon: "list", tab: "depth", desc: "成交明细：逐笔成交时间 / 价格 / 手数 / B·S 方向，主买红、主卖绿，最新在前。" },
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

export interface WatchNote {
  id: string;
  /** YYYY-MM-DD：标注适用日期（可回溯/可改） */
  date: string;
  text: string;
}

export interface WatchEntry {
  symbol: string;
  name: string;
  /** 一只股票可属于多个分组，至少含「默认」 */
  groups: string[];
  ts: number;
  /** 标注（多条）：操作策略 / 提醒，悬停「标注」列可看 */
  notes: WatchNote[];
}

function newNoteId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 今天（本地时区）YYYY-MM-DD */
export function todayYmd(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sanitizeNotes(raw: unknown): WatchNote[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchNote[] = [];
  raw.forEach((n) => {
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    const text = String(o.text ?? "").trim();
    if (!text) return;
    out.push({ id: String(o.id || newNoteId()), date: String(o.date || todayYmd()), text });
  });
  return out;
}

/** 旧数据迁移：group: string → groups: string[]；缺省补 notes 空数组 */
function loadWatchlist(): WatchEntry[] {
  const raw = load<Array<{ symbol: string; name?: string; group?: string; groups?: string[]; ts?: number; notes?: unknown }>>(LS.watchlist, []);
  return raw.filter((w) => w && w.symbol).map((w) => ({
    symbol: w.symbol,
    name: w.name || w.symbol,
    groups: w.groups?.length ? w.groups : [w.group || "默认"],
    ts: w.ts || Date.now(),
    notes: sanitizeNotes(w.notes),
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
    prefs[c.id] = { on: r.on ?? true, mode: r.mode === "detailed" ? "detailed" : "simple", order: r.order ?? (c.id === "shareholders" ? 0.5 : i) };
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
  state.watchlist.unshift({ symbol, name: name || symbol, groups: [group || "默认"], ts: Date.now(), notes: [] });
  saveWatchlist();
  return true;
}
export function removeWatch(symbol: string): void {
  state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol);
  saveWatchlist();
}

/* ── 自选标注（操作策略 / 提醒，多条 · 可改可删） ── */
/** 某只自选的标注，按日期倒序（同日按新增先后） */
export function getWatchNotes(symbol: string): WatchNote[] {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  return w ? w.notes.slice().sort((a, b) => b.date.localeCompare(a.date)) : [];
}

export function addWatchNote(symbol: string, date: string, text: string): boolean {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  const t = text.trim();
  if (!w || !t) return false;
  w.notes.unshift({ id: newNoteId(), date: date || todayYmd(), text: t });
  saveWatchlist();
  return true;
}

export function updateWatchNote(symbol: string, id: string, patch: { date?: string; text?: string }): boolean {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  const n = w?.notes.find((x) => x.id === id);
  if (!n) return false;
  if (patch.date !== undefined) n.date = patch.date || todayYmd();
  if (patch.text !== undefined) {
    const t = patch.text.trim();
    if (!t) return false;                  // 空内容不覆盖
    n.text = t;
  }
  saveWatchlist();
  return true;
}

export function removeWatchNote(symbol: string, id: string): boolean {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  if (!w) return false;
  const before = w.notes.length;
  w.notes = w.notes.filter((n) => n.id !== id);
  if (w.notes.length === before) return false;
  saveWatchlist();
  return true;
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
/** 勾选/取消某个分组（多选）；返回操作后是否仍在该组。
 *  取消最后一个分组 = 整体移出自选（不走 setWatchGroups 的「至少保留默认」回落）。 */
export function toggleWatchGroup(symbol: string, group: string): boolean {
  const w = state.watchlist.find((x) => x.symbol === symbol);
  if (!w) return false;
  if (w.groups.includes(group)) {
    const rest = w.groups.filter((g) => g !== group);
    if (!rest.length) { removeWatch(symbol); return false; }
    w.groups = rest;
    saveWatchlist();
    return false;
  }
  w.groups = [...w.groups, group];
  noteGroups(w.groups);
  saveWatchlist();
  return true;
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
/** 重命名分组：默认分组不可改；同步股票所属分组、当前筛选与注册表 */
export function renameWatchGroup(from: string, to: string): boolean {
  const old = (from || "").trim();
  const name = (to || "").trim();
  if (!old || !name || old === "默认" || name === "默认" || name === old) return false;
  if (allWatchGroups().includes(name)) return false;
  const i = state.watchGroups.indexOf(old);
  if (i >= 0) state.watchGroups[i] = name;
  else state.watchGroups.push(name);
  state.watchlist.forEach((w) => {
    if (!w.groups.includes(old)) return;
    w.groups = Array.from(new Set(w.groups.map((g) => (g === old ? name : g))));
  });
  state.wlGroups = Array.from(new Set(state.wlGroups.map((g) => (g === old ? name : g))));
  localStorage.setItem(LS.watchGroups, JSON.stringify(state.watchGroups));
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  notifyLocal("watchlist");
  emit();
  return true;
}

/** 删除分组：默认分组不可删；组内股票回落到「默认」 */
export function removeWatchGroup(name: string): boolean {
  const g = (name || "").trim();
  if (!g || g === "默认" || !allWatchGroups().includes(g)) return false;
  state.watchGroups = state.watchGroups.filter((x) => x !== g);
  state.watchlist.forEach((w) => {
    if (!w.groups.includes(g)) return;
    const rest = w.groups.filter((x) => x !== g);
    w.groups = rest.length ? rest : ["默认"];
  });
  state.wlGroups = state.wlGroups.filter((x) => x !== g);
  localStorage.setItem(LS.watchGroups, JSON.stringify(state.watchGroups));
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  notifyLocal("watchlist");
  emit();
  return true;
}

/** 云端自选整批装载（applying 抑制回推） */
export function loadWatchlistFrom(items: WatchEntry[]): void {
  state.watchlist = items.map((w) => ({ ...w, notes: sanitizeNotes(w.notes) }));
  localStorage.setItem(LS.watchlist, JSON.stringify(state.watchlist));
  emit();
}
/** 分组筛选：默认单选互斥（点「全部」清空）；
    multi=true（Ctrl/⌘/Shift 或按住 Tab）时支持多选并集 */
export function toggleWlGroup(g: string, multi = false): void {
  if (!g || g === "全部") state.wlGroups = [];
  else if (multi) state.wlGroups = state.wlGroups.includes(g)
    ? state.wlGroups.filter((x) => x !== g)
    : [...state.wlGroups, g];
  else state.wlGroups = [g];
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
