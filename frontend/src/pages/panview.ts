/* 全景页：A股市场大表（众赢「A股全景」布局同源，数据走自有 market_snapshot）。
 * 服务端排序分页（快照表毫秒级 SQL），表头点击 → sort 参数重查；
 * 指数条 + 五分段 tab + 搜索 + 底部总貌条。驻留期间 30s 轮询。 */
import { marketApi, type BoardRow, type IndexBarItem, type BreadthOut } from "../api";
import { esc, fmt, fmtChg, fmtVol, fmtYi } from "../fmt";
import { createPager, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";

/* 表头 label → 服务端 _BOARD_SORT 白名单键（dir 由点击时 sortState 决定） */
const SORT_KEYS: Record<string, string> = {
  "代码": "symbol", "名称": "name", "涨跌幅": "change_rate", "成交额": "amount",
  "换手%": "turnover_rate", "量比": "vol_ratio", "振幅%": "amplitude",
};

type Tab = "hsa" | "cyb" | "kc" | "bj" | "fund";
const TABS: { k: Tab; label: string }[] = [
  { k: "hsa", label: "沪深A股" }, { k: "cyb", label: "创业板" }, { k: "kc", label: "科创板" },
  { k: "bj", label: "北交所" }, { k: "fund", label: "基金" },
];

let tab: Tab = "hsa";
let timer: ReturnType<typeof setInterval> | null = null;
let pager: Pager | null = null;
let tbl: DataTable<BoardRow> | null = null;
let lastRows: BoardRow[] = [];

/* 盘口语义配色：零轴取符号，涨跌双向通吃（后端已按涨跌方向定值） */
function pctCell(v: number | null | undefined, suffix = "%"): string {
  if (v == null) return `<span style="color:var(--faint)">—</span>`;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "";
  return `<span class="${cls}">${fmtChg(v)}${suffix}</span>`;
}

const BOARD_COLS: DataTableCol<BoardRow>[] = [
  { label: "#", width: 34, mono: true, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, sort: "symbol", render: (r) => r.symbol },
  { label: "名称", sort: "name", render: (r) => `<span style="font-weight:600">${esc(r.name || "—")}</span>` },
  { label: "现价", num: true, render: (r) => fmt(r.current) },
  { label: "涨跌额", num: true, render: (r) => pctCell(r.change_amount, "") },
  { label: "涨跌幅", num: true, sort: "change_rate", render: (r) => pctCell(r.change_rate) },
  { label: "买入", num: true, title: "买一价", render: (r) => fmt(r.bid1) },
  { label: "卖出", num: true, title: "卖一价", render: (r) => fmt(r.ask1) },
  { label: "最高", num: true, render: (r) => (r.high != null ? `<span class="up">${fmt(r.high)}</span>` : "—") },
  { label: "最低", num: true, render: (r) => (r.low != null ? `<span class="down">${fmt(r.low)}</span>` : "—") },
  { label: "今开", num: true, render: (r) => fmt(r.open) },
  { label: "昨收", num: true, render: (r) => fmt(r.pre_close) },
  { label: "成交量", num: true, title: "手", render: (r) => fmtVol(r.volume) },
  { label: "成交额", num: true, sort: "amount", render: (r) => fmtYi(r.amount) },
  { label: "换手%", num: true, sort: "turnover_rate", render: (r) => fmt(r.turnover_rate) },
  { label: "量比", num: true, sort: "vol_ratio", render: (r) => fmt(r.vol_ratio) },
  { label: "振幅%", num: true, sort: "amplitude", render: (r) => fmt(r.amplitude) },
  { label: "流通市值", num: true, render: (r) => fmtYi(r.circ_value) },
  { label: "总市值", num: true, render: (r) => fmtYi(r.market_value) },
  { label: "涨停", num: true, render: (r) => (r.up_limit ? `<span class="up">${fmt(r.up_limit)}</span>` : "—") },
  { label: "跌停", num: true, render: (r) => (r.down_limit ? `<span class="down">${fmt(r.down_limit)}</span>` : "—") },
];

/* 当前 sort 参数（"-" 前缀 = 降序）；默认涨跌幅降序（行情习惯） */
function sortParam(): string {
  const st = tbl?.sortState;
  if (!st?.label) return "-change_rate";
  const key = SORT_KEYS[st.label];
  if (!key) return "-change_rate";
  return st.dir === -1 ? `-${key}` : key;
}

async function load(): Promise<void> {
  const count = document.getElementById("pan-count")!;
  try {
    if (!pager) pager = createPager(document.getElementById("pan-pager")!, "panorama", () => void load());
    if (!tbl) tbl = createDataTable(document.getElementById("pan-wrap")!, BOARD_COLS, {
      defaultSort: { label: "涨跌幅", dir: -1 },
      onChange: () => {                        // 表头点击 → 服务端重排，回第 1 页
        pager!.reset();
        void load();
      },
      onRow: (r) => document.dispatchEvent(new CustomEvent("yc:open-stock-detail", {
        detail: { symbol: r.symbol, name: r.name || r.symbol } })),
    });
    const r = await marketApi.board({
      tab, sort: sortParam(), page: pager.page, size: pager.size,
      q: (document.getElementById("pan-q") as HTMLInputElement).value.trim() || undefined,
    });
    lastRows = r.items;
    pager.update(r.total);
    tbl.render(r.items, (pager.page - 1) * pager.size);
    count.textContent = `共 ${r.total} 只`;
    document.getElementById("pan-asof")!.textContent = r.as_of ? `快照 ${r.as_of}` : "";
    document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
  } catch {
    count.textContent = "加载失败";
  }
}

/* 指数条：INDEX_CATALOG × 当日快照，缺失指数灰色占位 */
async function loadIndexBar(): Promise<void> {
  const el = document.getElementById("pan-indexbar")!;
  try {
    const items: IndexBarItem[] = await marketApi.indexBar();
    el.innerHTML = items.map((it) => {
      const pct = it.change_rate;
      const cls = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
      const off = it.current == null;
      return `<span class="chip pan-idx${off ? " off" : ""}" data-sym="${esc(it.symbol)}" data-name="${esc(it.name)}"` +
        ` title="${esc(it.symbol)} · 点击进行情页 K 线">` +
        `<b>${esc(it.name)}</b>` +
        (off ? `<span style="color:var(--faint)">—</span>`
             : `<span class="num">${fmt(it.current)}</span>` +
               `<span class="num ${cls}">${pct == null ? "—" : fmtChg(pct) + "%"}</span>`) +
        `</span>`;
    }).join("");
    el.querySelectorAll<HTMLElement>(".pan-idx").forEach((c) =>
      c.addEventListener("click", () => {
        if (c.classList.contains("off")) return;
        document.dispatchEvent(new CustomEvent("yc:open-stock", {
          detail: { symbol: c.dataset.sym!, name: c.dataset.name!,
            from: { page: "panorama", label: "A股全景" } } }));
      }));
  } catch { el.innerHTML = ""; }
}

/* 底部总貌条：涨跌家数 / 涨跌停精确家数 / 两市成交额 */
function drawBreadth(b: BreadthOut): void {
  const t = document.getElementById("pan-breadth")!;
  t.innerHTML =
    `<span>上涨 <b class="num up">${b.up}</b></span>` +
    `<span>下跌 <b class="num down">${b.down}</b></span>` +
    `<span>平盘 <b class="num" style="color:var(--dim)">${b.flat}</b></span>` +
    `<span class="barsep"></span>` +
    `<span>涨停 <b class="num up">${b.limit_up}</b></span>` +
    `<span>跌停 <b class="num down">${b.limit_down}</b></span>` +
    `<span class="barsep"></span>` +
    `<span>两市成交额 <b class="num">${fmtYi(b.amount)}</b></span>` +
    `<span class="sp" style="flex:1"></span>` +
    (b.updated_at ? `<span style="color:var(--faint)">更新于 ${esc(b.updated_at.slice(11, 19) || b.updated_at)}</span>` : "");
}

async function loadBreadth(): Promise<void> {
  try { drawBreadth(await marketApi.breadth()); } catch { /* 总貌失败不打断大表 */ }
}

function loadAll(): void {
  void load();
  void loadBreadth();
  void loadIndexBar();
}

export function loadPanorama(): void {
  loadAll();
  if (!timer) {
    timer = setInterval(() => {
      if (document.getElementById("page-panorama")?.classList.contains("on")) loadAll();
    }, 30_000);
  }
}

export function initPanorama(): void {
  document.getElementById("pan-refresh")!.addEventListener("click", loadAll);
  document.getElementById("pan-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-t]");
    if (!b) return;
    tab = b.dataset.t as Tab;
    document.querySelectorAll<HTMLElement>("#pan-tabs button").forEach((x) =>
      x.classList.toggle("on", x === b));
    pager?.reset();
    void load();
  });
  let deb: ReturnType<typeof setTimeout> | null = null;
  document.getElementById("pan-q")!.addEventListener("input", () => {
    if (deb) clearTimeout(deb);
    deb = setTimeout(() => { pager?.reset(); void load(); }, 300);
  });
}
