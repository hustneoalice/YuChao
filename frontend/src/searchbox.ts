/* 共享标的搜索（顶栏 / 添加自选弹窗统一入口）：
   模糊搜索（后端 代码/名称/拼音缩写/全拼）+ 搜索历史（最近 10 条，可清空）+ 涨跌幅回填。
   交互对齐主流键盘精灵：聚焦/空输入显示历史，点击项保存历史并回调。 */
import { marketApi, type SearchHit } from "./api";
import { fmtChg } from "./fmt";
import { ic } from "./icons";

export interface PickHit { symbol: string; name?: string; kind?: SearchHit["kind"]; sub?: string | null }

const HKEY = "yc_search_history";   // 顶栏历史沿用同一键：所有入口共享最近搜索

export function loadHist(): PickHit[] {
  try { return JSON.parse(localStorage.getItem(HKEY) || "[]") as PickHit[]; } catch { return []; }
}
export function saveHist(u: PickHit): void {
  const list = loadHist().filter((x) => x.symbol !== u.symbol);
  list.unshift({ symbol: u.symbol, name: u.name, kind: u.kind, sub: u.sub });
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
  /* 限定类别（顶栏缺省全类；加自选入口只搜个股） */
  kinds?: string[];
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
  let active = -1;                            // 键盘选中项（-1 = 未选中，回车走第一行）

  /* 一键清空：输入框外包一层，右侧浮出 ×（有内容才出现），点后回到最近搜索 */
  const wrap = document.createElement("span");
  wrap.className = "sfield";
  o.input.parentElement?.insertBefore(wrap, o.input);
  wrap.appendChild(o.input);
  const clr = document.createElement("button");
  clr.type = "button";
  clr.className = "s-clear";
  clr.title = "清空";
  clr.setAttribute("aria-label", "清空搜索");
  clr.innerHTML = ic("x", 11);
  wrap.appendChild(clr);
  const syncClear = (): void => { clr.classList.toggle("on", !!o.input.value); };
  o.input.addEventListener("input", syncClear);
  o.input.addEventListener("focus", syncClear);
  o.input.addEventListener("blur", syncClear);
  clr.addEventListener("mousedown", (e) => e.preventDefault());   // 保持焦点，不闪下拉
  clr.addEventListener("click", () => {
    o.input.value = "";
    window.clearTimeout(debounce);
    hits = [];
    seq++;
    active = -1;
    syncClear();
    o.input.focus();
    drawHist();
  });
  syncClear();

  const itemHtml = (u: PickHit, tailHtml = ""): string => {
    const chg = chgCache.get(u.symbol);
    const chgHtml = chg == null ? "" :
      `<span class="chg num ${chg >= 0 ? "up" : "down"}">${fmtChg(chg)}%</span>`;
    // 板块结果 symbol 与 name 相同（id 即板块名），不重复展示
    const codeHtml = u.symbol && u.symbol !== u.name ? `<span class="num">${u.symbol}</span>` : "";
    return `<div class="sitem" data-c="${u.symbol}" data-n="${u.name || ""}"` +
      ` data-k="${u.kind || "stock"}" data-sub="${u.sub || ""}">` +
      `<b>${u.name || u.symbol}</b>` + codeHtml +
      (tailHtml ? `<span class="s-tail">${tailHtml}</span>` : "") + chgHtml + `</div>`;
  };

  /* 就地回填涨跌幅：绝不整体重绘——mousedown/up 之间 DOM 被替换会让 click 被吞。
     板块（sector）无个股快照，跳过，避免每行一次 404。 */
  const backfill = (mySeq: number, rows: PickHit[]): void => {
    void Promise.allSettled(rows.filter((u) => u.kind !== "sector").map(async (u) => {
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
    active = -1;                              // 结果/历史重绘后从第一行重新开始
    o.setVisible?.(true);
  };

  /* 键盘选中：↑↓ 在结果间移动并高亮，回车打开当前项（未选中则第一行） */
  const itemsOf = (): HTMLElement[] =>
    Array.from(o.list.querySelectorAll<HTMLElement>(".sitem[data-c]"));
  const mark = (i: number): void => {
    const els = itemsOf();
    if (!els.length) { active = -1; return; }
    active = i < 0 ? 0 : i >= els.length ? els.length - 1 : i;
    els.forEach((el, k) => el.classList.toggle("on", k === active));
    els[active].scrollIntoView({ block: "nearest" });
  };
  const step = (dir: 1 | -1): void => {
    const els = itemsOf();
    if (!els.length) return;
    if (dir === 1) mark(active < 0 ? 0 : active + 1 < els.length ? active + 1 : 0);
    else mark(active <= 0 ? els.length - 1 : active - 1);
  };

  /* 缓存命中的涨跌幅随绘制同步带上，未命中的异步补（mySeq 传当前序号，不推进） */
  const drawWithChg = (html: string, rows: PickHit[], mySeq = seq): void => {
    draw(html);
    backfill(mySeq, rows);
  };

  const drawHist = (): void => drawWithChg(histHtml(), loadHist());

  /* 两段式搜索：先只查本地库（代码/名称/拼音，毫秒级）立刻出结果；
     本地不足 limit 时再补一次腾讯联想（外网 0.2~1s），用于中文简称和新股。
     这样绝大多数输入不再为一次外网调用干等。 */
  const supplement = (q: string, mySeq: number): void => {
    void marketApi.search(q, limit, o.kinds, true).then((r) => {
      if (mySeq !== seq) return;
      hits = r.items;
      if (!hits.length) {
        draw(`<div class="sitem" style="color:var(--faint);cursor:default">未找到匹配标的</div>`);
        return;
      }
      drawWithChg(hits.map((u) => itemHtml(u, o.tail?.(u))).join(""), hits, mySeq);
    }).catch(() => {
      if (mySeq !== seq || hits.length) return;
      draw(`<div class="sitem" style="color:var(--faint);cursor:default">搜索服务不可达</div>`);
    });
  };

  const search = (): void => {
    const q = o.input.value.trim();
    if (!q) { drawHist(); return; }
    const mySeq = ++seq;
    void marketApi.search(q, limit, o.kinds, false).then((r) => {
      if (mySeq !== seq) return;
      hits = r.items;
      if (hits.length) {
        drawWithChg(hits.map((u) => itemHtml(u, o.tail?.(u))).join(""), hits, mySeq);
        if (hits.length >= limit) return;
      } else {
        draw(`<div class="sitem" style="color:var(--faint);cursor:default">搜索中…</div>`);
      }
      supplement(q, mySeq);
    }).catch(() => {
      if (mySeq === seq) supplement(q, mySeq);
    });
  };

  let debounce = 0;
  o.input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(search, 120);
  });
  o.input.addEventListener("focus", () => { if (!o.input.value.trim()) drawHist(); });
  o.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();                     // 不让光标在输入框里乱跳
      step(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      const els = itemsOf();
      const f = (active >= 0 && els[active]) || els[0];
      if (f) f.click();
    }
    if (e.key === "Escape") o.setVisible?.(false);
  });
  /* 鼠标悬停同步键盘选中，避免「指着一行、回车却开了第一行」 */
  o.list.addEventListener("mousemove", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>(".sitem[data-c]");
    if (!it) return;
    const i = itemsOf().indexOf(it);
    if (i >= 0 && i !== active) {
      active = i;
      itemsOf().forEach((el, k) => el.classList.toggle("on", k === i));
    }
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
    const u: PickHit = {
      symbol: it.dataset.c!, name: it.dataset.n || it.dataset.c!,
      kind: (it.dataset.k || "stock") as PickHit["kind"], sub: it.dataset.sub || null,
    };
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
