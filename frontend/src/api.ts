/* API 客户端：fetch 封装 + JWT 存取 + 统一错误规约 {code,message,detail} */

const BASE = "/api/v1";
export const API_BASE = BASE;
const TOKEN_KEY = "yc_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  code: string;
  status: number;
  detail: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface ReqOpts {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

async function req<T>(path: string, init?: ReqOpts): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = init?.body;
  if (body != null && typeof body !== "string") {
    body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, { method: init?.method, body: body as BodyInit | null | undefined, headers, signal: init?.signal });
  if (!res.ok) {
    let code = "http_error", message = res.statusText || `HTTP ${res.status}`, detail: unknown = null;
    try {
      const j = await res.json();
      if (typeof j.code === "string") code = j.code;
      if (typeof j.message === "string") message = j.message;
      detail = j.detail ?? null;
    } catch { /* 非 JSON 错误体 */ }
    // 401 会话过期（登录/注册接口本身除外）：清令牌并广播，auth.ts 弹登录
    if (res.status === 401 && !path.startsWith("/auth/")) {
      setToken(null);
      window.dispatchEvent(new CustomEvent("yc:auth-expired"));
    }
    throw new ApiError(res.status, code, message, detail);
  }
  if (init?.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ── auth ── */
export interface UserPublic {
  id: string; email: string; username?: string | null;
  tier: "free" | "pro"; role: string; pro_expires_at?: string | null; created_at?: string | null;
}
export interface TokenPair { token: string; user: UserPublic }

export const authApi = {
  register: (p: { email: string; password: string; username?: string }) =>
    req<TokenPair>("/auth/register", { method: "POST", body: p }),
  login: (p: { identifier: string; password: string; remember?: boolean }) =>
    req<TokenPair>("/auth/login", { method: "POST", body: p }),
  me: () => req<UserPublic>("/auth/me"),
};

/* ── F04 · 按用户设置云同步 ── */
export interface WatchItem { symbol: string; name: string; group: string; ts?: string | null }
export interface CardItem { card_id: string; enabled: boolean; sort: number; mode: string }
export const meApi = {
  prefs: () => req<{ prefs: Record<string, unknown> }>("/me/prefs"),
  putPrefs: (prefs: Record<string, unknown>) =>
    req<{ prefs: Record<string, unknown> }>("/me/prefs", { method: "PUT", body: { prefs } }),
  watchlist: () => req<{ items: WatchItem[] }>("/me/watchlist"),
  putWatchlist: (items: WatchItem[]) =>
    req<{ items: WatchItem[] }>("/me/watchlist", { method: "PUT", body: { items } }),
  cards: () => req<{ items: CardItem[] }>("/me/cards"),
  putCards: (items: CardItem[]) =>
    req<{ items: CardItem[] }>("/me/cards", { method: "PUT", body: { items } }),
  /* F11 · 大模型 BYOK（key 永不回显，仅 key_set 布尔） */
  llm: () => req<LlmCfg>("/me/llm"),
  putLlm: (p: { base_url?: string; api_key?: string; model?: string; enabled?: boolean }) =>
    req<LlmCfg>("/me/llm", { method: "PUT", body: p }),
  testLlm: () => req<TestResult>("/me/llm/test", { method: "POST", body: {} }),
  /* F10 · 飞书推送（webhook/secret 永不回显） */
  feishu: () => req<FeishuCfg>("/me/feishu"),
  putFeishu: (p: { webhook_url?: string; secret?: string; enabled?: boolean }) =>
    req<FeishuCfg>("/me/feishu", { method: "PUT", body: p }),
  testFeishu: () => req<TestResult>("/me/feishu/test", { method: "POST", body: {} }),
};

export interface LlmCfg { base_url: string; model: string; enabled: boolean; key_set: boolean }
export interface FeishuCfg { enabled: boolean; webhook_set: boolean; has_secret: boolean }
export interface TestResult { ok: boolean; message: string }

/* ── market ── */
export interface Bar {
  date: string; open: number; high: number; low: number; close: number;
  volume?: number | null; amount?: number | null; pct_chg?: number | null;
  turnover_rate?: number | null; indicators?: Record<string, number | null> | null;
}
export interface Kline { symbol: string; name?: string; period: string; adjust: string; bars: Bar[] }
export interface Quote {
  symbol: string; name?: string; market?: string; industry?: string; concept?: string; status?: string;
  date?: string; open?: number; high?: number; low?: number; close?: number;
  pct_chg?: number; volume?: number; amount?: number; turnover_rate?: number;
  /* 盘中实时兜底（后端东财 push2 快照，10s 缓存；非盘中/失败时缺省） */
  rt_price?: number; rt_time?: string; rt_prev_close?: number;
  valuation?: { date: string; pe_ttm?: number; pb?: number; ps_ttm?: number; total_mv?: number; circ_mv?: number } | null;
  capital_flow?: { date: string; net_main?: number; net_super?: number; net_large?: number; net_medium?: number; net_small?: number } | null;
}
export interface SearchHit { symbol: string; name?: string; market?: string; industry?: string; status?: string }

export interface IndexQuote {
  symbol: string; name: string; price?: number | null; chg?: number | null;
  pct?: number | null; amount?: number | null;
}
export const marketApi = {
  kline: (q: { symbol: string; adjust?: string; with?: string; limit?: number; start?: string; end?: string; freq?: string }) =>
    req<Kline>(`/market/kline?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`),
  /* 当日分时（价格 + VWAP 均价 + 逐分钟量额，腾讯实时） */
  minute: (symbol: string) =>
    req<{ symbol: string; date: string; prev_close?: number; bars: (Bar & { avg: number; has_avg?: boolean })[] }>(`/market/minute?symbol=${encodeURIComponent(symbol)}`),
  quote: (symbol: string) => req<Quote>(`/market/quote?symbol=${encodeURIComponent(symbol)}`),
  /* 批量快照（自选股卡片：N 只一次渲染，一次腾讯实时 HTTP；≤50 只） */
  quotes: (symbols: string[]) =>
    req<{ items: Quote[]; missing: string[] }>(`/market/quotes?symbols=${encodeURIComponent(symbols.join(","))}`),
  sparks: (symbols: string[]) =>
    req<{ items: { symbol: string; prev_close: number | null; points: number[] }[]; missing: string[] }>(`/market/sparks?symbols=${encodeURIComponent(symbols.join(","))}`),
  search: (q: string, limit = 10) => req<{ items: SearchHit[]; total: number }>(`/market/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  indices: () => req<{ items: IndexQuote[]; total_amount?: number }>("/market/indices"),
  /* 实时资讯/研报（后端东财直连 + TTL 缓存，失败降级空列表） */
  news: (symbol: string, limit = 12) => req<{ items: NewsItem[] }>(`/market/news?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
  reports: (symbol: string, limit = 12) => req<{ items: ReportItem[] }>(`/market/reports?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
  industryReports: (symbol: string, limit = 12) =>
    req<{ industry: string; items: ReportItem[]; skipped?: boolean }>(`/market/industry-reports?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
};

export interface NewsItem { time: string; source: string; title: string; summary: string; url: string; }
export interface ReportItem { date: string; org: string; rating: string; title: string; industry: string; url: string; }

/* ── sectors ── */
export interface SectorSummary {
  id: string; name: string; type: string; trade_date: string;
  close?: number; pct_change?: number; up_count?: number; down_count?: number;
  leader?: string; leader_change?: number;
  member_count?: number; main_net_today?: number | null; main_net_5d?: number | null;
}
export interface SectorMember {
  symbol: string; name?: string; last_date?: string; last_close?: number;
  lookback_pct?: number; main_net?: number;
}
export const sectorsApi = {
  list: (type: string, limit = 200) => req<SectorSummary[]>(`/sectors?type=${type}&limit=${limit}`),
  members: (id: string, lookback: 5 | 10 | 20) =>
    req<SectorMember[]>(`/sectors/${encodeURIComponent(id)}/members?lookback=${lookback}`),
};

/* ── corepicks ── */
export interface Corepick {
  date: string; pool: "chase" | "dip"; sector?: string; symbol: string; name?: string;
  rank?: number; fund_score?: number; seg?: string;
  factors?: Record<string, unknown> | null;
}
export const corepicksApi = {
  list: (date?: string, pool?: string) => {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (pool) p.set("pool", pool);
    return req<Corepick[]>(`/corepicks?${p}`);
  },
  factors: (symbol: string, date?: string, pool: string = "chase") => {
    const p = new URLSearchParams({ pool });
    if (date) p.set("date", date);
    return req<Corepick>(`/corepicks/${encodeURIComponent(symbol)}/factors?${p}`);
  },
};

/* ── data 底座 ── */
export interface DataStatus {
  stage: "uninitialized" | "initializing" | "ready" | "updating" | "update_failed";
  duckdb_path: string;
  tables: { table: string; rows?: number; latest_date?: string; earliest_date?: string; coverage?: number | null }[];
  generated_at: string;
}
/* P1 体检报告（/data/health）：四维打分 + 分级 + 带修复动作的问题清单 */
export interface HealthReport {
  score: number;
  grade: "healthy" | "warn" | "poor";
  freshness: { score: number; items: { table: string; kind: string; latest?: string | null; expected?: string | null; lag_days: number; score: number; lenient?: boolean }[] };
  coverage: { score: number; items: { table: string; latest?: string | null; coverage?: number | null; score: number }[] };
  gap: { score: number; items: { date: string; symbols: number; missing: boolean; drop: boolean }[] };
  ledger: { score: number; updater_alive: boolean; failed_7d: { kind: string; failed: number }[] };
  issues: { level: string; code: string; kind: string | null; message: string; action?: { kind: string; force: boolean } | null }[];
  selfheal?: { date?: string; kinds?: Record<string, { ok_at?: string; fails?: number; retries?: number; error?: string }> };
  generated_at: string;
  unavailable?: boolean;
  note?: string;
}
export interface RepairResult {
  accepted: boolean;
  submitted: { kind: string; force: boolean; reason: string; request_id?: string; error?: string }[];
  message?: string;
  score?: number;
  note?: string;
}
export interface UpdateLogItem {
  run_id?: string; data_type?: string; status?: string; started_at?: string;
  finished_at?: string; rows?: number; message?: string; [k: string]: unknown;
}
/* 更新编排快照（updater 落盘 update_progress.json，经 /data/update/state 透出） */
export interface UpTaskState {
  id: string; kind: string; label: string; trigger: string; status: string; stage?: string;
  total?: number; done?: number; succeeded?: number; failed?: number; rows?: number;
  percent?: number; elapsed_s?: number | null; message?: string; error?: string;
  queued_at?: string; started_at?: string | null; finished_at?: string | null;
  logs?: { time: string; level: string; message: string }[];
}
export interface UpdateSnapshot {
  saved_at: string | null;
  running: UpTaskState | null;
  queued: UpTaskState[];
  recent: UpTaskState[];
  error?: string;
}
export const dataApi = {
  status: () => req<DataStatus>("/data/status"),
  tasks: () => req<{ items: { kind: string; label: string; description: string }[]; schedule: string; note: string }>("/data/tasks"),
  state: () => req<UpdateSnapshot>("/data/update/state"),
  trigger: (kind: string, force = false) =>
    req<{ accepted: boolean; request_id: string }>("/data/update", { method: "POST", body: { kind, force } }),
  cancel: () =>
    req<{ accepted: boolean; request_id: string }>("/data/update/cancel", { method: "POST", body: {} }),
  updates: (limit = 50) => req<{ items: UpdateLogItem[]; note?: string }>(`/data/updates?limit=${limit}`),
  /* P1 体检评估 + 一键修复 */
  health: () => req<HealthReport>("/data/health"),
  repair: () => req<RepairResult>("/data/repair", { method: "POST", body: {} }),
};

/* ── license ── */
export const licenseApi = {
  redeem: (code: string) =>
    req<{ tier: string; pro_expires_at: string; plan: string; days: number }>("/license/redeem", { method: "POST", body: { code } }),
};
