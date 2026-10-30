/* 共享标的搜索（顶栏 / 添加自选弹窗统一入口）：
   模糊搜索（后端 代码/名称/拼音缩写/全拼）+ 搜索历史（最近 10 条，可清空）+ 涨跌幅回填。
   交互对齐主流键盘精灵：聚焦/空输入显示历史，点击项保存历史并回调。 */
import { marketApi, type SearchHit } from "./api";
import { fmtChg } from "./fmt";

export interface PickHit { symbol: string; name?: string }

const HKEY = "yc_search_history";   // 顶栏历史沿用同一键：所有入口共享最近搜索

export function loadHist(): PickHit[] {
  try { return JSON.parse(localStorage.getItem(HKEY) || "[]") as PickHit[]; } catch { return []; }
}
export function saveHist(u: PickHit): void {
  const list = loadHist().filter((x) => x.symbol !== u.symbol);
  list.unshift({ symbol: u.symbol, name: u.name });
  localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 10)));
}
export function clearHist(): void {
  localStorage.removeItem(HKEY);
}

/* 涨跌幅会话级缓存：多入口共享，避免同一标的重复请求 */
const chgCache = new Map<string, number | null>();

export interface StockSearchOpts {
  input: HTMLInputElement;
  list: HTMLElement;                          // 结果容器
  onPick: (u: PickHit) => void;               // 点击行（保存历史后回调）
  limit?: number;
  /* 行尾自定义区（如「+ 加入」按钮）；返回 HTML 插入行尾，点击经 onTail 委托 */
  tail?: (u: SearchHit) => string;
  onTail?: (u: PickHit, btn: HTMLElement) => void;
  /* 顶栏下拉式显隐（.on 类）；弹窗内列表常显则不传 */
  setVisible?: (v: boolean) => void;
  /* 下拉显隐时的外点关闭判定范围选择器（如 ".gsearch"） */
  scope?: string;
}

export interface StockSearchHandle { redraw(): void }

export function stockSearch(o: StockSearchOpts): StockSearchHandle {
  const limit = o.limit ?? 10;
  let seq = 0;
  let hits: SearchHit[] = [];

  const itemHtml = (u: { symbol: string; name?: string }, tailHtml = ""): string => {
    const chg = chgCache.get(u.symbol);
    const chgHtml = chg == null ? "" :
      `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`;
    return `<div class="sitem" data-c="${u.symbol}" data-n="${u.name || ""}">` +
      `<b>${u.name || u.symbol}</b><span class="num">${u.symbol}</span>` +
      (tailHtml ? `<span class="s-tail">${tailHtml}</span>` : "") + chgHtml + `</div>`;
  };

  /* 就地回填涨跌幅：绝不整体重绘——mousedown/up 之间 DOM 被替换会让 click 被吞 */
  const backfill = (mySeq: number, rows: { symbol: string }[]): void => {
    void Promise.allSettled(rows.map(async (u) => {
      if (chgCache.has(u.symbol)) return;
      try {
        const qt = await marketApi.quote(u.symbol);
        chgCache.set(u.symbol, qt.pct_chg ?? null);
      } catch { chgCache.set(u.symbol, null); }
    })).then(() => {
      if (mySeq !== seq) return;
      rows.forEach((u) => {
        const chg = chgCache.get(u.symbol);
        if (chg == null) return;
        const el = o.list.querySelector<HTMLElement>(`.sitem[data-c="${u.symbol}"]`);
        if (!el || el.querySelector(".chg")) return;
        el.insertAdjacentHTML("beforeend",
          `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`);
      });
    });
  };

  const histHtml = (): string => {
    const h = loadHist();
    if (!h.length) return `<div class="sb-head"><span>暂无搜索历史 · 输入代码 / 名称 / 拼音搜索</span></div>`;
    return `<div class="sb-head"><span>最近搜索</span><span data-sb-clear style="cursor:pointer">清空</span></div>` +
      h.map((u) => itemHtml(u)).join("");
  };

  const draw = (html: string): void => {
    o.list.innerHTML = html;
    o.setVisible?.(true);
  };

  /* 缓存命中的涨跌幅随绘制同步带上，未命中的异步补（mySeq 传当前序号，不推进） */
  const drawWithChg = (html: string, rows: { symbol: string }[], mySeq = seq): void => {
    draw(html);
    backfill(mySeq, rows);
  };

  const drawHist = (): void => drawWithChg(histHtml(), loadHist());

  const search = (): void => {
    const q = o.input.value.trim();
    if (!q) { drawHist(); return; }
    const mySeq = ++seq;
    void marketApi.search(q, limit).then((r) => {
      if (mySeq !== seq) return;
      hits = r.items;
      if (!hits.length) {
        draw(`<div class="sitem" style="color:var(--faint);cursor:default">未找到匹配标的</div>`);
        return;
      }
      drawWithChg(hits.map((u) => itemHtml(u, o.tail?.(u))).join(""), hits, mySeq);
    }).catch(() => {
      if (mySeq === seq)
        draw(`<div class="sitem" style="color:var(--faint);cursor:default">搜索服务不可达</div>`);
    });
  };

  let debounce = 0;
  o.input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(search, 160);
  });
  o.input.addEventListener("focus", () => { if (!o.input.value.trim()) drawHist(); });
  o.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const f = o.list.querySelector<HTMLElement>(".sitem[data-c]");
      if (f) f.click();
    }
    if (e.key === "Escape") o.setVisible?.(false);
  });
  if (o.setVisible && o.scope)
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(o.scope!)) o.setVisible!(false);
    });
  o.list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-sb-clear]")) { clearHist(); drawHist(); return; }
    const tailBtn = t.closest("[data-sb-tail]");
    if (tailBtn && o.onTail) {
      const sym = tailBtn.getAttribute("data-sb-tail")!;
      const u = hits.find((h) => h.symbol === sym);
      o.onTail({ symbol: sym, name: u?.name || tailBtn.getAttribute("data-sb-name") || sym }, tailBtn as HTMLElement);
      return;
    }
    const it = t.closest<HTMLElement>(".sitem[data-c]");
    if (!it) return;
    const u = { symbol: it.dataset.c!, name: it.dataset.n || it.dataset.c! };
    saveHist(u);
    o.onPick(u);
  });

  return {
    redraw(): void {
      /* 行尾态变化（如已添加）后重绘：有输入 → 重渲结果，否则重渲历史 */
      if (o.input.value.trim()) {
        if (!hits.length) return;
        drawWithChg(hits.map((u) => itemHtml(u, o.tail?.(u))).join(""), hits);
      } else drawHist();
    },
  };
}
