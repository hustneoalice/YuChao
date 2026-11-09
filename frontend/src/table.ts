/* 通用可排序表格：表头/单元格一套控件，列可排序（空值恒排最后），行点击回调。
 * 列设置：传入 tblKey 即启用「列设置」齿轮（表头最右），支持隐藏/顺序持久化，
 *         面板内拖拽调整列顺序（拖到目标行上/下位置），配置存 localStorage。
 * 与 pager 配合：sort(全量) → slicePage(当前页) → render(页数据, 起始序号)。
 * 用法：
 *   const tbl = createDataTable(wrap, cols, { tblKey: "watch", onChange: rerender, onRow, empty });
 *   const all = tbl.sort(rows);            // 点表头后 onChange 里重新 sort
 *   tbl.render(pageRows, start);           // 只负责画当前页 */
import { esc } from "./fmt";
import { ic } from "./icons";

export interface DataTableCol<T> {
  key?: string;             // 稳定标识（列配置持久化用）；缺省用 label
  label: string;
  num?: boolean;    // 数字列：右对齐 + 等宽（th.n / td.n.num）
  mono?: boolean;   // td 追加等宽字体（代码/序号）
  width?: number;
  title?: string;
  sort?: string | ((row: T) => number | string | null | undefined);  // 属性名或取值函数；不传=不可排
  render: (row: T, i: number) => string;
}

export interface DataTable<T> {
  sort(rows: T[]): T[];
  render(rows: T[], startIndex?: number): void;
  resetSort(): void;
  /* 当前表头排序态（label + dir）。服务端分页表用：onChange 里读它
   * 换算成 sort 参数重新请求；客户端全量排序表用不到。 */
  readonly sortState: { label: string | null; dir: 1 | -1 };
}

/* ── 列配置持久化：yc_tblcols = { [tblKey]: { hidden: string[], order: string[] } } ── */
const STORE_KEY = "yc_tblcols";
type ColCfg = { hidden: string[]; order: string[] };
type ColStore = Record<string, ColCfg>;

function loadStore(): ColStore {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") as ColStore; } catch { return {}; }
}
function saveStore(store: ColStore): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* 忽略 */ }
}
const keyOf = <T,>(c: DataTableCol<T>): string => c.key ?? c.label;

/* 同一时刻最多一个列设置面板打开：全局只挂一次文档级监听，避免表格反复重建时泄漏 */
let activePop: {
  pop: HTMLDivElement; btn: HTMLButtonElement | null;
  place: () => void; close: () => void;
} | null = null;
document.addEventListener("pointerdown", (e) => {
  const a = activePop;
  if (!a || a.pop.hidden) return;
  const t = e.target as Node;
  const gear = (e.target as HTMLElement).closest<HTMLButtonElement>("th.cgear button");
  if (!a.pop.contains(t) && gear !== a.btn) a.close();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const a = activePop;
  if (a && !a.pop.hidden) { e.stopPropagation(); a.close(); }
}, true);

export function createDataTable<T>(
  wrap: HTMLElement,
  cols: DataTableCol<T>[],
  opts: {
    tblKey?: string;                                  // 传了才启用列设置（各表唯一）
    defaultSort?: { label: string; dir: 1 | -1 };
    onChange?: () => void;                            // 点表头后回调（页面重渲染）
    onRow?: (row: T, ev: MouseEvent, tr: HTMLElement) => void;
    empty?: string;
    rowKey?: (row: T) => string;                      // 行标识 → tr[data-key]，hover 预取用
  } = {},
): DataTable<T> {
  let sortLabel: string | null = opts.defaultSort?.label ?? null;
  let sortDir: 1 | -1 = opts.defaultSort?.dir ?? -1;
  const tblKey = opts.tblKey;
  let cfg: ColCfg = { hidden: [], order: [] };
  let lastRows: T[] | null = null;
  let lastStart = 0;
  if (tblKey) {
    const saved = loadStore()[tblKey];
    if (saved) cfg = { hidden: [...(saved.hidden ?? [])], order: [...(saved.order ?? [])] };
  }

  function persistCfg(): void {
    if (!tblKey) return;
    const store = loadStore();
    if (!cfg.hidden.length && !cfg.order.length) delete store[tblKey];
    else store[tblKey] = { hidden: cfg.hidden, order: cfg.order };
    saveStore(store);
  }

  /** 完整列序：保存的 order 先行，未参与排序的列按原相对顺序补齐（容忍列增删/列名变） */
  function fullOrder(): DataTableCol<T>[] {
    if (!cfg.order.length) return cols;
    const byKey = new Map(cols.map((c) => [keyOf(c), c]));
    const ordered = cfg.order.map((k) => byKey.get(k)).filter(Boolean) as DataTableCol<T>[];
    const rest = cols.filter((c) => !cfg.order.includes(keyOf(c)));
    return [...ordered, ...rest];
  }
  function effCols(): DataTableCol<T>[] {
    const hidden = new Set(cfg.hidden.filter((k) => cols.some((c) => keyOf(c) === k)));
    return fullOrder().filter((c) => !hidden.has(keyOf(c)));
  }

  function sort(rows: T[]): T[] {
    const c = cols.find((x) => x.label === sortLabel && x.sort != null);
    if (!c) return rows;
    const get = (r: T): number | string | null => {
      if (typeof c.sort === "function") return c.sort(r) ?? null;
      const v = (r as Record<string, unknown>)[c.sort as string];
      return v == null ? null : typeof v === "number" ? v : String(v);
    };
    return rows.slice().sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const d = typeof va === "number" && typeof vb === "number"
        ? va - vb : String(va).localeCompare(String(vb), "zh");
      return d * sortDir;
    });
  }

  /* ── 列设置浮层（惰性创建一次，挂在 body 上不被表格滚动容器裁剪）── */
  let pop: HTMLDivElement | null = null;
  let gearBtn: HTMLButtonElement | null = null;

  function ensurePop(): HTMLDivElement {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "vpop colgear-pop";
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "列设置");
    pop.innerHTML = `<div class="vpop-head"><b>列设置</b><span class="sp"></span>
        <button type="button" class="vpop-x" aria-label="关闭">${ic("x", 11)}</button></div>
      <div class="vpop-body"><ul class="cg-list"></ul></div>
      <div class="vpop-foot">
        <button type="button" class="cg-clear">全部显示</button>
        <span class="sp"></span>
        <button type="button" class="cg-reset">恢复默认</button>
      </div>`;
    document.body.appendChild(pop);
    pop.querySelector(".vpop-x")!.addEventListener("click", () => closePop());

    const list = pop.querySelector<HTMLElement>(".cg-list")!;
    /* 拖拽换序：拖到目标行的上半/下半决定插前/插后，松手持久化 */
    list.addEventListener("dragstart", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLLIElement>("li");
      if (!li) return;
      li.classList.add("drag");
      (e as DragEvent).dataTransfer?.setData("text/plain", li.dataset.k ?? "");
    });
    list.addEventListener("dragover", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLLIElement>("li");
      const drag = list.querySelector<HTMLLIElement>("li.drag");
      if (!target || !drag || target === drag) return;
      e.preventDefault();
      const r = target.getBoundingClientRect();
      if ((e as DragEvent).clientY < r.top + r.height / 2) list.insertBefore(drag, target);
      else list.insertBefore(drag, target.nextSibling);
    });
    list.addEventListener("dragend", () => {
      list.querySelectorAll("li.drag").forEach((li) => li.classList.remove("drag"));
      cfg.order = [...list.querySelectorAll<HTMLLIElement>("li")].map((li) => li.dataset.k ?? "");
      persistCfg();
      rerender();
    });
    /* 勾选切换显示/隐藏 */
    list.addEventListener("click", (e) => {
      const cb = (e.target as HTMLElement).closest<HTMLInputElement>("input[type=checkbox]");
      if (!cb) return;
      const hidden = new Set(cfg.hidden);
      if (cb.checked) hidden.delete(cb.dataset.k ?? "");
      else hidden.add(cb.dataset.k ?? "");
      cfg.hidden = [...hidden];
      persistCfg();
      rerender();
    });
    pop.querySelector(".cg-clear")!.addEventListener("click", () => {
      cfg.hidden = [];
      persistCfg();
      paintList();
      rerender();
    });
    pop.querySelector(".cg-reset")!.addEventListener("click", () => {
      cfg = { hidden: [], order: [] };
      persistCfg();
      paintList();
      rerender();
    });
    return pop;
  }

  function paintList(): void {
    const list = pop!.querySelector<HTMLElement>(".cg-list")!;
    const hidden = new Set(cfg.hidden);
    list.innerHTML = fullOrder().map((c) => {
      const k = keyOf(c);
      return `<li draggable="true" data-k="${esc(k)}"><span class="cg-hand" aria-hidden="true">${ic("dots-six-vertical", 12)}</span>
        <input type="checkbox" data-k="${esc(k)}" ${hidden.has(k) ? "" : "checked"}>
        <span class="cg-lb">${esc(c.label || c.key)}</span></li>`;
    }).join("");
  }

  function placePop(): void {
    if (!pop || pop.hidden || !gearBtn) return;
    const b = gearBtn.getBoundingClientRect();
    pop.style.maxHeight = "";
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const edge = 8, gap = 6;
    const below = window.innerHeight - b.bottom - gap - edge;
    const above = b.top - gap - edge;
    const up = h > below && above > below;
    const room = up ? above : below;
    const left = Math.max(edge, Math.min(b.right - w, window.innerWidth - w - edge));
    const top = up ? Math.max(edge, b.top - gap - Math.min(h, room)) : b.bottom + gap;
    if (h > room) pop.style.maxHeight = `${Math.max(120, room)}px`;
    pop.classList.toggle("up", up);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function openPop(): void {
    ensurePop();
    paintList();
    pop!.hidden = false;
    gearBtn?.classList.add("on");
    gearBtn?.setAttribute("aria-expanded", "true");
    activePop = { pop: pop!, btn: gearBtn, place: placePop, close: closePop };
    const settle = (): void => { placePop(); requestAnimationFrame(placePop); };
    requestAnimationFrame(settle);
  }
  function closePop(): void {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    gearBtn?.classList.remove("on");
    gearBtn?.setAttribute("aria-expanded", "false");
    if (activePop?.pop === pop) activePop = null;
  }
  const togglePop = (): void => { if (pop && !pop.hidden) closePop(); else openPop(); };

  function rerender(): void {
    if (!lastRows) return;
    render(lastRows, lastStart);
    if (pop && !pop.hidden) requestAnimationFrame(placePop);
  }

  function render(rows: T[], startIndex = 0): void {
    lastRows = rows;
    lastStart = startIndex;
    const shown = effCols();
    const ths = shown.map((c) => {
      const style = [c.width ? `width:${c.width}px` : "",
        c.sort != null ? "cursor:pointer" : ""].filter(Boolean).join(";");
      const arrow = c.sort != null && sortLabel === c.label ? (sortDir === -1 ? " ▾" : " ▴") : "";
      return `<th${c.num ? ' class="n"' : ""}${style ? ` style="${style}"` : ""}` +
        `${c.title ? ` title="${esc(c.title)}"` : ""}` +
        `${c.sort != null ? ` data-sort="${esc(c.label)}"` : ""}>${esc(c.label)}${arrow}</th>`;
    }).join("");
    const gearTh = tblKey
      ? `<th class="cgear"><button type="button" class="cg-btn" title="列设置"
          aria-label="列设置" aria-haspopup="dialog" aria-expanded="false">${ic("gear", 13)}</button></th>` : "";
    const body = rows.map((row, i) => {
      const rk = opts.rowKey ? opts.rowKey(row) : "";
      return `<tr${rk ? ` data-key="${esc(rk)}"` : ""}>${shown.map((c) =>
        `<td${c.num ? ' class="n num"' : c.mono ? ' class="num"' : ""}>${c.render(row, startIndex + i)}</td>`).join("")}</tr>`;
    }).join("");
    const colspan = shown.length + (tblKey ? 1 : 0);
    const emptyRow = opts.empty && rows.length === 0
      ? `<tr><td colspan="${colspan}" style="text-align:center;color:var(--faint)">${esc(opts.empty)}</td></tr>` : "";
    wrap.innerHTML = `<table><thead><tr>${ths}${gearTh}</tr></thead><tbody>${body || emptyRow}</tbody></table>`;

    wrap.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort!;
        if (sortLabel === k) sortDir = (sortDir * -1) as 1 | -1;   // 再点切换升降
        else { sortLabel = k; sortDir = -1; }                      // 首点降序（涨幅习惯）
        render(rows, startIndex);                                  // 箭头即时反馈
        opts.onChange?.();
      }));
    if (tblKey) {
      gearBtn = wrap.querySelector<HTMLButtonElement>("th.cgear button");
      gearBtn?.addEventListener("click", (e) => { e.stopPropagation(); togglePop(); });
    }
    if (opts.onRow && rows.length) {
      const map = new Map(rows.map((r, i) => [i, r]));
      wrap.querySelectorAll<HTMLElement>("tbody tr").forEach((tr, i) =>
        tr.addEventListener("click", (ev) => {
          const row = map.get(i);
          if (row) opts.onRow!(row, ev, tr);
        }));
    }
  }

  return {
    sort,
    render,
    resetSort() { sortLabel = null; sortDir = -1; },
    get sortState() { return { label: sortLabel, dir: sortDir }; },
  };
}
