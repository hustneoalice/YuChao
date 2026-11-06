import { fetchMainforce, type MainforceRow } from "../mainforce-api";
import { esc, fmtYiS } from "../fmt";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { createPager, type Pager } from "../pager";

let view: "blocks" | "stocks" = "blocks";
let block: { code: string; name: string } | null = null;
let typeCode = 4;
let end: string | undefined;
let table: DataTable<MainforceRow>;
let tableView: "blocks" | "stocks";
let pager: Pager;
let revision = 0;
let controller: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const el = (id: string) => document.getElementById(`mf-${id}`)!;
const query = () => el("q") as HTMLInputElement;
const sortKeys: Record<string, string> = {};

function numberCell(v: number | null, money = false): string {
  if (v == null) return "—";
  return `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${money ? fmtYiS(v) : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`}</span>`;
}
function columns(): DataTableCol<MainforceRow>[] {
  const cols: DataTableCol<MainforceRow>[] = [
    { label: "#", width: 40, mono: true, render: (_r, i) => String(i + 1) },
  ];
  if (view === "stocks") cols.push({ label: "代码", width: 90, mono: true, render: (r) => esc(r.symbol || r.key) });
  cols.push({ label: "名称", width: 140, sort: "name", render: (r) => `<b>${esc(r.name || "名称暂缺")}</b>` });
  sortKeys["名称"] = "name";
  const changeLabel = view === "blocks" ? "成分均涨%" : "涨幅%";
  sortKeys[changeLabel] = "change_rate";
  cols.push({ label: changeLabel, num: true, sort: "change_rate", title: "资金截止日行情，板块为成分平均涨幅", render: (r) => numberCell(r.change_rate) });
  if (view === "blocks") {
    sortKeys["涨停家数"] = "limit_up_count";
    cols.push(
      { label: "涨停家数", num: true, sort: "limit_up_count", title: "资金截止日收盘涨停家数；缺少同日精确涨停价时显示—", render: (r) => r.limit_up_count == null ? "—" : String(r.limit_up_count) },
      { label: "成分股数量", num: true, render: (r) => r.block_code ? `<button class="hbtn" data-members title="查看成分股资金动向">成分股（${r.members}）</button>` : String(r.members) },
    );
  } else {
    cols.push({ label: "查看", render: () => '<button class="hbtn" data-stock>日K</button>' });
  }
  for (const [group, name] of [["main", "主力"], ["medium", "游资"], ["small", "散户"]] as const) {
    for (const [field, label] of [["net", "净额"], ["participation", "介入度"], ["ratio", "占比"]] as const) {
      const title = `${name}${label}`;
      sortKeys[title] = `${group}_${field}`;
      cols.push({ label: title, num: true, sort: (r) => r[group][field],
        title: field === "net" ? "累计净流入，单位元（显示为亿元）" : field === "participation" ? "累计净额 / 同期流通市值合计 × 100%" : "累计净额 / 同期成交额合计 × 100%",
        render: (r) => numberCell(r[group][field], field === "net") });
    }
  }
  sortKeys["连续净流入"] = "continuous_inflow_days";
  cols.push(
    { label: "连续净流入", num: true, sort: "continuous_inflow_days", title: "主力连续净流入天数；≥表示回溯上限", render: (r) => r.continuous_inflow_days == null ? "—" : `${r.streak_capped ? "≥" : ""}${r.continuous_inflow_days}天` },
    { label: "资金覆盖", num: true, title: "有资金记录的成分股日 / 成分数 × 实际交易日数", render: (r) => `${r.covered}/${r.expected}` },
    { label: "最大净流入股", render: (r) => r.top_stock_symbol ? `<button class="mf-stock" data-top title="打开日K">${esc(r.top_stock_name || r.top_stock_symbol)}</button>` : esc(r.top_stock_name || "—") },
  );
  return cols;
}
function openStock(symbol: string, name: string): void {
  document.dispatchEvent(new CustomEvent("yc:open-stock", { detail: {
    symbol, name, from: { page: "mainforce", label: "主力军情" },
  } }));
}
function reset(): void { pager.reset(); void loadMainforce(); }
function syncControls(): void {
  el("types").hidden = view !== "blocks";
  el("back").textContent = view === "blocks" ? "返回全部板块" : "返回全部股票";
  query().placeholder = view === "blocks" ? "搜索板块名称" : "搜索股票代码 / 名称";
  el("search-label").textContent = view === "blocks" ? "板块搜索" : "股票搜索";
  el("scope").textContent = block ? `${block.name} · 成分股` : view === "blocks" ? "全部板块" : "全部股票";
  el("tabs").querySelectorAll<HTMLElement>("button").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
export async function loadMainforce(): Promise<void> {
  const current = ++revision;
  controller?.abort();
  controller = new AbortController();
  if (tableView !== view) createTable();
  const state = table.sortState;
  const key = sortKeys[state.label ?? ""] ?? "main_net";
  const page = pager.page;
  const size = pager.size;
  syncControls();
  el("status").textContent = "正在加载收盘资金数据…";
  el("retry").hidden = true;
  el("meta").textContent = "";
  el("wrap").setAttribute("aria-busy", "true");
  // 同视图加载时保留上一份结果，避免切换周期、排序时表格闪空。
  try {
    const result = await fetchMainforce({ view, type_code: typeCode, block_code: block?.code,
      period: Number((el("period") as HTMLSelectElement).value), end, q: query().value.trim(),
      sort: `${state.dir === -1 ? "-" : ""}${key}`, page, size,
    }, controller.signal);
    if (current !== revision) return;
    if (!end) (el("date") as HTMLInputElement).value = result.as_of || "";
    pager.update(result.total);
    table.render(result.items, (page - 1) * size);
    el("status").textContent = !result.as_of || !result.days.length ? "所选日期范围内暂无可用资金数据；请调整日期。" : !result.items.length && result.total ? "当前页暂无可展示资金数据；请刷新或调整条件。" : result.total ? `共 ${result.total} ${view === "blocks" ? "个板块" : "只股票"}` : "该条件下暂无资金数据；可调整日期或搜索条件。";
    el("meta").textContent = `日级 / 收盘 · ${result.start || "—"} 至 ${result.as_of || "—"} · 请求 ${result.period} 日 / 实际 ${result.days.length} 个交易日 · 来源 ${result.source || "—"}${result.note ? ` · ${result.note}` : ""}`;
  } catch (error) {
    if (current !== revision) return;
    el("status").textContent = `加载失败：${error instanceof Error ? error.message : "请重试"}`;
    el("retry").hidden = false;
    pager.update(0);
  } finally {
    if (current === revision) el("wrap").setAttribute("aria-busy", "false");
  }
}
function createTable(): void {
  el("wrap").dataset.view = view;
  const previous = table?.sortState;
  const label = previous?.label === "成分均涨%" || previous?.label === "涨幅%"
    ? view === "blocks" ? "成分均涨%" : "涨幅%" : previous?.label;
  tableView = view;
  table = createDataTable(el("wrap"), columns(), {
    defaultSort: { label: label || "主力净额", dir: previous?.dir ?? -1 }, onChange: reset, rowKey: (r) => r.key,
    onRow: (r, event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-top]") && r.top_stock_symbol) { openStock(r.top_stock_symbol, r.top_stock_name || r.top_stock_symbol); return; }
      if (r.symbol) { openStock(r.symbol, r.name); return; }
      if (target.closest("[data-members]") && r.block_code) {
        block = { code: r.block_code, name: r.name }; view = "stocks"; query().value = ""; reset();
      }
    },
  });
}
export function initMainforce(): void {
  pager = createPager(el("pager"), "mainforce", () => void loadMainforce());
  createTable();
  el("tabs").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button[data-view]");
    if (!button) return;
    view = button.dataset.view as typeof view; block = null; query().value = ""; reset();
  });
  el("types").addEventListener("change", () => { typeCode = Number((el("types") as HTMLSelectElement).value); block = null; reset(); });
  el("period").addEventListener("change", reset);
  el("date").addEventListener("change", () => { end = (el("date") as HTMLInputElement).value || undefined; reset(); });
  el("latest").addEventListener("click", () => { end = undefined; reset(); });
  query().addEventListener("input", () => {
    clearTimeout(searchTimer);
    // Cancel immediately so an older search cannot paint during the debounce delay.
    ++revision; controller?.abort();
    searchTimer = setTimeout(reset, 300);
  });
  el("refresh").addEventListener("click", () => void loadMainforce());
  el("retry").addEventListener("click", () => void loadMainforce());
  el("back").addEventListener("click", () => { block = null; query().value = ""; reset(); });
}
