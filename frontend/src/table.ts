/* 通用可排序表格：表头/单元格一套控件，列可排序（空值恒排最后），行点击回调。
 * 与 pager 配合：sort(全量) → slicePage(当前页) → render(页数据, 起始序号)。
 * 用法：
 *   const tbl = createDataTable(wrap, cols, { onChange: rerender, onRow, empty });
 *   const all = tbl.sort(rows);            // 点表头后 onChange 里重新 sort
 *   tbl.render(pageRows, start);           // 只负责画当前页 */
import { esc } from "./fmt";

export interface DataTableCol<T> {
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
}

export function createDataTable<T>(
  wrap: HTMLElement,
  cols: DataTableCol<T>[],
  opts: {
    defaultSort?: { label: string; dir: 1 | -1 };
    onChange?: () => void;                                    // 点表头后回调（页面重渲染）
    onRow?: (row: T, ev: MouseEvent, tr: HTMLElement) => void;
    empty?: string;
    rowKey?: (row: T) => string;                              // 行标识 → tr[data-key]，hover 预取用
  } = {},
): DataTable<T> {
  let sortLabel: string | null = opts.defaultSort?.label ?? null;
  let sortDir: 1 | -1 = opts.defaultSort?.dir ?? -1;

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

  function render(rows: T[], startIndex = 0): void {
    const ths = cols.map((c) => {
      const style = [c.width ? `width:${c.width}px` : "",
        c.sort != null ? "cursor:pointer" : ""].filter(Boolean).join(";");
      const arrow = c.sort != null && sortLabel === c.label ? (sortDir === -1 ? " ▾" : " ▴") : "";
      return `<th${c.num ? ' class="n"' : ""}${style ? ` style="${style}"` : ""}` +
        `${c.title ? ` title="${esc(c.title)}"` : ""}` +
        `${c.sort != null ? ` data-sort="${esc(c.label)}"` : ""}>${esc(c.label)}${arrow}</th>`;
    }).join("");
    const body = rows.map((row, i) => {
      const rk = opts.rowKey ? opts.rowKey(row) : "";
      return `<tr${rk ? ` data-key="${esc(rk)}"` : ""}>${cols.map((c) =>
        `<td${c.num ? ' class="n num"' : c.mono ? ' class="num"' : ""}>${c.render(row, startIndex + i)}</td>`).join("")}</tr>`;
    }).join("");
    const emptyRow = opts.empty && rows.length === 0
      ? `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--faint)">${esc(opts.empty)}</td></tr>` : "";
    wrap.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${body || emptyRow}</tbody></table>`;

    wrap.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort!;
        if (sortLabel === k) sortDir = (sortDir * -1) as 1 | -1;   // 再点切换升降
        else { sortLabel = k; sortDir = -1; }                      // 首点降序（涨幅习惯）
        render(rows, startIndex);                                  // 箭头即时反馈
        opts.onChange?.();
      }));
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
  };
}
