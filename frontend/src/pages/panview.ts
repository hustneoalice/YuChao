/* 全景页：A股市场大表（众赢「A股全景」双栏联动布局）。
 * 左：tab（股票/基金分类 + 板块监测 + 指数）+ 排序分页大表 + 底部总貌条；
 * 右：分时（上）+ 日K（下）上下分布，行点击页内联动不跳页。
 * 板块监测走众赢清单 × market_snapshot 本地聚合（/market/zy_blocks）。
 * 驻留期间 30s 轮询左表；右侧图表点选时拉取（腾讯实时）。 */
import { marketApi, type BoardRow, type IndexBarItem, type BreadthOut,
         type ZyBlockRow } from "../api";
import { esc, fmt, fmtChg, fmtP, fmtVol, fmtYi } from "../fmt";
import { createPager, type Pager } from "../pager";
import { createDataTable, type DataTable, type DataTableCol } from "../table";
import { createIntraday, type IntradayHandle } from "../intraday";
import { createChartPanel, type ChartPanelHandle } from "../chartpanel";
import { ic } from "../icons";
import { addWatch, isWatched, subscribe } from "../store";
import { toast } from "../ui";
import { openWatchPanel } from "../watch";

/* 表头 label → 服务端排序白名单键（dir 由点击时 sortState 决定） */
const SORT_KEYS: Record<string, string> = {
  "代码": "symbol", "名称": "name", "涨跌幅": "change_rate", "成交额": "amount",
  "换手%": "turnover_rate", "量比": "vol_ratio", "振幅%": "amplitude",
};
const BLOCK_SORT_KEYS: Record<string, string> = {
  "板块名称": "block_code", "均涨%": "avg_change", "成交额": "amount", "上涨占比": "up_rate",
};

type Tab = "hsa" | "sha" | "sza" | "cyb" | "kc" | "fund_sh" | "fund_sz" | "block" | "index";
const TABS: { k: Tab; label: string }[] = [
  { k: "hsa", label: "沪深A股" }, { k: "sha", label: "沪市A股" }, { k: "sza", label: "深市A股" },
  { k: "cyb", label: "创业板" }, { k: "kc", label: "科创板" },
  { k: "fund_sh", label: "上证基金" }, { k: "fund_sz", label: "深证基金" }, { k: "block", label: "板块" },
  { k: "index", label: "指数" },
];
/* 板块监测二级类型（众赢 typeCode：1 地域 / 2 概念 / 4 行业 / 8 风格 / 9 题材） */
const BTYPES: { code: number; label: string }[] = [
  { code: 2, label: "概念" }, { code: 4, label: "行业" }, { code: 9, label: "题材" },
  { code: 1, label: "地域" }, { code: 8, label: "风格" },
  { code: 6, label: "雷达" },
];

let tab: Tab = "hsa";
let blockType = 2;                       // 板块监测当前类型（概念默认，众赢同款）
let blockParent: { code: string; name: string } | null = null;
let blockRevision = 0, memberRevision = 0;
let curBlock: { code: string; name: string } | null = null;   // 板块监测：上方选中的板块
let timer: ReturnType<typeof setInterval> | null = null;
let pager: Pager | null = null;          // 非板块 tab 的分页器
let blkPager: Pager | null = null;       // 板块监测上方列表分页器
let memPager: Pager | null = null;       // 板块监测下方成分分页器
let tbl: DataTable<BoardRow> | DataTable<ZyBlockRow> | DataTable<IndexBarItem> | null = null;  // #pan-wrap 当前表
let tblKind: "board" | "blocks" | "index" | null = null;      // 当前表实例（切模式重建）
let indexItems: IndexBarItem[] = [];                          // 指数 tab 全量（客户端排序/搜索）
let memTbl: DataTable<BoardRow> | null = null;                // #pan-mem 成分表（一次创建）

/* 盘口语义配色：零轴取符号，涨跌双向通吃（后端已按涨跌方向定值） */
function pctCell(v: number | null | undefined, suffix = "%"): string {
  if (v == null) return `<span style="color:var(--faint)">—</span>`;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "";
  return `<span class="${cls}">${fmtChg(v)}${suffix}</span>`;
}

const BOARD_COLS: DataTableCol<BoardRow>[] = [
  { label: "#", width: 34, mono: true, pri: 3, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "代码", mono: true, pri: 2, sort: "symbol", render: (r) => r.symbol },
  { label: "名称", pri: 1, sort: "name", render: (r) => `<span style="font-weight:600">${esc(r.name || "—")}</span>` },
  { label: "现价", num: true, pri: 1, render: (r) => fmtP(r.current, r.symbol) },
  { label: "涨跌额", num: true, pri: 3, render: (r) => pctCell(r.change_amount, "") },
  { label: "涨跌幅", num: true, pri: 1, sort: "change_rate", render: (r) => pctCell(r.change_rate) },
  { label: "买入", num: true, pri: 3, title: "买一价", render: (r) => fmtP(r.bid1, r.symbol) },
  { label: "卖出", num: true, pri: 3, title: "卖一价", render: (r) => fmtP(r.ask1, r.symbol) },
  { label: "最高", num: true, pri: 2, render: (r) => (r.high != null ? `<span class="up">${fmtP(r.high, r.symbol)}</span>` : "—") },
  { label: "最低", num: true, pri: 2, render: (r) => (r.low != null ? `<span class="down">${fmtP(r.low, r.symbol)}</span>` : "—") },
  { label: "今开", num: true, pri: 3, render: (r) => fmtP(r.open, r.symbol) },
  { label: "昨收", num: true, pri: 3, render: (r) => fmtP(r.pre_close, r.symbol) },
  { label: "成交量", num: true, pri: 3, title: "手", render: (r) => fmtVol(r.volume) },
  { label: "成交额", num: true, pri: 2, sort: "amount", render: (r) => fmtYi(r.amount) },
  { label: "换手%", num: true, pri: 2, sort: "turnover_rate", render: (r) => fmt(r.turnover_rate) },
  { label: "量比", num: true, pri: 2, sort: "vol_ratio", render: (r) => fmt(r.vol_ratio) },
  { label: "振幅%", num: true, pri: 3, sort: "amplitude", render: (r) => fmt(r.amplitude) },
  { label: "流通市值", num: true, pri: 3, render: (r) => fmtYi(r.circ_value) },
  { label: "总市值", num: true, pri: 3, render: (r) => fmtYi(r.market_value) },
  { label: "涨停", num: true, pri: 3, render: (r) => (r.up_limit ? `<span class="up">${fmtP(r.up_limit, r.symbol)}</span>` : "—") },
  { label: "跌停", num: true, pri: 3, render: (r) => (r.down_limit ? `<span class="down">${fmtP(r.down_limit, r.symbol)}</span>` : "—") },
];

/* 板块列表列（zy_blocks 聚合行：均涨/涨跌家数/领涨股/成分数） */
const BLOCK_COLS: DataTableCol<ZyBlockRow>[] = [
  { label: "#", width: 34, mono: true, pri: 3, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "板块名称", pri: 1, sort: "block_code", render: (r) =>
      `<span style="font-weight:600">${esc(r.block_name)}</span>` },
  { label: "子行业", pri: 3, render: (r) => r.children ? `<button class="hbtn" data-children>${r.children}个子级</button>` : "—" },
  { label: "均涨%", num: true, pri: 1, sort: "avg_change", title: "成分涨跌幅平均", render: (r) => pctCell(r.avg_change) },
  { label: "上涨", num: true, pri: 2, render: (r) => (r.up_count ? `<span class="up num">${r.up_count}</span>` : `<span style="color:var(--faint)">0</span>`) },
  { label: "下跌", num: true, pri: 2, render: (r) => (r.down_count ? `<span class="down num">${r.down_count}</span>` : `<span style="color:var(--faint)">0</span>`) },
  { label: "上涨占比", num: true, pri: 1, sort: "up_rate", render: (r) =>
      (r.members ? `${Math.round((r.up_count / r.members) * 100)}%` : "—") },
  { label: "领涨股", pri: 2, render: (r) => (r.leader
      ? `${esc(r.leader)} ${pctCell(r.leader_change, "")}` : `<span style="color:var(--faint)">—</span>`) },
  { label: "成分 / 有行情", num: true, pri: 3, title: "全部成分数量 / 有当日快照的数量", render: (r) => `${r.total_members} / ${r.members}` },
  { label: "成交额", num: true, pri: 2, sort: "amount", render: (r) => fmtYi(r.amount) },
];

/* 当前 sort 参数（"-" 前缀 = 降序）；默认涨跌幅降序（行情习惯） */
function sortOf(t: DataTable<unknown> | null, keys: Record<string, string>,
                dflt: string): string {
  const st = t?.sortState;
  if (st?.label) {
    const key = keys[st.label];
    if (key) return st.dir === -1 ? `-${key}` : key;
  }
  return dflt;
}
const sortParam = () => sortOf(tbl as DataTable<unknown> | null, SORT_KEYS, "-change_rate");
const blockSortParam = () => sortOf(tbl as DataTable<unknown> | null, BLOCK_SORT_KEYS, "-avg_change");
const memberSortParam = () => sortOf(memTbl as DataTable<unknown> | null, SORT_KEYS, "-change_rate");

/* ── 右栏联动：分时（独立 canvas 画法）+ 日K（klinecharts） ── */
let intra: IntradayHandle | null = null;
let klD: ChartPanelHandle | null = null;
let linkSymbol: string | null = null;    // 当前联动标的（同标的点击不重拉）
let linkStock: { symbol: string; name: string } | null = null;  // 分时图头「加自选」用的当前标的
let linkToken = 0;                       // 竞态守卫：快速连点只认最后一次
let autoLink = true;                     // 首次进页 / 切 tab：自动联动第一行，右栏不留空
let navRows: { symbol: string; name: string }[] = [];   // 左表当前行（顺序同 tbody），上下键/双击用
let memRows: { symbol: string; name: string }[] = [];   // 成分股表当前行（双击跳行情页用）
let selIdx = -1;                         // 左表选中行下标（键盘翻阅 + 行高亮）
let listKey = "";                        // 列表身份（tab/页码/排序/搜索）：换列表时清选中
let pendingSel: "first" | "last" | null = null;  // 键盘翻页续选：新一页渲染后选中首/末行

const rowIndexOf = (tr: HTMLElement): number =>
  Array.prototype.indexOf.call(tr.parentElement?.children ?? [], tr);

/** 按 selIdx 重画左表行高亮（30s 轮询重渲染后也要保住选中行） */
function paintSelection(): void {
  document.querySelectorAll<HTMLElement>("#pan-wrap tbody tr").forEach((tr, i) =>
    tr.classList.toggle("sel", i === selIdx));
}

/** 键盘翻页后补选新一页的首/末行（触发行点击，联动右栏） */
function applyPending(): void {
  if (!pendingSel) return;
  const rows = document.querySelectorAll<HTMLElement>("#pan-wrap tbody tr");
  const idx = pendingSel === "first" ? 0 : rows.length - 1;
  pendingSel = null;
  if (idx < 0 || !rows[idx]) return;
  rows[idx].click();
  rows[idx].scrollIntoView({ block: "nearest" });
}

function ensureCharts(): void {
  if (!intra) intra = createIntraday(document.getElementById("pan-kl-t")!);
  if (!klD) {
    // 与行情页 K 线同一个 chartpanel 控件：这里用紧凑配置 ——
    // 只留「日K」标题 + 主图/副图指标开关，头部信息条不渲染（名称代码已在上方分时图头）。
    klD = createChartPanel(document.getElementById("pan-kl-d")!, {
      title: "日K",
      toolbar: { main: ["ma", "mid", "short"], sub: ["vol", "trendhistogram", "macd", "kdj"] },
      initial: { period: "d", main: ["ma", "mid"], sub: ["vol", "trendhistogram"] },
      emptyText: "点击左侧股票查看日K",
    });
  }
}

/* 分时 / 日K 高度：比例存本地，拖动中间分隔条调整（默认分时矮一些） */
const SPLIT_KEY = "yc_pan_split";
let splitRatio = 0.38;
try {
  const v = Number(localStorage.getItem(SPLIT_KEY));
  if (v > 0.15 && v < 0.85) splitRatio = v;
} catch { /* 忽略 */ }

function applySplit(): void {
  const t = document.getElementById("pan-box-t");
  const d = document.getElementById("pan-box-d");
  if (!t || !d) return;
  t.style.flex = `${splitRatio} 1 0`;
  d.style.flex = `${1 - splitRatio} 1 0`;
}

let splitBound = false;
function setupSplit(): void {
  applySplit();
  if (splitBound) return;
  splitBound = true;
  const grip = document.getElementById("pan-hsplit")!;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const t = document.getElementById("pan-box-t")!;
    const d = document.getElementById("pan-box-d")!;
    const h0 = t.getBoundingClientRect().height;
    const total = h0 + d.getBoundingClientRect().height;
    const y0 = e.clientY;
    grip.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const px = Math.min(total - 100, Math.max(100, h0 + ev.clientY - y0));
      splitRatio = px / total;
      applySplit();
      intra?.resize();
      klD?.resize();
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      localStorage.setItem(SPLIT_KEY, splitRatio.toFixed(3));
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  });
}

/* 分时图头右上角「加自选」：空心=未收藏，实心=已收藏（点开分组面板） */
function updatePanWatch(): void {
  const b = document.getElementById("pan-watch");
  if (!b) return;
  const on = !!linkStock && isWatched(linkStock.symbol);
  b.classList.toggle("on", on);
  b.title = on ? "已自选 · 点击管理分组" : "加入自选";
  b.innerHTML = ic(on ? "heart-filled" : "heart", 13);
}

/** 行点击 → 右侧分时+日K 联动（页内，不跳详情页） */
async function setLink(symbol: string, name: string,
                       row?: { current?: number | null; change_rate?: number | null }): Promise<void> {
  ensureCharts();
  linkStock = { symbol, name: name || symbol };
  updatePanWatch();
  const head = document.getElementById("pan-link-name")!;
  const code = document.getElementById("pan-link-code")!;
  const quote = document.getElementById("pan-link-quote")!;
  head.textContent = name || symbol;
  code.textContent = symbol;
  quote.innerHTML = row && row.current != null
    ? `${fmtP(row.current, symbol)} <b class="${(row.change_rate ?? 0) > 0 ? "up" : (row.change_rate ?? 0) < 0 ? "down" : ""}">${fmtChg(row.change_rate ?? 0)}%</b>`
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
    // 日K：默认 MA + 中线操盘通道（MA35/45）主图；量 + 趋势柱线副图。
    // 趋势柱线公式只依赖 OHLC，个股/指数/基金 K 线都有，故三类标的均显示。
    // 指标开关由面板控制条管理，换标的只重灌数据，不重置用户选择。
    klD!.setData(klRes.value.bars ?? [], false, null, undefined, symbol);
  }
  if (miRes.status === "fulfilled") {
    // 分时：左涨跌幅轴 + 右价格轴 + 昨收虚线 + 均价线 + VOLFS 逐分钟量柱
    intra!.setData(miRes.value);
  } else {
    intra!.setMessage("盘中分时暂时取不到（日线正常）");
    quote.innerHTML = `<span style="color:var(--faint)">盘中分时暂时取不到（日线正常）</span>`;
  }
}

/** #pan-wrap 表实例按模式重建（股票表 / 板块清单列不同，容器复用） */
function ensureTable(): void {
  const want = tab === "block" ? "blocks" : tab === "index" ? "index" : "board";
  document.getElementById("pan-pager")!.style.display = want === "index" ? "none" : "";
  if (tblKind === want && tbl) return;
  const wrap = document.getElementById("pan-wrap")!;
  wrap.innerHTML = "";
  tblKind = want;
  if (want === "index") {
    tbl = createDataTable<IndexBarItem>(wrap, INDEX_COLS, {
      tblKey: "pan-index", defaultSort: { label: "涨跌幅", dir: -1 },
      onChange: () => {
        const t = tbl as unknown as DataTable<IndexBarItem>;
        t.render(t.sort(indexItems), 0);
      },
      onRow: (it, _ev, tr) => {
        selIdx = rowIndexOf(tr);
        paintSelection();
        if (it.current != null) void setLink(it.symbol, it.name, it);
      },
    });
  } else if (want === "blocks") {
    tbl = createDataTable<ZyBlockRow>(wrap, BLOCK_COLS, {
      tblKey: "pan-blocks", defaultSort: { label: "均涨%", dir: -1 },
      onChange: () => { blkPager!.reset(); void loadBlocks(); },
      onRow: (r, ev, tr) => {
        if ((ev.target as HTMLElement).closest("[data-children]")) {
          blockParent = { code: r.block_code, name: r.block_name };
          curBlock = null; autoLink = true; blkPager?.reset(); syncHead(); void loadBlocks(); return;
        }
        selIdx = rowIndexOf(tr); selectBlock(r.block_code, r.block_name);
      },
      rowKey: (r) => r.block_code,
    });
    ensureMemberTable();
  } else {
    tbl = createDataTable<BoardRow>(wrap, BOARD_COLS, {
      tblKey: "pan-board", defaultSort: { label: "涨跌幅", dir: -1 },
      onChange: () => { pager!.reset(); void load(); },
      onRow: (r, _ev, tr) => { selIdx = rowIndexOf(tr); paintSelection(); void setLink(r.symbol, r.name || r.symbol, r); },
      rowKey: (r) => r.symbol,
    });
  }
}

/** 板块监测下半区：成分表（常驻，选板块后换数据） */
function ensureMemberTable(): void {
  if (memTbl) return;
  memPager = createPager(document.getElementById("pan-mem-pager")!, "panorama_mem",
                         () => void loadMembers());
  memTbl = createDataTable<BoardRow>(document.getElementById("pan-mem")!, BOARD_COLS, {
    tblKey: "pan-mem", defaultSort: { label: "涨跌幅", dir: -1 },
    onChange: () => { memPager!.reset(); void loadMembers(); },
    onRow: (r) => void setLink(r.symbol, r.name || r.symbol, r),
    rowKey: (r) => r.symbol,
    empty: "该板块暂无已导入的成分股",
  });
}

/** 板块监测：上方选中板块 → 下方换成该板块成分 */
function selectBlock(code: string, name: string): void {
  curBlock = { code, name };
  memPager?.reset();
  markSelectedBlock();
  void loadMembers();
}

/** 上方列表中把当前选中板块行标出来 */
function markSelectedBlock(): void {
  let idx = -1;
  document.querySelectorAll<HTMLElement>("#pan-wrap tbody tr").forEach((tr, i) => {
    if (tr.dataset.key === curBlock?.code) idx = i;
  });
  selIdx = idx;
  paintSelection();
}

/** 页头控件可见性随模式切换（类型 seg / 成分区） */
function syncHead(): void {
  const inBlocks = tab === "block";
  document.getElementById("pan-btypes")!.hidden = !inBlocks;
  document.getElementById("pan-members")!.hidden = !inBlocks;
  // 搜索统一走顶栏（结果选中即直达详情页），本页不再保留筛选框
  const back = document.getElementById("pan-parent") as HTMLButtonElement;
  back.hidden = !inBlocks || !blockParent;
  back.textContent = blockParent ? `← 一级行业 · ${blockParent.name}` : "";
}

async function load(): Promise<void> {
  if (tab === "block") { void loadBlocks(); return; }
  if (tab === "index") { void loadIndices(); return; }
  const count = document.getElementById("pan-count")!;
  try {
    if (!pager) pager = createPager(document.getElementById("pan-pager")!, "panorama", () => void load());
    ensureTable();
    const r = await marketApi.board({
      tab, sort: sortParam(), page: pager.page, size: pager.size,
    });
    const key = `${tab}|${pager.page}|${sortParam()}`;
    if (key !== listKey) { listKey = key; selIdx = -1; }
    pager.update(r.total);
    (tbl as DataTable<BoardRow>).render(r.items, (pager.page - 1) * pager.size);
    navRows = r.items.map((it) => ({ symbol: it.symbol, name: it.name || it.symbol }));
    // 首次进页 / 切 tab：自动联动第一行，右栏分时+日K 不留空
    if (autoLink && r.items.length) {
      autoLink = false;
      selIdx = 0;
      void setLink(r.items[0].symbol, r.items[0].name || r.items[0].symbol, r.items[0]);
    }
    paintSelection();                     // 轮询重渲染 / 从行情页返回：保住选中行
    applyPending();                       // 键盘翻到页尾：新一页首行自动接上
    count.textContent = `共 ${r.total} 只`;
    document.getElementById("pan-asof")!.textContent = r.as_of ? `数据时间 ${r.as_of}` : "";
    document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
  } catch {
    count.textContent = "加载失败";
  }
}

/** 板块监测上半区：类型清单（概念/行业/…）；无选中时自动选第一条 */
async function loadBlocks(): Promise<void> {
  const revision = ++blockRevision;
  const count = document.getElementById("pan-count")!;
  try {
    if (!blkPager) blkPager = createPager(document.getElementById("pan-pager")!, "panorama_blocks", () => void loadBlocks());
    ensureTable();
    const r = await marketApi.zyBlocks({
      type_code: blockType, sort: blockSortParam(), page: blkPager.page, size: blkPager.size,
      parent_code: blockParent?.code,
    });
    if (revision !== blockRevision || tab !== "block") return;
    blkPager.update(r.total);
    (tbl as DataTable<ZyBlockRow>).render(r.items, (blkPager.page - 1) * blkPager.size);
    navRows = [];                             // 板块行不是个股：双击不跳详情
    count.textContent = `共 ${r.total} 个板块`;
    document.getElementById("pan-asof")!.textContent = r.as_of ? `数据时间 ${r.as_of}` : "";
    document.getElementById("pan-empty")!.style.display = r.total ? "none" : "grid";
    if (!curBlock && r.items.length) {        // 进板块页/切类型：默认选中首条，下方不空
      selectBlock(r.items[0].block_code, r.items[0].block_name);
    } else if (curBlock) {
      void loadMembers();                     // 30s 轮询同步刷新下方成分
    } else {
      ensureMemberTable();
      memTbl!.render([], 0);
      memPager?.update(0);
    }
    markSelectedBlock();
    applyPending();                           // 键盘翻到页尾：新一页首行自动接上
  } catch {
    if (revision !== blockRevision || tab !== "block") return;
    count.textContent = "加载失败";
  }
}

/** 板块监测下半区：选中板块的成分股（行点击 → 右栏分时/日K 联动） */
async function loadMembers(): Promise<void> {
  const revision = ++memberRevision;
  ensureMemberTable();
  const title = document.getElementById("pan-mem-title")!;
  const count = document.getElementById("pan-mem-count")!;
  if (!curBlock) {
    memTbl!.render([], 0);
    memPager?.update(0);
    memRows = [];
    title.textContent = "成分股";
    count.textContent = "";
    return;
  }
  try {
    const code = curBlock.code;
    const r = await marketApi.zyBlockMembers(curBlock.code, {
      sort: memberSortParam(), page: memPager!.page, size: memPager!.size,
    });
    if (revision !== memberRevision || curBlock?.code !== code || tab !== "block") return;
    memPager!.update(r.total);
    memTbl!.render(r.items, (memPager!.page - 1) * memPager!.size);
    memRows = r.items.map((it) => ({ symbol: it.symbol, name: it.name || it.symbol }));
    title.textContent = `成分股 · ${curBlock.name}`;
    count.textContent = `共 ${r.total} 只`;
    if (autoLink && r.items.length) {
      autoLink = false;
      void setLink(r.items[0].symbol, r.items[0].name || r.items[0].symbol, r.items[0]);
    }
  } catch {
    if (revision !== memberRevision || tab !== "block") return;
    count.textContent = "加载失败";
  }
}

/* 指数 tab：INDEX_CATALOG × 当日快照，客户端排序（数据量小，不分页） */
const INDEX_COLS: DataTableCol<IndexBarItem>[] = [
  { label: "#", width: 34, mono: true, pri: 3, render: (_r, i) => `<span style="color:var(--faint)">${i + 1}</span>` },
  { label: "名称", pri: 1, sort: "name", render: (r) => `<span style="font-weight:600">${esc(r.name)}</span>` },
  { label: "代码", mono: true, pri: 3, sort: "symbol", render: (r) => r.symbol },
  { label: "现价", num: true, pri: 1, sort: "current", render: (r) => fmt(r.current) },
  { label: "涨跌额", num: true, pri: 3, sort: "change_amount", render: (r) => pctCell(r.change_amount, "") },
  { label: "涨跌幅", num: true, pri: 1, sort: "change_rate", render: (r) => pctCell(r.change_rate) },
  { label: "成交额", num: true, pri: 2, sort: "amount", render: (r) => fmtYi(r.amount) },
];

async function loadIndices(): Promise<void> {
  const count = document.getElementById("pan-count")!;
  try {
    ensureTable();
    indexItems = await marketApi.indexBar();
    const t = tbl as unknown as DataTable<IndexBarItem>;
    const rows = t.sort(indexItems);
    const key = "index";
    if (key !== listKey) { listKey = key; selIdx = -1; }
    t.render(rows, 0);
    navRows = rows.map((it) => ({ symbol: it.symbol, name: it.name }));
    if (autoLink && rows.length) {          // 切到指数 tab：联动第一个指数
      autoLink = false;
      selIdx = 0;
      void setLink(rows[0].symbol, rows[0].name, rows[0]);
    }
    paintSelection();
    applyPending();
    count.textContent = `共 ${rows.length} 个指数`;
    document.getElementById("pan-asof")!.textContent = "";
    document.getElementById("pan-empty")!.style.display = rows.length ? "none" : "grid";
  } catch {
    count.textContent = "加载失败";
  }
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
}

export function loadPanorama(): void {
  ensureCharts();
  setupSplit();
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
  document.getElementById("pan-parent")!.addEventListener("click", () => {
    blockParent = null; curBlock = null; autoLink = true; blkPager?.reset(); syncHead(); void loadBlocks();
  });
  document.getElementById("pan-refresh")!.addEventListener("click", loadAll);
  // 分时图头右上角「加自选」：未收藏→加默认分组；已收藏→打开分组面板（改组/移出）
  document.getElementById("pan-watch")!.addEventListener("click", () => {
    const s = linkStock;
    if (!s) return;
    if (isWatched(s.symbol)) { openWatchPanel(s.symbol, s.name); return; }
    addWatch(s.symbol, s.name, "默认");
    toast("已加入自选 · 默认");
    updatePanWatch();
  });
  subscribe(updatePanWatch);              // 其它页面增删自选后同步星标
  document.getElementById("pan-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-t]");
    if (!b) return;
    tab = b.dataset.t as Tab;
    document.querySelectorAll<HTMLElement>("#pan-tabs button").forEach((x) =>
      x.classList.toggle("on", x === b));
    pager?.reset();
    blkPager?.reset();
    autoLink = true;                      // 切 tab 后右栏跟随新 tab 第一行
    selIdx = -1;
    listKey = "";
    navRows = [];
    tbl = null; tblKind = null;           // 切 tab 重建表（板块/股票列不同）
    syncHead();
    void load();
  });
  document.getElementById("pan-btypes")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-bt]");
    if (!b) return;
    blockType = Number(b.dataset.bt);
    blockParent = null; autoLink = true;
    curBlock = null;                      // 换类型：清选中，下方自动跟首条
    document.querySelectorAll<HTMLElement>("#pan-btypes button").forEach((x) =>
      x.classList.toggle("on", x === b));
    blkPager?.reset();
    void loadBlocks();
  });

  // 上下键翻阅左表 → 行选中 + 右栏联动（输入框内不抢键；到页尾翻页续选）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!document.getElementById("page-panorama")?.classList.contains("on")) return;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const rows = document.querySelectorAll<HTMLElement>("#pan-wrap tbody tr");
    if (!rows.length) return;
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const cur = selIdx >= 0 && selIdx < rows.length ? selIdx : -1;
    if (cur < 0) {
      const i = dir > 0 ? 0 : rows.length - 1;
      rows[i].click();
      rows[i].scrollIntoView({ block: "nearest" });
      return;
    }
    const next = cur + dir;
    if (next < 0 || next >= rows.length) {
      // 页尾/页首：翻页并在新页渲染后自动选中接续行
      const pagerEl = document.getElementById("pan-pager")!;
      if (pagerEl.style.display === "none") return;      // 指数 tab 无分页
      const btn = pagerEl.querySelector<HTMLButtonElement>(
        `button[data-a="${dir > 0 ? "next" : "prev"}"]:not([disabled])`);
      if (!btn) return;
      pendingSel = dir > 0 ? "first" : "last";
      btn.click();
      return;
    }
    rows[next].click();                    // 复用行点击：选中高亮 + setLink / selectBlock
    rows[next].scrollIntoView({ block: "nearest" });
  });

  // 双击个股行 → 进行情页（第一个菜单）；带来源标记，行情页「返回」可回全景
  document.getElementById("pan-wrap")!.addEventListener("dblclick", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tbody tr");
    if (!tr) return;
    const row = navRows[rowIndexOf(tr)];
    if (!row) return;                      // 板块/空态行：无个股可跳
    selIdx = rowIndexOf(tr);
    paintSelection();
    document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: row.symbol, name: row.name, from: { page: "panorama", label: "全景" } },
    }));
  });

  // 板块监测下方「成分股」表：双击个股同样进行情页
  document.getElementById("pan-mem")!.addEventListener("dblclick", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tbody tr");
    if (!tr) return;
    const row = memRows[rowIndexOf(tr)];
    if (!row) return;
    document.dispatchEvent(new CustomEvent("yc:open-stock", {
      detail: { symbol: row.symbol, name: row.name, from: { page: "panorama", label: "全景" } },
    }));
  });
}
