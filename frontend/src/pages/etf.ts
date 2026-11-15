/* ETF 涨跌逻辑：33 只宽基/红利 ETF · 10% 有效波段量化。
 * 口径与行情页右列「涨跌统计」卡一致（src/updown-stats.ts）：
 *   - 拐点取日内最高 / 最低价，上一段终点 = 下一段起点；
 *   - 涨 >10% 才算一段有效上涨；随后回撤不足 10% 不否定原上涨逻辑；
 *   - 8%~10% 的反向波动是「无效线段」，页面上标为「10% 内不否定」。
 * 数据由 /api/v1/etf/updown 提供（日线 hfq，7 只无复权序列的退回裸价）。 */
import { API_BASE, getToken } from "../api";
import { esc, fmt, fmtP } from "../fmt";
import { createDataTable, type DataTable } from "../table";

interface EtfRun {
  dir: 1 | -1;
  anchor_date: string; anchor_price: number;
  ext_date: string; ext_price: number;
  cur_pct: number; ext_pct: number; against_pct: number;
  confirmed: boolean; thresh: number;
}
interface EtfExtreme {
  pct: number; from_date: string; to_date: string;
  from_price: number; to_price: number;
}
interface EtfRow {
  code: string; name: string; full_name: string; group: string;
  price: number | null; chg: number | null; chg_pct: number | null;
  data_from: string | null; data_to: string | null; bars: number;
  adj: "hfq" | "raw" | "none";
  upN: number; downN: number; upPct: number; upAvg: number; downAvg: number;
  maxUp: EtfExtreme | null; maxDn: EtfExtreme | null;
  lastSeg: { dir: 1 | -1; pct: number; from_date: string; to_date: string } | null;
  run: EtfRun | null;
  missing?: boolean;
}
interface EtfSummary {
  total: number; covered: number; missing: number; live: number;
  logicUp: number; logicDown: number; undecided: number;
  todayUp: number; todayDown: number; todayFlat: number; todayAvg: number;
  validNow: number;
}
interface EtfGroup {
  key: string; label: string; count: number; summary: EtfSummary;
}
interface EtfPayload {
  as_of: string | null; built_at: string;
  items: EtfRow[]; groups: EtfGroup[]; summary: EtfSummary;
  stale: boolean; message?: string;
}

let table: DataTable<EtfRow>;
let allRows: EtfRow[] = [];
let groupsMeta: EtfGroup[] = [];
let group = "rice";
let controller: AbortController | null = null;
let initialized = false;
const el = (id: string) => document.getElementById(`etf-${id}`)!;
const ADJ_LABEL: Record<string, string> = { hfq: "后复权", raw: "不复权", none: "无数据" };

const pct = (v: number | null | undefined): string =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v)}%`;
const chgPct = (v: number | null | undefined): string =>
  v == null ? "—" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${fmt(v)}%</span>`;
const dirPct = (v: number | null | undefined): string =>
  v == null ? "—" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${fmt(v)}%</span>`;

function logicBadge(r: EtfRow): string {
  if (r.missing) return `<span class="etf-badge none">无数据</span>`;
  const run = r.run;
  if (!run) return `<span class="etf-badge wait">待定</span><span class="muted">尚未走出 10% 波段</span>`;
  const cls = run.dir === 1 ? "up" : "down";
  const text = run.dir === 1 ? "上涨逻辑" : "下跌逻辑";
  return `<span class="etf-badge ${cls}">${text}</span>` +
    `<span class="muted">${run.confirmed ? `已确认 ${pct(run.ext_pct)}` : `未满 10%（${pct(run.ext_pct)}）`}</span>`;
}

function runCell(r: EtfRow, key: "ext_pct" | "cur_pct"): string {
  const run = r.run;
  if (!run) return "—";
  return dirPct(run[key]);
}

function againstCell(r: EtfRow): string {
  const run = r.run;
  if (!run) return "—";
  const keep = run.against_pct < run.thresh;
  return dirPct(run.against_pct) +
    (keep ? `<span class="muted etf-keep" title="反向波动未超过 10%，原有${run.dir === 1 ? "上涨" : "下跌"}逻辑继续有效">10% 内 · 不否定</span>`
      : `<span class="muted">已超阈值</span>`);
}

function extremeCell(e: EtfExtreme | null): string {
  if (!e) return "—";
  return `<b class="${e.pct > 0 ? "up" : "down"}">${pct(e.pct)}</b>` +
    `<span class="muted">${esc(e.from_date)}→${esc(e.to_date)}</span>`;
}

function dataCell(r: EtfRow): string {
  if (!r.data_from) return "—";
  return `${esc(r.data_from)} 起<span class="muted">${r.bars} 根 · ${ADJ_LABEL[r.adj] ?? r.adj}</span>`;
}

const groupRows = (list: EtfRow[]): EtfRow[] =>
  list.filter((r) => (r.group ?? "rice") === group);

const paint = (): void => table.render(table.sort(groupRows(allRows)));

/** 当前分组汇总（口径与后端 _summary 一致）。 */
function summarize(list: EtfRow[]): EtfSummary {
  const have = list.filter((i) => !i.missing);
  const live = have.filter((i) => i.run);
  const up = live.filter((i) => i.run!.dir === 1);
  const down = live.filter((i) => i.run!.dir === -1);
  const todayUp = have.filter((i) => (i.chg_pct ?? 0) > 0);
  const todayDown = have.filter((i) => (i.chg_pct ?? 0) < 0);
  const rated = have.filter((i) => i.chg_pct != null);
  const avg = rated.length ? rated.reduce((a, i) => a + (i.chg_pct ?? 0), 0) / rated.length : 0;
  return {
    total: list.length, covered: have.length, missing: list.length - have.length,
    live: live.length, logicUp: up.length, logicDown: down.length,
    undecided: have.length - live.length,
    todayUp: todayUp.length, todayDown: todayDown.length,
    todayFlat: have.length - todayUp.length - todayDown.length,
    todayAvg: Math.round(avg * 100) / 100,
    validNow: live.filter((i) => i.run!.confirmed).length,
  };
}

function renderTabs(groups?: EtfGroup[]): void {
  if (groups) groupsMeta = groups;
  const bar = el("tabs");
  if (!groupsMeta.length) return;
  bar.innerHTML = groupsMeta.map((g) =>
    `<button class="etf-tab${g.key === group ? " on" : ""}" data-group="${esc(g.key)}" ` +
    `role="tab" aria-selected="${g.key === group}">${esc(g.label)} <em>${g.count}</em></button>`
  ).join("");
}

function switchGroup(key: string): void {
  if (key === group) return;
  group = key;
  renderTabs();
  paint();
  renderQuant(groupRows(allRows));
  updateStatus();
}

function updateStatus(): void {
  const s = summarize(groupRows(allRows));
  el("status").textContent = `数据截至 ${lastAsOf || "—"}` +
    (lastStale ? "（行情源暂不可用，显示上次结果）" : "") +
    ` · 覆盖 ${s.covered}/${s.total} 只` +
    (s.missing ? ` · 缺数据 ${s.missing} 只` : "");
  el("status").style.color = lastStale ? "var(--warn)" : "";
}

let lastAsOf: string | null = null;
let lastStale = false;

export async function loadEtfUpdown(refresh = false): Promise<void> {
  if (!initialized) initEtfUpdown();
  controller?.abort();
  const request = new AbortController();
  controller = request;
  el("status").textContent = refresh
    ? "正在重取全部 ETF 日线与实时报价…"
    : "正在读取 ETF 日线与波段统计…";
  el("status").style.color = "";
  el("wrap").setAttribute("aria-busy", "true");
  try {
    const token = getToken();
    const response = await fetch(`${API_BASE}/etf/updown${refresh ? "?refresh=1" : ""}`, {
      signal: request.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.detail === "string" ? error.detail : `读取失败（${response.status}）`);
    }
    const result: EtfPayload = await response.json();
    if (request !== controller) return;
    allRows = result.items;
    lastAsOf = result.as_of;
    lastStale = result.stale;
    renderTabs(result.groups);
    paint();
    renderQuant(groupRows(allRows));
    updateStatus();
    const hfq = allRows.filter((i) => i.adj === "hfq").length;
    const raw = allRows.filter((i) => i.adj === "raw").length;
    el("meta").textContent =
      `口径：10% 有效波段（与行情页「涨跌统计」卡一致）· 8%~10% 反向波动仅记灰线、不否定原趋势 · ` +
      `后复权 ${hfq} 只 / 不复权 ${raw} 只 · 报价缓存 60 秒 / 日线 6 小时 · ` +
      `构建于 ${result.built_at.replace("T", " ")}`;
  } catch (error) {
    if (request.signal.aborted) return;
    el("status").textContent = `加载失败：${error instanceof Error ? error.message : "请重试"}`;
    el("status").style.color = "var(--warn)";
  } finally {
    if (request === controller) el("wrap").setAttribute("aria-busy", "false");
  }
}

function renderQuant(list: EtfRow[]): void {
  const s = summarize(list);
  const covered = list.filter((i) => !i.missing);
  const byChg = covered.filter((i) => i.chg_pct != null);
  const leaders = [...byChg].sort((a, b) => (b.chg_pct ?? 0) - (a.chg_pct ?? 0));
  const topUp = [...covered].filter((i) => i.maxUp)
    .sort((a, b) => (b.maxUp?.pct ?? 0) - (a.maxUp?.pct ?? 0)).slice(0, 6);
  const topDn = [...covered].filter((i) => i.maxDn)
    .sort((a, b) => (a.maxDn?.pct ?? 0) - (b.maxDn?.pct ?? 0)).slice(0, 6);
  const logicTotal = Math.max(1, s.logicUp + s.logicDown);
  const upW = Math.round((s.logicUp / logicTotal) * 100);

  const leaderRow = (r: EtfRow): string =>
    `<li><span class="etf-tc">${esc(r.code)}</span><span class="etf-tn">${esc(r.name)}</span>` +
    `<b class="${(r.chg_pct ?? 0) >= 0 ? "up" : "down"}">${pct(r.chg_pct)}</b></li>`;
  const extremeRow = (r: EtfRow, e: EtfExtreme | null): string =>
    e ? `<li><span class="etf-tc">${esc(r.code)}</span><span class="etf-tn">${esc(r.name)}</span>` +
      `<b class="${e.pct > 0 ? "up" : "down"}">${pct(e.pct)}</b>` +
      `<i>${esc(e.from_date.slice(2))}→${esc(e.to_date.slice(2))}</i></li>` : "";

  el("quant").innerHTML =
    `<div class="etf-qcard">
      <div class="etf-qh"><b>当前逻辑分布</b><span>共 ${s.covered} 只</span></div>
      <div class="etf-kpi">
        <div><b class="up">${s.logicUp}</b><span>上涨逻辑</span></div>
        <div><b class="down">${s.logicDown}</b><span>下跌逻辑</span></div>
        <div><b>${s.undecided}</b><span>待定</span></div>
      </div>
      <div class="etf-split" title="上涨逻辑 ${s.logicUp} 只 / 下跌逻辑 ${s.logicDown} 只">
        <i class="up" style="width:${upW}%"></i><i class="down" style="width:${100 - upW}%"></i>
      </div>
      <p class="etf-note">${s.validNow}/${s.live} 只当前波段已确认超过 10%；其余仍在 8%~10% 内，原逻辑保持。</p>
    </div>
    <div class="etf-qcard">
      <div class="etf-qh"><b>今日涨跌</b><span>平均 ${pct(s.todayAvg)}</span></div>
      <div class="etf-kpi">
        <div><b class="up">${s.todayUp}</b><span>上涨</span></div>
        <div><b class="down">${s.todayDown}</b><span>下跌</span></div>
        <div><b>${s.todayFlat}</b><span>平盘</span></div>
      </div>
      <div class="etf-tops"><div class="etf-th">领涨 / 领跌</div><ul>` +
        leaders.slice(0, 3).map(leaderRow).join("") +
        leaders.slice(-3).reverse().map(leaderRow).join("") +
      `</ul></div>
    </div>
    <div class="etf-qcard">
      <div class="etf-qh"><b>全历史最大涨幅</b><span>Top ${topUp.length}</span></div>
      <ul class="etf-tops etf-ext">${topUp.map((r) => extremeRow(r, r.maxUp)).join("")}</ul>
    </div>
    <div class="etf-qcard">
      <div class="etf-qh"><b>全历史最大跌幅</b><span>Top ${topDn.length}</span></div>
      <ul class="etf-tops etf-ext">${topDn.map((r) => extremeRow(r, r.maxDn)).join("")}</ul>
    </div>
    <div class="etf-qcard etf-help">
      <div class="etf-qh"><b>怎么读</b></div>
      <p class="etf-note">低点 → 高点涨幅超过 <b>10%</b> 才计一段有效上涨；此后回撤不足 10%，上涨逻辑继续有效。
      下跌段同理。只有反向波动超过 10%，才算原逻辑被否定、切换方向。</p>
    </div>`;
}

function initEtfUpdown(): void {
  initialized = true;
  table = createDataTable(el("wrap"), [
    { label: "代码", pri: 2, mono: true, sort: "code", render: (r) => esc(r.code) },
    { label: "名称", pri: 1, sort: "name", render: (r) => `<b>${esc(r.name)}</b><span class="muted">${esc(r.full_name)}</span>` },
    { label: "现价", num: true, pri: 1, sort: "price", render: (r) => fmtP(r.price, r.code) },
    { label: "今日涨跌", num: true, pri: 1, sort: "chg_pct", render: (r) => chgPct(r.chg_pct) },
    { label: "当前逻辑", pri: 1, sort: (r) => r.run?.dir ?? 0, render: logicBadge },
    { label: "段内极值", num: true, pri: 2, title: "本轮波段起点 → 段内最高/最低价（带符号）", sort: (r) => r.run?.ext_pct ?? null, render: (r) => runCell(r, "ext_pct") },
    { label: "当前幅度", num: true, pri: 2, title: "本轮波段起点 → 最新价（实时价，带符号）", sort: (r) => r.run?.cur_pct ?? null, render: (r) => runCell(r, "cur_pct") },
    { label: "反向回撤", num: true, pri: 2, title: "段内极值 → 最新价的反向幅度；不足 10% 不否定原逻辑", sort: (r) => r.run?.against_pct ?? null, render: againstCell },
    { label: "有效波段", num: true, pri: 2, title: "全历史有效上涨 / 下跌次数（每段均 >10%）", sort: (r) => r.upN + r.downN, render: (r) => `<span class="up">${r.upN}</span> / <span class="down">${r.downN}</span>` },
    { label: "全历史最大涨幅", num: true, pri: 3, title: "该 ETF 上市以来：任一低点 → 之后最高点的最大涨幅（不按 10% 切段）", sort: (r) => r.maxUp?.pct ?? null, render: (r) => extremeCell(r.maxUp) },
    { label: "全历史最大跌幅", num: true, pri: 3, title: "该 ETF 上市以来：任一高点 → 之后最低点的最大跌幅，即历史最大回撤", sort: (r) => r.maxDn?.pct ?? null, render: (r) => extremeCell(r.maxDn) },
    { label: "数据起点", pri: 3, sort: (r) => r.data_from ?? "", render: dataCell },
  ], {
    tblKey: "etf-updown",
    defaultSort: { label: "当前幅度", dir: 1 },   // 默认跌幅最大在前
    onChange: paint,
    rowKey: (r) => r.code,
    onRow: (r) => {
      document.dispatchEvent(new CustomEvent("yc:open-stock", {
        detail: {
          symbol: r.code, name: r.full_name || r.name,
          from: { page: "etfupdown", label: "ETF逻辑" },
        },
      }));
    },
    empty: "暂时没有 ETF 数据；请稍后点「刷新」重取。",
  });
  el("refresh").addEventListener("click", () => void loadEtfUpdown(true));
  el("tabs").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest(".etf-tab") as HTMLElement | null;
    const key = btn?.dataset.group;
    if (key) switchGroup(key);
  });
  /* 页面在前台时每 60 秒跟一次报价（后端报价缓存也是 60 秒），日线走 6 小时缓存。 */
  setInterval(() => {
    const page = document.getElementById("page-etfupdown");
    if (page?.classList.contains("on") && !document.hidden) void loadEtfUpdown(false);
  }, 60000);
  void loadEtfUpdown(false);
}
