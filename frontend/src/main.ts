/* 入口：导航 / 全局搜索 / 主题 / SSE 接线 / 启动 */
import "./styles.css";
import "./mainforce.css";
import { ic, injectIcons } from "./icons";
import { authApi, getToken } from "./api";
import { applyAppearance, getState, patch, setCustomAccent, setUser, subscribe, type AccentKey } from "./store";
import { bindModalChrome, toast } from "./ui";
import { bindSegInfo } from "./segmap";
import { stockSearch } from "./searchbox";
import { initAuth, refreshVipUI } from "./auth";
import { initMarket, klResize, openStock, renderKline, renderRight } from "./pages/market";
import { initPanorama, loadPanorama } from "./pages/panview";
import { initMainforce, loadMainforce } from "./pages/mainforce";
import { loadMotion } from "./pages/motion";
import { loadChase } from "./pages/chase";
import { loadEtfUpdown } from "./pages/etf";
import { initWatchlist, renderWatchlist } from "./pages/watchlist";
import { initTargets, loadTargets } from "./pages/targets";
import { initSectors, jumpSector, loadSectors } from "./pages/sectors";
import { initCorepicks, renderCorepicks } from "./pages/corepicks";
import { initCards, renderCards } from "./pages/cards";
import { initSettings, refreshDatachip, refreshUpChip, openSettingsTab } from "./pages/settings";
import { initAi } from "./pages/ai";
import { initQuickAsk } from "./pages/quickask";
import { initSync, pullOnLogin } from "./sync";
import { SseClient } from "./sse";
import { initWatchPanel } from "./watch";

const loaded = { watchlist: false, sectors: false, corepicks: false };
/** 手机底栏「更多」抽屉里的页面：当前页在其中时，更多按钮保持高亮 */
const MORE_PAGES = ["mainforce", "motion", "chase", "sectors", "corepicks", "etfupdown", "ai", "cards", "settings"];

/** 手机搜索页的来路：返回时回到这一页（搜索页本身不记入） */
let searchFrom = "market";

function goPage(p: string): void {
  if (p !== "search") searchFrom = p;
  document.body.classList.toggle("in-search", p === "search");   // 搜索页收起顶栏
  document.querySelectorAll(".page").forEach((x) => x.classList.toggle("on", x.id === "page-" + p));
  if (p !== "search") {   // 搜索页不是固定页签：保持底栏/侧栏原高亮
    document.querySelectorAll("#rail a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
    document.querySelectorAll("#mtabs a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
    document.querySelector("#m-more-btn")?.classList.toggle("on", MORE_PAGES.includes(p));
  }
  if (p === "market") { renderKline(); requestAnimationFrame(() => klResize()); }
  if (p === "panorama") loadPanorama();
  if (p === "mainforce") void loadMainforce();
  if (p === "motion") void loadMotion();
  if (p === "chase") void loadChase();
  if (p === "watchlist") renderWatchlist();   // 每次进入重画：与其他入口（收藏浮层/卡片）的分组选择保持同步
  if (p === "targets") loadTargets();
  if (p === "sectors" && !loaded.sectors) { loaded.sectors = true; void loadSectors(); }
  if (p === "corepicks" && !loaded.corepicks) { loaded.corepicks = true; initCorepicks(); }
  if (p === "etfupdown") void loadEtfUpdown();
  if (p === "cards") renderCards();
  if (p === "mcards") renderRight();      // 手机版卡片页：进入时重画右侧卡片
}

/* ── 手机版「卡片」页：把行情页右侧卡片栏整块搬进独立页；回到桌面再搬回行情页 ── */
function syncCardsHost(): void {
  const col = document.getElementById("rightcol");
  const row = document.querySelector(".mkt-row");
  const page = document.getElementById("page-mcards");
  if (!col || !row || !page) return;
  const target = document.body.classList.contains("mobile") ? page : row;
  if (col.parentElement !== target) target.appendChild(col);
}

/* ── 全局搜索（共享组件：代码/名称/拼音模糊 + 最近搜索历史 + 涨跌幅回填） ── */
function initSearch(): void {
  const input = document.getElementById("ginput") as HTMLInputElement;
  const drop = document.getElementById("gdrop")!;
  stockSearch({
    input,
    list: drop,
    scope: ".gsearch",
    setVisible: (v) => drop.classList.toggle("on", v),
    onPick: (u) => {
      input.value = "";
      input.blur();
      drop.classList.remove("on");
      if (u.kind === "sector") {
        document.dispatchEvent(new CustomEvent("yc:open-sector", {
          detail: { id: u.symbol, sub: u.sub } }));
        toast(`已切换至板块 ${u.name || u.symbol}`);
        return;
      }
      void openStock({ symbol: u.symbol, name: u.name || u.symbol });
      toast(`已切换至 ${u.name || u.symbol}`);
    },
  });
  // Cmd/Ctrl+K 聚焦全局搜索
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

/* ── 手机版：每个页面的标题行（.phead）末尾补一个搜索图标，搜索永远与标题同行 ── */
function addMobileSearchButtons(): void {
  document.querySelectorAll<HTMLElement>(".page .phead").forEach((ph) => {
    if (ph.querySelector("[data-open-search]")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icbtn msearch-inline";
    b.dataset.openSearch = "1";
    b.title = "搜索";
    b.setAttribute("aria-label", "搜索");
    b.innerHTML = ic("magnifying-glass", 16);
    ph.appendChild(b);
  });
}

/* ── 手机版搜索页：顶栏放大镜进入，返回回到来路页面 ── */
function initSearchPage(): void {
  const input = document.getElementById("sinput") as HTMLInputElement;
  const list = document.getElementById("sres")!;
  const open = (): void => {
    goPage("search");
    window.setTimeout(() => input.focus(), 30);   // 等页面切换完成再聚焦，避免键盘抢占
  };
  const back = (): void => {
    input.value = "";
    input.blur();
    goPage(searchFrom);
  };
  document.getElementById("btn-search")!.addEventListener("click", open);
  // 各页标题行里的内联搜索按钮（手机版：搜索永远跟标题同一行，不单独占行）
  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-open-search]")) open();
  });
  document.getElementById("btn-search-back")!.addEventListener("click", back);
  document.getElementById("btn-search-cancel")!.addEventListener("click", back);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("page-search")!.classList.contains("on")) back();
  });
  stockSearch({
    input,
    list,
    onPick: (u) => {
      if (u.kind === "sector") {
        document.dispatchEvent(new CustomEvent("yc:open-sector", {
          detail: { id: u.symbol, sub: u.sub } }));
        toast(`已切换至板块 ${u.name || u.symbol}`);
      } else {
        void openStock({ symbol: u.symbol, name: u.name || u.symbol });
        toast(`已切换至 ${u.name || u.symbol}`);
      }
      input.value = "";
      input.blur();
    },
  });
}

/* ── 侧栏宽度拖拽（--rail-w，localStorage 持久化） ── */
function initRailResize(): void {
  const grip = document.getElementById("rail-grip")!;
  const apply = (w: number) =>
    document.documentElement.style.setProperty("--rail-w", `${w}px`);
  const saved = Number(localStorage.getItem("yc_rail_w"));
  if (saved >= 48 && saved <= 220) apply(saved);
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grip.classList.add("on");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      // 预留拖拽手柄自身 3px 悬出，取指针位置即目标宽度
      const w = Math.min(220, Math.max(48, ev.clientX));
      apply(w);
      localStorage.setItem("yc_rail_w", String(w));
      // 行情页图表跟随重排
      clearTimeout((window as unknown as { _rz?: number })._rz);
      (window as unknown as { _rz?: number })._rz = window.setTimeout(() => {
        if (document.getElementById("page-market")!.classList.contains("on")) klResize();
      }, 120);
    };
    const up = () => {
      grip.classList.remove("on");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ── 设备模式（桌面 / 折叠屏 / 普通屏）：三款宽度，body.mobile+f/phone 驱动布局 ── */
type DeviceMode = "desktop" | "fold" | "phone";
function applyDevice(m: DeviceMode, persist = true): void {
  document.body.classList.toggle("mobile", m !== "desktop");
  document.body.classList.toggle("fold", m === "fold");
  document.body.classList.toggle("phone", m === "phone");
  document.querySelectorAll<HTMLElement>("#dev-toggle button, #dev-toggle-m button").forEach((b) =>
    b.classList.toggle("on", b.dataset.dev === m));
  if (persist) localStorage.setItem("yc_device", m);
  window.dispatchEvent(new CustomEvent("yc:device", { detail: m }));
  syncCardsHost();            // 卡片栏归属随设备档位切换
  if (document.getElementById("page-market")!.classList.contains("on")) klResize();
}
function initDevice(): void {
  const saved = localStorage.getItem("yc_device") as DeviceMode | null;
  const pick = (w: number): DeviceMode => w <= 480 ? "phone" : w <= 900 ? "fold" : "desktop";
  // 预览/调试用：?device=phone|fold|desktop 强制档位，不写入本地偏好
  const q = new URLSearchParams(location.search).get("device");
  const forced: DeviceMode | null =
    q === "desktop" || q === "fold" || q === "phone" ? q : null;
  const mode: DeviceMode = forced
    ?? (saved === "desktop" || saved === "fold" || saved === "phone" ? saved : pick(window.innerWidth));
  applyDevice(mode, forced == null && saved != null); // 首次访问跟随视口且不落盘，手动切换后才记忆
  let userPicked = forced != null || saved != null;
  document.getElementById("dev-toggle")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-dev]");
    if (b) { userPicked = true; applyDevice(b.dataset.dev as DeviceMode); }
  });
  // 折叠屏展开/合起、横竖屏切换：未手动选过设备时跟随视口重新分档
  let rt = 0;
  window.addEventListener("resize", () => {
    if (userPicked) return;
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      const next = pick(window.innerWidth);
      const cur: DeviceMode = document.body.classList.contains("phone") ? "phone"
        : document.body.classList.contains("fold") ? "fold" : "desktop";
      if (next !== cur) applyDevice(next, false);
    }, 160);
  });
  // 手机底栏「更多」抽屉：其余页面收纳在这里
  const more = document.getElementById("m-more")!;
  const moreBtn = document.getElementById("m-more-btn")!;
  const setMore = (on: boolean) => {
    more.classList.toggle("on", on);
    more.setAttribute("aria-hidden", String(!on));
    moreBtn.setAttribute("aria-expanded", String(on));
  };
  moreBtn.addEventListener("click", () => setMore(!more.classList.contains("on")));
  more.querySelectorAll("[data-close]").forEach((x) =>
    x.addEventListener("click", () => setMore(false)));
  more.querySelectorAll<HTMLElement>("a[data-page]").forEach((a) =>
    a.addEventListener("click", () => { goPage(a.dataset.page!); setMore(false); }));
  // 手机版顶栏隐藏后，设备档位只能在「更多」里切；选桌面后抽屉随之关闭
  document.getElementById("dev-toggle-m")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-dev]");
    if (!b) return;
    userPicked = true;
    applyDevice(b.dataset.dev as DeviceMode);
    setMore(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMore(false);
  });

  document.querySelectorAll<HTMLElement>("#mtabs a").forEach((a) =>
    a.addEventListener("click", () => { goPage(a.dataset.page!); setMore(false); }));
  // 移动端行情页「图表 / 卡片」分段：卡片态隐藏 K 线列，直达信息卡片区免滚动
}

/* ── 启动 ── */
function boot(): void {
  applyAppearance();
  injectIcons();
  // PWA：HTTPS / localhost 下注册外壳 SW，安装到桌面后全屏启动（HTTP 公网 IP 非安全上下文，自动跳过）
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  bindModalChrome();          // 弹窗关闭（X / 遮罩）：之前漏调用，登录框弹出后关不掉
  bindSegInfo();              // 六分段「示意图」小按钮：全局委托，悬停/点击弹层
  bindNav();
  initDevice();
  initRailResize();
  initSearch();
  addMobileSearchButtons();
  initSearchPage();           // 手机版独立搜索页（顶栏放大镜进入）
  initAuth();
  initMarket();
  initPanorama();
  initMainforce();
  initWatchlist();
  initTargets();
  initSectors();
  initCards();
  initSettings();
  initAi();                   // 智能页：问股对话（规则模式零依赖，配模型后自动升级）
  initQuickAsk();             // 右下角快速问股浮框（任意页面可唤起，自动带当前标的）
  initWatchPanel();           // 加自选/分组管理面板（modal-watch）：行情页 star 与核心标明细共用
  initSync();                 // F04：本地变更→云推送；带 token 启动→静默拉取合并

  // 主题按钮 + 强调色四选（顶栏直接点选，与设置页外观同一套状态）
  const btn = document.getElementById("btn-theme")!;
  const accentsEl = document.getElementById("btn-accents")!;
  const ACCENTS: [string, string, string][] = [
    ["amber", "#FF9F43", "琥珀"], ["teal", "#2FD3C5", "青"],
    ["indigo", "#8A94FF", "蓝紫"], ["rose", "#F07C93", "玫红"],
  ];
  accentsEl.innerHTML = ACCENTS.map(([key, hex, name]) =>
    `<button type="button" class="sw" data-ac="${key}" title="强调色 · ${name}" aria-label="强调色 · ${name}"
      style="background:color-mix(in srgb,${hex} 18%,transparent)"><i style="background:${hex}"></i></button>`).join("")
    // 自定义强调色：彩虹环=可点开取色盘，内圈显示已选色
    + `<label class="sw sw-custom" data-ac="custom" title="自定义强调色" aria-label="自定义强调色">
        <input type="color" value="${getState().accentCustom}" aria-label="自定义强调色">
        <i style="background:${getState().accentCustom}"></i></label>`;
  const drawTheme = () => {
    const s = getState();
    btn.innerHTML = ic(s.theme === "dark" ? "moon" : "sun", 16);
    accentsEl.querySelectorAll<HTMLElement>(".sw").forEach((el) =>
      el.classList.toggle("on", el.dataset.ac === s.accent));
    const inp = accentsEl.querySelector<HTMLInputElement>(".sw-custom input");
    const dot = accentsEl.querySelector<HTMLElement>(".sw-custom i");
    if (inp) inp.value = s.accentCustom;
    if (dot) dot.style.background = s.accentCustom;
    // 状态栏 / 任务栏跟随主题（PWA 全屏启动时生效）
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", s.theme === "dark" ? "#0A0A0B" : "#F5F5F7");
  };
  drawTheme();
  btn.addEventListener("click", () => {
    const next = getState().theme === "dark" ? "light" : "dark";
    localStorage.setItem("yc_theme", JSON.stringify(next));
    document.dispatchEvent(new CustomEvent("yc:patch-theme", { detail: next }));
  });
  accentsEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".sw[data-ac]");
    if (b) patch("accent", b.dataset.ac as AccentKey);
  });
  // 取色盘拖动/选中：即时应用自定义色
  accentsEl.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.type === "color") setCustomAccent(t.value);
  });
  subscribe(drawTheme);

  // 顶栏数据 chip 点击 → 数据底座看板
  document.getElementById("datachip")!.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("yc:goto-settings", { detail: "data" }));
  });

  // 跨页事件
  document.addEventListener("yc:goto-page", (e) => goPage((e as CustomEvent).detail));
  document.addEventListener("yc:open-stock", (e) => {
    const d = (e as CustomEvent).detail;
    void openStock(d, d.from);
  });
  // 顶部搜索选中板块 → 板块页，并切到对应行业/概念分类
  document.addEventListener("yc:open-sector", (e) => {
    const d = (e as CustomEvent).detail as { id: string; sub?: string };
    loaded.sectors = true;                 // 由 jumpSector 统一加载，避免 goPage 再拉一次
    goPage("sectors");
    void jumpSector(d.id, d.sub === "concept" ? "concept" : "industry");
  });
  document.addEventListener("yc:goto-settings", (e) => { goPage("settings"); openSettingsTab((e as CustomEvent).detail); });
  document.addEventListener("yc:patch-theme", (e) => {
    patch("theme", (e as CustomEvent).detail as "dark" | "light");
  });
  subscribe(() => {
    applyAppearance();          // 主题/涨跌方向/强调色 → data-* 属性（缺此行切换不生效）
    refreshVipUI();
    if (document.getElementById("page-market")!.classList.contains("on")) {
      renderRight();
      renderKline();
    }
  });

  // SSE：底座状态推送 → 刷新 datachip；license 变化 → 刷新 VIP UI
  const sse = new SseClient(["data:update", "corepicks:daily"], (ch) => {
    if (ch === "data:update") void refreshDatachip();
  });
  sse.on((ev) => {
    if (ev.channel === "data:update") {
      void refreshDatachip();
      void refreshUpChip();      // 任务开始/进度/结束 → 顶栏进度徽章（活动态 3s 自跟）
    }
    if (ev.channel === "corepicks:daily") {
      loaded.corepicks = false;
      if (document.getElementById("page-corepicks")!.classList.contains("on")) {
        loaded.corepicks = true;
        void renderCorepicks();
      }
      toast("核心标名单已更新");
    }
  });
  sse.start();

  // 启动默认视图：行情页恒以「上证指数」开场（大盘即首页）。
  // 不再回放上次标的 —— 首页定位要稳定，个股从搜索/自选/板块进，
  // 否则上次随手看的票会把首页顶掉。
  void openStock({ symbol: "000001.SH", name: "上证指数" });

  // 带令牌启动：恢复会话 + 云设置拉取（静默，失败保持本地态）
  if (getToken()) {
    void authApi.me().then((u) => {
      setUser(u);
      refreshVipUI();
      void pullOnLogin().then(() => {
        document.dispatchEvent(new CustomEvent("yc:kprefs"));
        if (document.getElementById("page-watchlist")?.classList.contains("on")) renderWatchlist();
      });
    }).catch(() => { /* 令牌无效：req 已派发 yc:auth-expired */ });
  }
}

function bindNav(): void {
  document.querySelectorAll<HTMLElement>("#rail a").forEach((a) =>
    a.addEventListener("click", () => goPage(a.dataset.page!)));
}

boot();
