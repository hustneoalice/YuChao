/* 股东卡：按股缓存季度选择，切股/切季度不接收过期回包。 */
import { marketApi, type ShareholdersOut } from "./api";
import { esc, fmt, fmtChg } from "./fmt";
import { ic } from "./icons";

type View = { scroll: number; expanded: Set<string> };
type State = {
  data?: ShareholdersOut; selected?: string; loading: boolean; error: string;
  revision: number; at: number; views: Map<string, View>;
  waiters: Array<() => void>;                  // 等这屏数据的卡片（预取完成后统一重绘）
};
const states = new Map<string, State>();

function state(symbol: string): State {
  let s = states.get(symbol);
  if (!s) {
    if (states.size >= 32) {
      const idle = [...states].find(([, v]) => !v.loading);
      if (idle) states.delete(idle[0]);
    }
    s = { loading: false, error: "", revision: 0, at: 0, views: new Map(), waiters: [] };
    states.set(symbol, s);
  }
  return s;
}

function view(s: State): View {
  const key = s.data?.report_date || "";
  let v = s.views.get(key);
  if (!v) { v = { scroll: 0, expanded: new Set() }; s.views.set(key, v); }
  return v;
}

function quarter(d: string): string {
  return `${d.slice(0, 4)}年${["一", "二", "三", "四"][Math.floor((Number(d.slice(5, 7)) - 1) / 3)]}季度`;
}

function shares(n: number | null): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  return abs >= 1e8 ? `${fmt(n / 1e8)}亿股` : abs >= 1e4 ? `${fmt(n / 1e4)}万股` : `${fmt(n, 0)}股`;
}

export function shareholderBody(symbol: string, mode: string): string {
  const s = state(symbol), d = s.data;
  const curQuarter = s.selected || d?.report_date || d?.report_dates[0];
  // 原生 select 的弹出列表由系统绘制，深色主题下仍是白底；这里改成自绘下拉，颜色完全跟随主题
  const select = d?.report_dates.length && curQuarter ? `<div class="sh-quarter"><span>报告期</span><div class="sh-pick" data-sh-pick>` +
    `<button type="button" class="sh-pick-btn" data-sh-toggle aria-haspopup="listbox" aria-expanded="false" aria-label="股东报告期">${quarter(curQuarter)}${ic("caret-down", 10)}</button>` +
    `<div class="sh-pick-pop" role="listbox" hidden>${d.report_dates.map((q) =>
      `<button type="button" role="option" data-sh-opt="${esc(q)}" aria-selected="${q === curQuarter}">${quarter(q)}</button>`).join("")}</div></div></div>` : "";
  if (s.error) return `${select}<div class="bempty">${esc(s.error)}<br><button class="hbtn" data-sh-retry>重试</button></div>`;
  if (!d || s.loading) return `${select}<div class="bempty" role="status">正在加载股东披露…</div>`;
  if (!d.items.length) return `<div class="bempty">暂无十大流通股东披露<br>指数、ETF不适用</div>`;
  const detail = mode === "detailed";
  const expanded = view(s).expanded;
  return `${select}<div class="sh-total"><span>合计占总股本 <b>${fmt(d.total_ratio)}%</b></span><span title="相较上一季度，单位为百分点">环比 ${d.ratio_change == null ? "—" : fmtChg(d.ratio_change) + "个百分点"}</span></div>` +
    `<div class="sh-table"><table><thead><tr><th scope="col">股东名称</th><th scope="col">变化</th><th scope="col">持股数量</th></tr></thead><tbody>${d.items.map((x) => {
      const cls = x.change === "进入" || x.change === "加仓" ? "up" : x.change === "减仓" ? "down" : "";
      const help = x.change === "进入" ? "上季度十大名单中未出现，不代表首次买入" : "与上季度末持股数量比较";
      const open = expanded.has(x.name);
      return `<tr${x.is_social_security ? ' class="sh-social"' : ""}><td><button class="sh-name${open ? " expanded" : ""}" data-sh-name="${esc(x.name)}" aria-expanded="${open}" title="${esc(x.name)}（点击展开全名）">${esc(x.name)}</button>${x.is_social_security ? '<span class="sh-badge">社保基金</span>' : ""}</td>` +
        `<td class="${cls}" title="${help}">${x.change}</td><td class="num">${shares(x.shares)}<small>占比 ${fmt(x.ratio)}%</small></td></tr>` +
        (detail ? `<tr class="sh-detail"><td colspan="3">股数变化 ${x.share_change == null ? "—" : (x.share_change > 0 ? "+" : "") + shares(x.share_change)} · 占比变化 ${x.ratio_change == null ? "—" : fmtChg(x.ratio_change) + "个百分点"}</td></tr>` : "");
    }).join("")}</tbody></table></div>` +
    `<div class="sh-note">公告日期 ${esc(d.notice_date || "未提供")} · 季末快照<br>变化按股数比较；“进入”仅表示新进入十大名单。${d.previous_report_date ? `比较期 ${esc(d.previous_report_date)}。` : "缺少上一季度数据，无法比较。"}<br>${esc(d.source)}</div>`;
}

/** 自绘季度下拉的全局监听：卡片每次重绘都会重绑，先清掉上一轮，避免监听越积越多 */
let pickCleanup: (() => void) | null = null;
/** 行情轮询会整列重绘，记住展开状态，别让下拉被 20s 一次的刷新关掉 */
let pickOpen = false;
let pickSymbol = "";

const SH_TTL = 3600_000;

const shFresh = (s: State): boolean => (!!s.data && Date.now() - s.at <= SH_TTL) || !!s.error;

/** 打开个股即预取十大股东（季报数据，一天不变）：切到股东卡直接有表 */
export function prefetchShareholders(symbol: string): Promise<void> {
  const s = state(symbol);
  if (!s.loading && shFresh(s)) return Promise.resolve();
  return new Promise((resolve) => ensureShareholders(symbol, resolve));
}

function ensureShareholders(symbol: string, done?: () => void, force = false): void {
  const s = state(symbol);
  if (done && !s.waiters.includes(done)) s.waiters.push(done);
  if (s.loading) return;
  if (!force && shFresh(s)) {
    s.waiters.length = 0;                           // 已有数据：不回调（否则 redraw→bind→再回调死循环）
    return;
  }
  s.loading = true;
  s.error = "";
  const revision = ++s.revision;
  void (async () => {
    try {
      const data = await marketApi.shareholders(symbol, s.selected);
      if (s.revision !== revision) return;
      s.data = data;
      s.at = Date.now();
    } catch (e) {
      if (s.revision !== revision) return;
      s.error = (e as Error).message || "股东数据加载失败";
    } finally {
      if (s.revision === revision) {
        s.loading = false;
        const waiters = s.waiters.splice(0);
        for (const fn of waiters) fn();
      }
    }
  })();
}

export function bindShareholders(root: HTMLElement, symbol: string, redraw: () => void): void {
  const s = state(symbol);
  pickCleanup?.();
  pickCleanup = null;
  if (pickSymbol !== symbol) {
    pickSymbol = symbol;
    pickOpen = false;
  }
  const pick = root.querySelector<HTMLElement>("[data-sh-pick]");
  if (pick) {
    const toggle = pick.querySelector<HTMLButtonElement>("[data-sh-toggle]")!;
    const pop = pick.querySelector<HTMLElement>(".sh-pick-pop")!;
    const close = (): void => { pickOpen = false; pop.hidden = true; toggle.setAttribute("aria-expanded", "false"); };
    toggle.addEventListener("click", () => {
      const open = pop.hidden;
      pickOpen = open;
      pop.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
    if (pickOpen) {
      pop.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
    }
    pop.querySelectorAll<HTMLButtonElement>("[data-sh-opt]").forEach((b) => b.addEventListener("click", () => {
      const value = b.dataset.shOpt!;
      close();
      if (value === (s.selected || s.data?.report_date)) return;
      s.selected = value;
      ensureShareholders(symbol, redraw, true);
      redraw();
    }));
    const onDown = (e: PointerEvent): void => { if (!pick.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || pop.hidden) return;
      e.stopPropagation();
      close();
      toggle.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    pickCleanup = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }
  root.querySelector("[data-sh-retry]")?.addEventListener("click", () => {
    ensureShareholders(symbol, redraw, true);
    redraw();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-sh-name]").forEach((b) => b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    const expanded = view(s).expanded;
    if (open) expanded.add(b.dataset.shName!); else expanded.delete(b.dataset.shName!);
    b.setAttribute("aria-expanded", String(open));
    b.classList.toggle("expanded", open);
  }));
  const table = root.querySelector<HTMLElement>(".sh-table");
  if (table) {
    const v = view(s);
    table.scrollTop = v.scroll;
    table.addEventListener("scroll", () => { v.scroll = table.scrollTop; }, { passive: true });
  }
  ensureShareholders(symbol, redraw);
}
