/* 通用列表分页：首页/上一页/页码/每页条数(可设，localStorage 记忆)/下一页/尾页。
 * 全列表一套设计。用法：
 *   const p = createPager(el, "key", rerender);
 *   rerender() { p.update(total); rows = slicePage(p, all); ... }   // 每次渲染先收敛页码再切片
 */
const SIZES = [20, 50, 100, 200];

export interface Pager {
  readonly page: number;
  readonly size: number;
  update(total: number): void;
  reset(): void;
}

export function createPager(el: HTMLElement, key: string, onChange: () => void): Pager {
  const sizeKey = `yc_pg_${key}`;
  const saved = Number(localStorage.getItem(sizeKey));
  let size = SIZES.includes(saved) ? saved : 50;
  let page = 1;
  let total = 0;
  const pages = () => Math.max(1, Math.ceil(total / size));

  function draw(): void {
    page = Math.min(Math.max(1, page), pages());
    if (total === 0) { el.innerHTML = ""; return; }
    const dis = (cond: boolean) => (cond ? "disabled" : "");
    el.innerHTML =
      `<button class="hbtn pg-b" data-a="first" ${dis(page <= 1)}>首页</button>` +
      `<button class="hbtn pg-b" data-a="prev" ${dis(page <= 1)}>上一页</button>` +
      `<span class="pg-info">第 ${page} / ${pages()} 页 · 共 ${total} 条</span>` +
      `<span class="pg-info">每页</span>` +
      `<select class="pg-size" title="每页条数">${SIZES.map((s) =>
        `<option value="${s}"${s === size ? " selected" : ""}>${s}</option>`).join("")}</select>` +
      `<button class="hbtn pg-b" data-a="next" ${dis(page >= pages())}>下一页</button>` +
      `<button class="hbtn pg-b" data-a="last" ${dis(page >= pages())}>尾页</button>`;
    el.querySelectorAll<HTMLButtonElement>(".pg-b").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "first") page = 1;
        else if (a === "prev") page -= 1;
        else if (a === "next") page += 1;
        else if (a === "last") page = pages();
        draw();
        onChange();
      }));
    el.querySelector<HTMLSelectElement>(".pg-size")!.addEventListener("change", (e) => {
      size = Number((e.target as HTMLSelectElement).value);
      localStorage.setItem(sizeKey, String(size));
      page = 1;
      draw();
      onChange();
    });
  }

  return {
    get page() { return page; },
    get size() { return size; },
    update(t) { total = t; draw(); },
    reset() { page = 1; },
  };
}

/* 当前页切片（渲染函数里在 pager.update 之后调用） */
export function slicePage<T>(p: Pager, rows: T[]): T[] {
  return rows.slice((p.page - 1) * p.size, p.page * p.size);
}
