/* 入口：导航 / 全局搜索 / 主题 / SSE 接线 / 启动 */
import "./styles.css";
import { ic, injectIcons } from "./icons";
import { authApi, getToken } from "./api";
import { applyAppearance, getState, patch, setUser, subscribe } from "./store";
import { toast } from "./ui";
import { stockSearch } from "./searchbox";
import { initAuth, refreshVipUI } from "./auth";
import { initMarket, klResize, openStock, renderKline, renderRight } from "./pages/market";
import { initWatchlist, renderWatchlist } from "./pages/watchlist";
import { initSectors, loadSectors } from "./pages/sectors";
import { initCorepicks, renderCorepicks } from "./pages/corepicks";
import { initCards, renderCards } from "./pages/cards";
import { initSettings, refreshDatachip, refreshUpChip, openSettingsTab } from "./pages/settings";
import { initSync, pullOnLogin } from "./sync";
import { SseClient } from "./sse";
import { initWatchPanel } from "./watch";

const loaded = { watchlist: false, sectors: false, corepicks: false };

function goPage(p: string): void {
  document.querySelectorAll(".page").forEach((x) => x.classList.toggle("on", x.id === "page-" + p));
  document.querySelectorAll("#rail a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
  document.querySelectorAll("#mtabs a").forEach((a) => a.classList.toggle("on", (a as HTMLElement).dataset.page === p));
  if (p === "market") renderKline();
  if (p === "watchlist" && !loaded.watchlist) { loaded.watchlist = true; renderWatchlist(); }
  if (p === "sectors" && !loaded.sectors) { loaded.sectors = true; void loadSectors(); }
  if (p === "corepicks" && !loaded.corepicks) { loaded.corepicks = true; initCorepicks(); }
  if (p === "cards") renderCards();
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
  document.querySelectorAll<HTMLElement>("#dev-toggle button").forEach((b) =>
    b.classList.toggle("on", b.dataset.dev === m));
  if (persist) localStorage.setItem("yc_device", m);
  if (document.getElementById("page-market")!.classList.contains("on")) klResize();
}
function initDevice(): void {
  const saved = localStorage.getItem("yc_device") as DeviceMode | null;
  const w = window.innerWidth;
  const auto: DeviceMode = w <= 480 ? "phone" : w <= 820 ? "fold" : "desktop";
  const mode: DeviceMode = saved === "desktop" || saved === "fold" || saved === "phone"
    ? saved : auto;
  applyDevice(mode, saved != null); // 首次访问跟随视口且不落盘，手动切换后才记忆
  document.getElementById("dev-toggle")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-dev]");
    if (b) applyDevice(b.dataset.dev as DeviceMode);
  });
  document.querySelectorAll<HTMLElement>("#mtabs a").forEach((a) =>
    a.addEventListener("click", () => goPage(a.dataset.page!)));
  // 移动端行情页「图表 / 卡片」分段：卡片态隐藏 K 线列，直达信息卡片区免滚动
  document.getElementById("m-mkt-seg")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-mv]");
    if (!b) return;
    const cards = b.dataset.mv === "cards";
    document.body.classList.toggle("m-cards", cards);
    document.querySelectorAll<HTMLElement>("#m-mkt-seg button").forEach((x) =>
      x.classList.toggle("on", x === b));
    if (!cards) klResize();
  });
}

/* ── 启动 ── */
function boot(): void {
  applyAppearance();
  injectIcons();
  bindNav();
  initDevice();
  initRailResize();
  initSearch();
  initAuth();
  initMarket();
  initWatchlist();
  initSectors();
  initCards();
  initSettings();
  initWatchPanel();           // 加自选/分组管理面板（modal-watch）：行情页 star 与核心标明细共用
  initSync();                 // F04：本地变更→云推送；带 token 启动→静默拉取合并

  // 主题按钮
  const btn = document.getElementById("btn-theme")!;
  const drawTheme = () => { btn.innerHTML = ic(getState().theme === "dark" ? "moon" : "sun", 16); };
  drawTheme();
  btn.addEventListener("click", () => {
    const next = getState().theme === "dark" ? "light" : "dark";
    localStorage.setItem("yc_theme", JSON.stringify(next));
    document.dispatchEvent(new CustomEvent("yc:patch-theme", { detail: next }));
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

  // 启动默认视图：有上次标的则恢复，否则默认上证指数（大盘即首页）
  const last = localStorage.getItem("yc_last_symbol");
  if (last) {
    const [symbol, name] = last.split("|");
    void openStock({ symbol, name: name || symbol });
  } else {
    void openStock({ symbol: "000001.SH", name: "上证指数" });
  }

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
