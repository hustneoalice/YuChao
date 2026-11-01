/* 全景页：A股市场大表（众赢「A股全景」双栏联动布局）。
 * 左：指数条 + 九段 tab（股票/基金分类 + 板块监测）+ 服务端排序分页大表 + 底部总貌条；
 * 右：分时（上）+ 日K（下）上下分布，行点击页内联动不跳页。
 * 板块监测走众赢清单 × market_snapshot 本地聚合（/market/zy_blocks）。
 * 驻留期间 30s 轮询左表；右侧图表点选时拉取（腾讯实时）。 */
import { marketApi, type BoardRow, type IndexBarItem, type BreadthOut,
         type ZyBlockRow } from "../api";
import { esc, fmt, fmtChg, fmtVol, fmtYi } from "../fmt";
import { createPager, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { createIntraday, type IntradayHandle } from "../intraday";
import { mountKline, type KlineChartHandle } from "./kline";

/* 表头 label → 服务端排序白名单键（dir 由点击时 sortState 决定） */
const SORT_KEYS: Record<string, string> = {
  "代码": "symbol", "名称": "name", "涨跌幅": "change_rate", "成交额": "amount",
  "换手%": "turnover_rate", "量比": "vol_ratio", "振幅%": "amplitude",
};
const BLOCK_SORT_KEYS: Record<string, string> = {
  "板块名称": "block_code", "均涨%": "avg_change", "成交额": "amount", "上涨占比": "up_rate",
};

type Tab = "hsa" | "sha" | "sza" | "cyb" | "kc" | "bj" | "fund_sh" | "fund_sz" | "block";
const TABS: { k: Tab; label: string }[] = [
  { k: "hsa", label: "沪深A股" }, { k: "sha", label: "沪市A股" }, { k: "sza", label: "深市A股" },
  { k: "cyb", label: "创业板" }, { k: "kc", label: "科创板" }, { k: "bj", label: "北交所" },
  { k: "fund_sh", label: "上证基金" }, { k: "fund_sz", label: "深证基金" }, { k: "block", label: "板块监测" },
];
/* 板块监测二级类型（众赢 typeCode：1 地域 / 2 概念 / 4 行业 / 8 风格 / 9 题材） */
const BTYPES: { code: number; label: string }[] = [
  { code: 2, label: "概念" }, { code: 4, label: "行业" }, { code: 9, label: "题材" },
  { code: 1, label: "地域" }, { code: 8, label: "风格" },
];

let tab: Tab = "hsa";
let blockType = 2;                       // 板块监测当前类型（概念默认，众赢同款）
let curBlock: { code: string; name: string } | null = null;   // 非空 = 板块成分视图
let timer: ReturnType<typeof setInterval> | null = null;
let pager: Pager | null = null;
let tbl: DataTable<BoardRow> | DataTable<ZyBlockRow> | null = null;
let tblKind: "board" | "blocks" | null = null;                // 当前表实例（切模式重建）

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

/* 板块列表列（zy_blocks 聚合行：均涨/涨跌家数/领涨股/成分数） */
const BLOCK_COLS: DataTableCol<ZyBlockRow>[] = [
  { label: "#", width: 34, mono: true, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "板块名称", sort: "block_code", render: (r) =>
      `<span style="font-weight:600">${esc(r.block_name)}</span>` },
  { label: "均涨%", num: true, sort: "avg_change", title: "成分涨跌幅平均", render: (r) => pctCell(r.avg_change) },
  { label: "上涨", num: true, render: (r) => (r.up_count ? `<span class="up num">${r.up_count}</span>` : `<span style="color:var(--faint)">0</span>`) },
  { label: "下跌", num: true, render: (r) => (r.down_count ? `<span class="down num">${r.down_count}</span>` : `<span style="color:var(--faint)">0</span>`) },
  { label: "上涨占比", num: true, sort: "up_rate", render: (r) =>
      (r.members ? `${Math.round((r.up_count / r.members) * 100)}%` : "—") },
  { label: "领涨股", render: (r) => (r.leader
      ? `${esc(r.leader)} ${pctCell(r.leader_change, "")}` : `<span style="color:var(--faint)">—</span>`) },
  { label: "成分数", num: true, title: "有当日快照的成分", render: (r) => (r.members ? `<span class="num">${r.members}</span>` : `<span style="color:var(--faint)">0</span>`) },
  { label: "成交额", num: true, sort: "amount", render: (r) => fmtYi(r.amount) },
];

/* 当前 sort 参数（"-" 前缀 = 降序）；默认涨跌幅降序（行情习惯） */
function sortParam(): string {
  const st = tbl?.sortState;
  if (st?.label) {
    const key = (tblKind === "blocks" ? BLOCK_SORT_KEYS : SORT_KEYS)[st.label];
    if (key) return st.dir === -1 ? `-${key}` : key;
  }
  return tblKind === "blocks" ? "-avg_change" : "-change_rate";
}

/* ── 右栏联动：分时（独立 canvas 画法）+ 日K（klinecharts） ── */
let intra: IntradayHandle | null = null;
let klD: KlineChartHandle | null = null;
let linkSymbol: string | null = null;    // 当前联动标的（同标的点击不重拉）
let linkToken = 0;                       // 竞态守卫：快速连点只认最后一次

function ensureCharts(): void {
  if (!intra) intra = createIntraday(document.getElementById("pan-kl-t")!);
  if (!klD) klD = mountKline(document.getElementById("pan-kl-d")!);
}

/** 行点击 → 右侧分时+日K 联动（页内，不跳详情页） */
async function setLink(symbol: string, name: string, row?: BoardRow): Promise<void> {
  ensureCharts();
  const head = document.getElementById("pan-link-name")!;
  const code = document.getElementById("pan-link-code")!;
  const quote = document.getElementById("pan-link-quote")!;
  head.textContent = name || symbol;
  code.textContent = symbol;
  quote.innerHTML = row && row.current != null
    ? `${fmt(row.current)} <b class="${(row.change_rate ?? 0) > 0 ? "up" : (row.change_rate ?? 0) < 0 ? "down" : ""}">${fmtChg(row.change_rate ?? 0)}%</b>`
    : `<span style="color:var(--faint)">—</span>`;
  if (linkSymbol === symbol) return;      // 同标的重复点击：不重拉（30s 轮询在管左表）
  linkSymbol = symbol;
  const token = ++linkToken;
  // 分时/日K 各自降级：腾讯分钟源抖动（偶发 5xx）时日K 照常出图，分时空白待重试
  const [miRes, klRes] = await Promise.allSettled([
    marketApi.minute(symbol),
    marketApi.kline({ symbol, adjust: "qfq", limit: 250 }),
  ]);
  if (token !== linkToken) return;      // 已切别的标的：丢弃过期响应
  if (klRes.status === "fulfilled") {
    // 日K：默认 MA 主图 + 量副图
    klD!.setPeriod("d");
    klD!.setMain(["ma"]);
    klD!.setSub(["vol"]);
    klD!.setData(klRes.value.bars ?? []);
  }
  if (miRes.status === "fulfilled") {
    // 分时：左涨跌幅轴 + 右价格轴 + 昨收虚线 + 均价线 + VOLFS 逐分钟量柱
    intra!.setData(miRes.value);
  } else {
    intra!.setMessage("分时源暂不可用（日K 正常）");
    quote.innerHTML = `<span style="color:var(--faint)">分时源暂不可用（日K 正常）</span>`;
  }
}

/** 表实例按模式重建（board 行 / blocks 行列不同，容器复用） */
function ensureTable(): void {
  const want = tab === "block" && !curBlock ? "blocks" : "board";
  if (tblKind === want && tbl) return;
  const wrap = document.getElementById("pan-wrap")!;
  wrap.innerHTML = "";
  tblKind = want;
  if (want === "blocks") {
    tbl = createDataTable<ZyBlockRow>(wrap, BLOCK_COLS, {
      defaultSort: { label: "均涨%", dir: -1 },
      onChange: () => { pager!.reset(); void load(); },
      onRow: (r) => openBlock(r.block_code, r.block_name),
    });
  } else {
    tbl = createDataTable<BoardRow>(wrap, BOARD_COLS, {
      defaultSort: { label: "涨跌幅", dir: -1 },
      onChange: () => { pager!.reset(); void load(); },
      onRow: (r) => void setLink(r.symbol, r.name || r.symbol, r),
    });
  }
}

/** 板块监测：点板块行 → 左表切成分视图（返回按钮回清单） */
function openBlock(code: string, name: string): void {
  curBlock = { code, name };
  pager?.reset();
  tbl = null; tblKind = null;             // 强制重建为成分表
  syncHead();
  void load();
}

function backToBlocks(): void {
  curBlock = null;
  pager?.reset();
  tbl = null; tblKind = null;
  syncHead();
  void load();
}

/** 页头控件可见性随模式切换（类型 seg / 返回按钮） */
function syncHead(): void {
  const inBlocks = tab === "block" && !curBlock;
  document.getElementById("pan-btypes")!.hidden = !inBlocks;
  document.getElementById("pan-back")!.hidden = !curBlock;
}

async function load(): Promise<void> {
  const count = document.getElementById("pan-count")!;
  try {
    if (!pager) pager = createPager(document.getElementById("pan-pager")!, "panorama", () => void load());
    ensureTable();
    const q = (document.getElementById("pan-q") as HTMLInputElement).value.trim() || undefined;
    if (tblKind === "blocks") {
      const r = await marketApi.zyBlocks({
        type_code: blockType, sort: sortParam(), page: pager.page, size: pager.size, q,
      });
      pager.update(r.total);
      (tbl as DataTable<ZyBlockRow>).render(r.items, (pager.page - 1) * pager.size);
      count.textContent = `共 ${r.total} 个板块`;
      document.getElementById("pan-asof")!.textContent = r.as_of ? `快照 ${r.as_of}` : "";
      document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
    } else if (curBlock) {
      const r = await marketApi.zyBlockMembers(curBlock.code, {
        sort: sortParam(), page: pager.page, size: pager.size, q,
      });
      pager.update(r.total);
      (tbl as DataTable<BoardRow>).render(r.items, (pager.page - 1) * pager.size);
      count.textContent = `${r.block_name} · ${r.total} 只成分`;
      document.getElementById("pan-asof")!.textContent = r.as_of ? `快照 ${r.as_of}` : "";
      document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
    } else {
      const r = await marketApi.board({
        tab, sort: sortParam(), page: pager.page, size: pager.size, q,
      });
      pager.update(r.total);
      (tbl as DataTable<BoardRow>).render(r.items, (pager.page - 1) * pager.size);
      count.textContent = `共 ${r.total} 只`;
      document.getElementById("pan-asof")!.textContent = r.as_of ? `快照 ${r.as_of}` : "";
      document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
    }
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
  ensureCharts();
  loadAll();
  intra?.resize();
  klD?.resize();
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
    if (tab !== "block") curBlock = null;
    document.querySelectorAll<HTMLElement>("#pan-tabs button").forEach((x) =>
      x.classList.toggle("on", x === b));
    pager?.reset();
    tbl = null; tblKind = null;           // 切 tab 重建表（板块/股票列不同）
    syncHead();
    void load();
  });
  document.getElementById("pan-btypes")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-bt]");
    if (!b) return;
    blockType = Number(b.dataset.bt);
    document.querySelectorAll<HTMLElement>("#pan-btypes button").forEach((x) =>
      x.classList.toggle("on", x === b));
    pager?.reset();
    void load();
  });
  document.getElementById("pan-back")!.addEventListener("click", backToBlocks);
  let deb: ReturnType<typeof setTimeout> | null = null;
  document.getElementById("pan-q")!.addEventListener("input", () => {
    if (deb) clearTimeout(deb);
    deb = setTimeout(() => { pager?.reset(); void load(); }, 300);
  });
}
