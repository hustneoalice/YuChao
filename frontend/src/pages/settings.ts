/* 设置页：数据底座（真实 API）· 外观 · VIP · 账户 · 飞书推送（F10）· 大模型（F11） */
import { adminApi, authApi, dataApi, meApi, type AdminUser, type DataStatus, type HealthReport,
         type UpdateLogItem, type UpdateSnapshot, type LlmCfg, type FeishuCfg } from "../api";
import { esc, fmt } from "../fmt";
import { ic } from "../icons";
import { getState, patch, setUser, isVip, subscribe } from "../store";
import { toast, openModal } from "../ui";
import { logout } from "../auth";

const NAV: [string, string, string][] = [
  ["data", "数据底座", "database"],
  ["look", "外观", "circle-half"],
  ["vip", "VIP 与订阅", "crown-simple"],
  ["account", "账户", "user"],
  ["feishu", "飞书推送", "paper-plane-tilt"],
  ["llm", "大模型", "spark"],
];
/* 管理端专属：普通/VIP 用户与可用时间 */
const NAV_ADMIN: [string, string, string] = ["users", "用户管理", "user"];
let tab = "data";
let tasks: { kind: string; label: string; description: string }[] = [];

export function openSettingsTab(t: string): void {
  tab = t;
  void render();
}

const STAGE_TEXT: Record<string, [string, string]> = {
  uninitialized: ["未初始化", "bad"],
  initializing: ["初始化中", "warn"],
  ready: ["正常", "ok"],
  updating: ["更新中", "warn"],
  update_failed: ["更新失败", "bad"],
};

async function render(): Promise<void> {
  const nav = getState().user?.role === "admin" ? [...NAV, NAV_ADMIN] : NAV;
  if (tab === "users" && getState().user?.role !== "admin") tab = "data";
  document.getElementById("setnav")!.innerHTML = nav.map((n) =>
    `<button data-set="${n[0]}" class="${tab === n[0] ? "on" : ""}">${ic(n[2], 15)}<span>${n[1]}</span></button>`).join("");
  document.querySelectorAll<HTMLElement>("#setnav button").forEach((b) =>
    b.addEventListener("click", () => { tab = b.dataset.set!; void render(); }));
  const body = document.getElementById("setbody")!;
  body.innerHTML = `<div class="setsec" style="color:var(--faint);font-size:12px">加载中…</div>`;
  if (tab === "data") await renderData(body);
  else if (tab === "look") renderLook(body);
  else if (tab === "vip") renderVip(body);
  else if (tab === "account") renderAccount(body);
  else if (tab === "users") await renderAdminUsers(body);
  else if (tab === "feishu") await renderFeishu(body);
  else if (tab === "llm") await renderLlm(body);
}

/* ── 数据底座 ── */
/* 表名 → 中文标签（与后端 _INVENTORY 对齐，仅展示用） */
const TABLE_ZH: Record<string, string> = {
  daily_ohlcv: "日线 K 线", market_snapshot: "盘中实时行情", adjust_factor: "复权因子",
  capital_flow: "个股资金流", financials: "财务报表", stock_universe: "证券清单",
  sector_index: "行业板块行情", daily_valuation: "全市场估值", corepicks_result: "核心标名单",
  stock_profile: "个股档案", target_scan: "目标监控指标", target_trend: "趋势柱线指标",
  pe_percentile: "估值分位", fund_universe: "基金清单", sector_member: "板块成分",
  zy_block: "板块", zy_block_member: "板块成分", update_log: "更新记录",
};

const daysAgo = (d?: string | null): number | null => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
};
const freshCls = (n: number | null): "ok" | "warn" | "bad" =>
  n == null ? "bad" : n <= 2 ? "ok" : n <= 5 ? "warn" : "bad";
const freshLabel = (n: number | null): string =>
  n == null ? "无数据" : n === 0 ? "今日" : `${n} 天前`;

const STATUS_TEXT: Record<string, [string, string]> = {
  queued: ["排队中", "warn"], running: ["执行中", "p1"],
  completed: ["成功", ""], skipped: ["无新增", "flat"], cancelled: ["已停止", "flat"],
  interrupted: ["被中断", "bad"], failed: ["失败", "bad"],
};

/* 更新记录里的数据类型 → 散户能懂的叫法（未收录的统一显示「其他更新」，不露英文） */
const DATA_TYPE_ZH: Record<string, string> = {
  daily_ohlcv: "日线行情", kline: "日线行情", kline_update: "日线行情",
  capital_flow: "资金流向", daily_valuation: "估值数据", valuation: "估值数据",
  financials: "财务报表", stock_universe: "证券清单", sector_index: "行业板块行情",
  adjust_factor: "复权因子", corepicks: "核心标选股", corepicks_result: "核心标选股",
  stock_profile: "个股档案", market_snapshot: "盘中实时快照", quotes: "实时行情",
  fund_universe_sync: "基金清单同步", zy_block_sync: "板块同步",
  pe_percentile: "估值分位", target_scan: "目标监控计算", backup: "数据备份",
  feishu_push: "飞书早报", target_push: "两点乾坤推送",
  package_export: "导出数据包", package_import: "导入数据包", backfill: "历史回补",
};

/** 大数 → 人话：1.2 万（数据总量/新增条数用） */
const fmtW = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : fmt(n, 0));


let upTimer: ReturnType<typeof setInterval> | null = null;
const stopUpState = (): void => { if (upTimer) { clearInterval(upTimer); upTimer = null; } };
/* 顶栏徽章的轮询句柄（update 态自适应 3s）另用 upChipTimer，避免与设置页页内轮询冲突 */

/** 秒 → 人话时长（策影 fmtDur） */
const fmtDur = (s?: number | null): string => {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)} 秒`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m} 分 ${r} 秒` : `${m} 分`;
};

/** 任务状态 → 色点/胶囊语义（p1 蓝=进行中，ok 绿=成功，warn 黄=排队，bad 红=失败） */
const UP_STATUS: Record<string, { label: string; dot: string; cap: string }> = {
  running: { label: "执行中", dot: "info", cap: "info" },
  queued: { label: "排队中", dot: "warn", cap: "warn" },
  completed: { label: "已完成", dot: "ok", cap: "ok" },
  skipped: { label: "无新增", dot: "ok", cap: "warn" },
  cancelled: { label: "已停止", dot: "warn", cap: "warn" },
  interrupted: { label: "被中断", dot: "bad", cap: "bad" },
  failed: { label: "失败", dot: "bad", cap: "bad" },
};

/** 更新中任务的状态展示（dot 色 + 胶囊文案） */

/**
 * 数据更新卡（策影 UpdateProgressCard 同构 · 驭潮皮肤）
 * 回答两个问题：现在在更新什么、跑到哪了；以及没在更新时，为什么不用管。
 * 三形态：执行中（阶段+进度条+三格统计+日志）/ 排队中 / 空闲已就绪（一句话+最近记录折叠）。
 */
async function refreshUpState(): Promise<void> {
  const bodyBox = document.getElementById("up-body");
  const chipBox = document.getElementById("up-chip");
  const savedEl = document.getElementById("up-saved");
  if (!bodyBox || !chipBox) { stopUpState(); return; }
  let snap: UpdateSnapshot | null = null;
  try { snap = await dataApi.state(); } catch { /* 快照不可达，保持原样 */ }
  if (savedEl) savedEl.textContent = snap?.saved_at ? `最近检查 ${snap.saved_at.replace("T", " ").slice(5, 19)}` : "";
  if (!snap) return;

  const r = snap.running;
  const queued = snap.queued ?? [];
  const recent = (snap.recent ?? []).filter((t) => t.status !== "running");

  /* 头部胶囊（策影 head 逻辑） */
  const head = r
    ? ["更新进行中", "info"] : queued.length
    ? [`排队 ${queued.length} 项`, "warn"]
    : snap.error ? ["检查更新状态", "warn"] : ["数据已就绪", "ok"];
  chipBox.innerHTML = `<span class="upstat ${head[1]}">${esc(head[0])}</span>`;

  const parts: string[] = [];
  if (r) {
    const st = UP_STATUS[r.status] ?? UP_STATUS.running;
    const isRun = r.status === "running";
    const pct = Math.max(r.percent ?? 0, 1.5);
    /* 只有按标的/按项统计的批次任务才有成功/失败可数；单次任务显示 —，避免误导成 0/0 */
    const hasBatch = (r.total ?? 0) > 0;
    /* 速度与预计剩余：由已处理/已用时间推导；任务结束后回到总耗时 */
    const rate = hasBatch && isRun && r.elapsed_s && (r.done ?? 0) > 0
      ? ((r.done ?? 0) / r.elapsed_s) * 60 : 0;
    const leftS = rate > 0 ? Math.max(0, ((r.total ?? 0) - (r.done ?? 0)) / rate * 60) : 0;
    const pace = rate > 0
      ? `${fmt(rate, 0)} 只/分${leftS > 0
          ? ` · 剩 ${Math.floor(leftS / 60)}:${String(Math.floor(leftS % 60)).padStart(2, "0")}`
          : ""}`
      : "";
    parts.push(
      `<div class="uprow">` +
      `<i class="logdot ${st.dot}"${isRun ? ' style="animation:pulse 1.2s infinite"' : ""}></i>` +
      `<b style="font-size:12.5px">${esc(r.label)}</b>` +
      `<span class="upstat ${st.cap}">${esc(st.label)}</span>` +
      `<span style="font-size:11px;color:var(--faint)">${esc(r.trigger === "manual" ? "手动触发" : "自动触发")}</span>` +
      `<span style="flex:1"></span>` +
      (pace && isRun ? `<span class="up-rate" title="当前处理速度">⚡ ${esc(pace)}</span>` : "") +
      `<b class="num" style="font-size:12.5px">${(r.percent ?? 0).toFixed(1)}%</b>` +
      (isRun ? `<button class="hbtn upstop" id="up-stop" title="排队中的任务会直接取消，正在进行的更新会尽快安全结束">停止</button>` : "") + `</div>`,
      `<div class="upbar"><i style="width:${pct}%"></i></div>`,
      `<div style="display:flex;justify-content:space-between;font-size:11px">` +
      `<span style="color:var(--dim)">${esc(r.stage || "")}</span>` +
      (r.total ? `<span style="color:var(--faint)"><b class="num" style="color:var(--text)">${fmt(r.done ?? 0, 0)}</b>/${fmt(r.total, 0)}</span>` : "") +
      `</div>`,
      `<div class="upstats">` +
      `<div><div class="k">成功 / 失败</div><div class="v">` +
      (hasBatch
        ? `<span style="color:var(--down)">${fmt(r.succeeded ?? 0, 0)}</span><span style="color:var(--faint)"> / </span>` +
          `<span style="color:${r.failed ? "var(--up)" : "var(--faint)"}">${fmt(r.failed ?? 0, 0)}</span>`
        : `<span style="color:var(--faint)">—</span>`) + `</div></div>` +
      `<div><div class="k">已写入数据</div><div class="v">${r.rows != null ? fmtW(r.rows) : "—"}</div></div>` +
      `<div><div class="k">${pace ? "速度 / 预计剩余" : (isRun ? "已用时间" : "总耗时")}</div>` +
      `<div class="v">${pace || fmtDur(r.elapsed_s)}</div></div></div>`,
    );
    if (r.message) parts.push(`<div style="font-size:11px;color:var(--faint)">${esc(r.message)}</div>`);
    /* 实时明细流：最近 12 批，最新在顶、旧行渐淡（刷屏感 + 速度可读） */
    const logs = (r.logs ?? []).slice(-12).reverse();
    if (logs.length)
      parts.push(`<div class="up-live">` +
        logs.map((l, i) =>
          `<div class="up-live-row" style="opacity:${Math.max(1 - i * 0.07, 0.35)}">` +
          `<span class="t">${esc(l.time || "")}</span>` +
          `<span class="m">${esc(l.message || "")}</span></div>`).join("") +
        `</div>`);
    if (r.error) parts.push(`<div style="font-size:11px;color:var(--up);background:var(--up-soft);border-radius:8px;padding:7px 9px;line-height:1.5;word-break:break-all">${esc(r.error.slice(0, 300))}</div>`);
  } else if (queued.length) {
    parts.push(queued.map((q) =>
      `<div class="uprow"><i class="logdot warn"></i>` +
      `<span>排队等待：<b style="color:var(--text)">${esc(q.label)}</b></span></div>`).join(""));
  } else {
    parts.push(`<div style="font-size:12px;color:var(--dim);line-height:1.6">数据都是最新的。每个交易日收盘后会自动补齐最新行情，错过的也会自动补上，平时不需要手动操作。</div>`);
    if (recent.length) {
      parts.push(`<details open><summary class="uprecent">最近 ${Math.min(recent.length, 5)} 次更新记录</summary>` +
        `<div class="uprecent-list">${recent.slice(0, 5).map((t) => {
          const st = UP_STATUS[t.status] ?? UP_STATUS.skipped;
          const tm = (t.finished_at || t.started_at || "").slice(11, 19) || "--:--:--";
          return `<div class="uprow" style="font-size:11px">` +
            `<i class="logdot ${st.dot}" style="width:6px;height:6px"></i>` +
            `<span class="num" style="color:var(--faint);flex:none">${esc(tm)}</span>` +
            `<span style="color:var(--text);flex:none">${esc(t.label)}</span>` +
            `<span style="color:var(--dim);flex:none">${esc(st.label)}</span>` +
            `<span style="color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
            `${t.rows ? fmtW(t.rows) + " 条 · " : ""}${esc(String(t.message || ""))}</span></div>`;
        }).join("")}</div></details>`);
    }
  }
  if (snap.error) parts.push(`<div style="font-size:10.5px;color:var(--warn)">更新状态暂时读不到，不影响自动更新（${esc(snap.error)}）</div>`);
  bodyBox.innerHTML = parts.join("");
}

/* ── 数据体检（P1：四维打分 + 一键修复 + 自愈心跳摘要） ── */

let healthTimer: ReturnType<typeof setInterval> | null = null;
const stopHealthState = (): void => { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } };

const GRADE: Record<string, [string, string, string]> = {
  healthy: ["健康", "ok", "var(--down)"],
  warn: ["需关注", "warn", "var(--warn)"],
  poor: ["待修复", "bad", "var(--up)"],
};

/** 自愈心跳一句话摘要：账本里数今日完成 / 自动重试 / 待重试 */
const selfhealSummary = (h: HealthReport): string => {
  const kinds = Object.values(h.selfheal?.kinds ?? {});
  if (!kinds.length) return "自愈心跳 · 今日无异常";
  const ok = kinds.filter((k) => k.ok_at).length;
  const retried = kinds.reduce((s, k) => s + (k.retries ?? 0), 0);
  const pending = kinds.filter((k) => (k.fails ?? 0) > 0).length;
  const seg = [`今日完成 ${ok} 项`];
  if (retried) seg.push(`自动重试 ${retried} 次`);
  if (pending) seg.push(`${pending} 项待重试`);
  return "自愈心跳 · " + seg.join(" / ");
};

async function refreshHealth(): Promise<void> {
  const box = document.getElementById("health-body");
  const chip = document.getElementById("health-chip");
  if (!box || !chip) { stopHealthState(); return; }
  let h: HealthReport | null = null;
  try { h = await dataApi.health(); } catch { /* 不可达保持原样 */ }
  if (!h) return;
  if (h.unavailable) {
    chip.innerHTML = `<span class="upstat warn">稍后复评</span>`;
    box.innerHTML = `<div style="font-size:12px;color:var(--dim)">${esc(h.note || "体检暂时不可用")}</div>`;
    return;
  }
  const g = GRADE[h.grade] ?? GRADE.warn;
  chip.innerHTML = `<span class="upstat ${g[1]}">${h.score} 分 · ${g[0]}</span>`;

  /* 四维卡（保留卡片式，信息升维）：每卡=分数+用户能看懂的具体事实 */
  const f = h.freshness?.items ?? [];
  const kline = f.find((x) => x.table === "daily_ohlcv");
  const covItems = h.coverage?.items ?? [];
  const covWorst = [...covItems].filter((x) => typeof x.coverage === "number")
    .sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0))[0];
  const gapMiss = (h.gap?.items ?? []).filter((x) => x.missing || x.drop).length;
  const ret = Object.values(h.selfheal?.kinds ?? {}).reduce((s, k) => s + (k.retries ?? 0), 0);
  const facts: [string, number, string, string][] = [
    ["数据是否最新", h.freshness?.score ?? 0,
      kline ? `行情 ${ (kline.latest || "").slice(5, 10) } · 落后 ${kline.lag_days} 个交易日` : "—",
      kline && kline.lag_days === 0 ? "ok" : kline && kline.lag_days <= 1 ? "mid" : "bad"],
    ["覆盖多少股票", h.coverage?.score ?? 0,
      covWorst ? `${esc(TABLE_ZH[covWorst.table] || "数据表")} ${Math.round(covWorst.coverage ?? 0)}%` : "全部完整",
      (covWorst?.coverage ?? 100) >= 90 ? "ok" : (covWorst?.coverage ?? 100) >= 50 ? "mid" : "bad"],
    ["历史有没有断", h.gap?.score ?? 0,
      gapMiss ? `近 10 个交易日 ${gapMiss} 处异常` : "近 10 个交易日无断档",
      gapMiss ? "bad" : "ok"],
    ["自动更新是否正常", h.ledger?.score ?? 0,
      h.ledger?.updater_alive ? (ret ? `正常 · 自动重试 ${ret} 次` : "正常") : "已停止",
      h.ledger?.updater_alive ? "ok" : "bad"],
  ];
  const bar = (v: number, color: string): string =>
    `<div class="upbar" style="height:4px;margin-top:4px"><i style="width:${Math.max(v, 2)}%;background:${color}"></i></div>`;
  const parts: string[] = [
    `<div class="upstats">` +
    facts.map(([name, v, fact, tone]) => {
      const c = v >= 85 ? "var(--down)" : v >= 70 ? "var(--warn)" : "var(--up)";
      return `<div><div class="k">${name}</div>` +
        `<div class="v num" style="color:${c}">${v}</div>${bar(v, c)}` +
        `<div class="num" style="font-size:10px;color:var(--faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${fact}` +
        (tone === "bad" ? ` <i class="logdot bad" style="width:5px;height:5px;display:inline-block"></i>` : "") + `</div></div>`;
    }).join("") + `</div>`,
  ];
  const issues = (h.issues ?? []).slice(0, 6);
  if (issues.length)
    parts.push(`<div style="display:flex;flex-direction:column;gap:5px">` +
      issues.map((i) =>
        `<div class="uprow" style="font-size:11.5px">` +
        `<i class="logdot ${i.level === "error" ? "bad" : "warn"}"></i>` +
        `<span style="color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.message)}</span>` +
        (i.action ? `<span class="upstat info" style="font-size:10px">可修复</span>` : "") +
        `</div>`).join("") + `</div>`);
  else
    parts.push(`<div style="font-size:12px;color:var(--down)">各项检查全部通过，数据底座状态良好。</div>`);
  box.innerHTML = parts.join("");
}

async function repairNow(): Promise<void> {
  try {
    const r = await dataApi.repair();
    if (r.submitted?.length) {
      const labels = r.submitted.map((s) => DATA_TYPE_ZH[s.kind] || "数据更新").join("、");
      toast(`已提交 ${r.submitted.length} 项修复：${labels}`);
      void refreshUpState();
    } else {
      toast(r.message || "底座健康，无需修复");
    }
    void refreshHealth();
  } catch (e) {
    toast((e as Error).message || "修复请求失败");
  }
}

async function renderData(body: HTMLElement): Promise<void> {
  stopUpState();
  stopHealthState();
  let st: DataStatus | null = null;
  let tasksR: Awaited<ReturnType<typeof dataApi.tasks>> | null = null;
  let logs: UpdateLogItem[] = [];
  try {
    [st, tasksR] = await Promise.all([dataApi.status(), dataApi.tasks()]);
    tasks = tasksR.items;
  } catch { /* 展示错误态 */ }
  try {
    logs = (await dataApi.updates(12)).items;
  } catch { logs = []; }
  const stage = STAGE_TEXT[st?.stage ?? "uninitialized"] ?? ["未知", "bad"];
  const tables = [...(st?.tables ?? [])].sort((a, b) => (b.latest_date ?? "").localeCompare(a.latest_date ?? ""));
  const filled = tables.filter((t) => (t.rows ?? 0) > 0);
  const totalRows = filled.reduce((s, t) => s + (t.rows ?? 0), 0);
  const ohlcv = tables.find((t) => t.table === "daily_ohlcv");
  const earliest = ohlcv?.earliest_date || "";
  /* 数据范围：2014-05 至今 · 12.5 年（vs 策影口径近 3 年，这是我们的卖点） */
  const spanYears = earliest
    ? ((Date.now() - new Date(earliest).getTime()) / 31557600000).toFixed(1)
    : null;
  const rangeSub = spanYears
    ? `${earliest.slice(0, 7).replace("-", " 年 ")} 月至今 · ${spanYears} 年全市场日线`
    : "数据准备中";

  body.innerHTML =
    /* ① 数据更新 + 数据体检 并排（紧凑两栏，消灭纵向堆叠浪费）：
       左=更新中心（进度/速度/实时明细流），右=体检四维 + 一键修复 */
    `<div class="setsec">
      <div class="sh">${ic("paper-plane-tilt", 15)}<h3>数据更新</h3>
        <span id="up-chip" style="display:inline-flex"></span><span class="sp"></span>
        <span class="sub num" id="up-saved"></span></div>
      <div class="up-grid">
        <div class="up-left">
          <div class="up-actions">
            <button class="hbtn primary" data-run="kline_update" title="拉取全市场日线增量（核心数据，收盘后自动执行）">立即更新</button>
            <details style="display:inline-block"><summary class="hbtn" data-sz="13" style="display:inline-flex;cursor:pointer;list-style:none">更多 ▾</summary>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">` +
    tasks.filter((t) => t.kind !== "kline_update").map((t) => `<button class="hbtn" data-run="${t.kind}" title="${esc(t.description)}">${esc(t.label)}</button>`).join("") +
    `</div></details>
            <span class="sp"></span>
            <span class="up-note" title="平时不需要手动操作；更新失败自动重试（5/15 分钟），错过的链位自动补上">自动重试 · 补链 ✓</span>
          </div>
          <div class="upcard" id="up-body"><span style="color:var(--faint);font-size:11.5px">正在读取更新状态…</span></div>
        </div>
        <div class="up-right">
          <div class="up-rhead">
            <b>数据体检</b><span id="health-chip" style="display:inline-flex"></span><span class="sp"></span>
            <button class="hbtn primary" id="health-repair" data-sz="12" title="体检发现问题，一键补齐（补数据 / 补账 / 重启更新）">一键修复</button>
          </div>
          <div class="upcard" id="health-body"><span style="color:var(--faint);font-size:11.5px">正在体检…</span></div>
        </div>
      </div></div>` +
    /* ② 数据内容：4 列紧凑卡（每卡 2 行：名称+状态 / 日期+条数；周期转悬停提示） */
    `<div class="setsec"><div class="sh"><h3>数据内容</h3>` +
    `<span class="sub">${esc(rangeSub)} · ${fmtW(totalRows)} 条</span><span class="sp"></span>` +
    `<span class="datachip i-${stage[1] === "ok" ? "up" : stage[1] === "warn" ? "mid" : ""}"><i></i><span>${esc(stage[0])}</span></span></div>` +
    `<div class="dsgrid">` +
    (filled.length ? filled.map((t) => {
      const n = daysAgo(t.latest_date);
      const cls = t.fresh ?? freshCls(n);
      const label = t.fresh_badge || freshLabel(n);
      const cov = typeof t.coverage === "number" ? t.coverage : null;
      const covCls = cov == null ? "" : cov >= 90 ? "" : cov >= 50 ? "mid" : "bad";
      const title = [t.fresh_note, t.cycle ? `更新周期：${t.cycle}` : ""].filter(Boolean).join(" · ");
      return `<div class="dscard" title="${esc(title)}"><div class="ds-h"><i class="logdot ${cls}"></i><b>${esc(TABLE_ZH[t.table] || "其他数据")}</b></div>` +
        `<div class="ds-date num">${esc(t.latest_date || "—")}</div>` +
        `<div class="ds-m"><span class="num">${fmtW(t.rows ?? 0)} 条</span>` +
        `<span class="sp"></span><span class="fresh ${cls}">${esc(label)}</span></div>` +
        (cov != null ? `<div class="ds-cov ${covCls}"><div class="bar"><i style="width:${Math.max(cov, 1.5)}%"></i></div>` +
          `<span class="num">${cov >= 99 ? "完整" : cov.toFixed(0) + "%"}</span></div>` : "") +
        `</div>`;
    }).join("") : `<div style="color:var(--faint);font-size:12px">数据还在准备中 — 点上方「立即更新」开始第一次更新</div>`) +
    `</div></div>` +
    /* ④ 更新记录：紧凑表格（行高压缩 / 时间等宽 / 备注截断） */
    `<div class="setsec"><div class="sh"><h3>更新记录</h3><span class="sub">最近 8 次 · 自动 / 手动</span></div>` +
    `<table class="up-tbl"><thead><tr><th>时间</th><th>更新内容</th><th>结果</th><th class="n">新增</th><th>备注</th></tr></thead><tbody>` +
    (logs.length ? logs.slice(0, 8).map((l) => {
      const [txt, cls] = STATUS_TEXT[String(l.status)] ?? [String(l.status || "—"), "flat"];
      return `<tr><td class="num">${esc(String(l.created_at || l.started_at || "—")).replace("T", " ").slice(5, 16)}</td>` +
        `<td>${esc(DATA_TYPE_ZH[String(l.data_type || "")] || (l.data_type ? "其他更新" : "—"))}</td>` +
        `<td><span class="tag ${cls}">${esc(txt)}</span></td>` +
        `<td class="n num">${l.rows != null ? "+" + fmtW(l.rows) : "—"}</td>` +
        `<td class="up-tbl-note" title="${esc(String(l.detail || l.error || l.message || ""))}">${esc(String(l.detail || l.error || l.message || ""))}</td></tr>`;
    }).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--faint)">${esc("还没有更新记录 — 点「立即更新」试试")}</td></tr>`) +
    `</tbody></table></div>`;

  body.querySelectorAll<HTMLElement>("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await dataApi.trigger(b.dataset.run!);
        toast(`已触发「${b.textContent}」，后台正在排队执行`);
        void refreshUpState();
      } catch (e) {
        toast((e as Error).message || "触发失败");
      }
    }));
  /* 停止按钮：refreshUpState 每 3s 重绘内部 DOM，委托挂在容器上只绑一次 */
  const upBody = document.getElementById("up-body");
  if (upBody) upBody.addEventListener("click", async (e) => {
    if (!(e.target as HTMLElement).closest(".upstop")) return;
    try {
      await dataApi.cancel();
      toast("已请求停止，正在取消");
      void refreshUpState();
    } catch (err) {
      toast((err as Error).message || "停止失败");
    }
  });
  void refreshUpState();
  upTimer = setInterval(() => void refreshUpState(), 3000);
  /* 数据体检：立即 + 30s 轮询；一键修复按钮（header 静态区，只绑一次） */
  document.getElementById("health-repair")!.addEventListener("click", () => void repairNow());
  void refreshHealth();
  healthTimer = setInterval(() => void refreshHealth(), 30000);
}

/* ── 外观 ── */
function renderLook(body: HTMLElement): void {
  const s = getState();
  const swc: [string, string][] = [["amber", "#FF9F43"], ["teal", "#2FD3C5"], ["indigo", "#8A94FF"], ["rose", "#F07C93"]];
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("circle-half", 15)}<h3>外观与主题</h3></div>` +
    `<div class="setrow"><span class="lab">主题</span><div class="ctl"><span class="seg" id="set-theme">` +
    `<button class="${s.theme === "dark" ? "on" : ""}" data-t="dark">深色 · 看盘默认</button>` +
    `<button class="${s.theme === "light" ? "on" : ""}" data-t="light">浅色 · 文档</button></span></div></div>` +
    `<div class="setrow"><span class="lab">强调色</span><div class="ctl"><span class="swatches">` +
    swc.map((c) => `<span class="sw${s.accent === c[0] ? " on" : ""}" data-ac="${c[0]}" style="background:color-mix(in srgb,${c[1]} 18%,transparent)"><i style="background:${c[1]}"></i></span>`).join("") +
    `</span><span style="font-size:11px;color:var(--faint)">色度纪律：大面积底色 ≤0.04 · 强调 0.08–0.15 · 点睛 ≤0.22</span></div></div>` +
    `<div class="setrow"><span class="lab">涨跌方向</span><div class="ctl"><span class="seg" id="set-dir">` +
    `<button class="${s.dir === "cn" ? "on" : ""}" data-d="cn">红涨绿跌 · A股</button>` +
    `<button class="${s.dir === "intl" ? "on" : ""}" data-d="intl">绿涨红跌 · 国际</button></span></div></div></div>`;
  document.getElementById("set-theme")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { patch("theme", b.dataset.t as "dark" | "light"); void render(); }
  });
  document.getElementById("set-dir")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { patch("dir", b.dataset.d as "cn" | "intl"); void render(); toast("涨跌方向已切换"); }
  });
  body.querySelectorAll<HTMLElement>(".sw[data-ac]").forEach((el) =>
    el.addEventListener("click", () => { patch("accent", el.dataset.ac as never); void render(); }));
}

/* ── VIP ── */
function renderVip(body: HTMLElement): void {
  const u = getState().user;
  const vip = isVip();
  const until = u?.pro_expires_at?.slice(0, 10);
  const since = u?.pro_starts_at?.slice(0, 10);
  const trial = u?.trial_until?.slice(0, 10);          // 注册体验到期日（体验中才非空）
  const remainDays = until ? Math.max(0, Math.ceil((Date.parse(`${until}T23:59:59`) - Date.now()) / 86400000)) : null;
  const trialDays = trial ? Math.max(0, Math.ceil((Date.parse(`${trial}T23:59:59`) - Date.now()) / 86400000)) : null;
  const windowText = !u ? "—"
    : u.role === "admin" ? "管理员 · 永久"
    : vip && until ? `${since || "立即生效"} → ${until}`
    : trial ? `注册体验 · 至 ${trial}`              // 体验期无真实起止，单显到期日
    : vip ? "永久 VIP"
    : "未开通 · 由管理员设置可用时间";
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("crown-simple", 15)}<h3>VIP 与订阅</h3><span class="sp"></span>` +
    `<span class="tag ${vip ? "vip" : "warn"}">${vip ? `VIP有效${until ? " · " + until + " 到期" : trial ? " · 体验期" : ""}` : u ? "免费版" : "未登录"}</span></div>` +
    `<div class="setrow"><span class="lab">可用时间</span><div class="ctl"><span style="font-size:12.5px;color:var(--dim)">${windowText}</span>` +
    (trialDays != null ? `<span style="font-size:11px;color:var(--warn)">剩余 ${trialDays} 天体验</span>` : "") +
    (vip && remainDays != null ? `<span style="font-size:11px;color:var(--warn)">剩余 ${remainDays} 天</span>` : "") + `</div></div>` +
    `<div class="setrow"><span class="lab">当前方案</span><div class="ctl"><span style="font-size:12.5px">${vip ? "VIP · 完整指标" : "免费版 · 公开名单与开源指标"}</span>` +
    `<span style="font-size:11px;color:var(--faint)">${vip ? "会员权益由系统实时核对" : "VIP 指标由系统计算，未开通不显示"}</span></div></div>` +
    `<div class="setrow"><span class="lab">解锁能力</span><div class="ctl"><span style="font-size:12px;color:var(--dim)">K线 VIP 通道 · 核心标三因子明细 · 六分段判定 · 短中线趋势</span></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl"><button class="hbtn primary" id="set-vip-go" data-ic="credit-card" data-sz="13">${vip ? "续费 / 叠加" : "立即开通"}</button>` +
    `<span style="font-size:10.5px;color:var(--faint)">兑换码（YC-XXXX-XXXX）核销后自动开通 / 续期</span></div></div></div>`;
  body.querySelector("#set-vip-go")!.addEventListener("click", () => openModal("modal-vip"));
  body.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
    if (!el.querySelector("svg")) el.innerHTML = ic(el.dataset.ic!, +(el.dataset.sz || 14)) + el.innerHTML;
  });
}

/* ── 账户 ── */
function renderAccount(body: HTMLElement): void {
  const u = getState().user;
  if (!u) {
    body.innerHTML =
      `<div class="setsec"><div class="sh">${ic("user", 15)}<h3>账户</h3></div>` +
      `<div class="empty" style="padding:30px"><b>未登录</b><span>登录后同步账户与 VIP 权益</span></div></div>`;
    return;
  }
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("user", 15)}<h3>账户</h3></div>` +
    `<div class="setrow"><span class="lab">邮箱</span><div class="ctl"><span>${esc(u.email)}</span></div></div>` +
    `<div class="setrow"><span class="lab">用户名</span><div class="ctl"><span>${esc(u.username || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab">用户编号</span><div class="ctl"><span class="num" style="font-size:11px">${esc(u.id)}</span></div></div>` +
    `<div class="setrow"><span class="lab">注册时间</span><div class="ctl"><span class="num">${esc(u.created_at?.slice(0, 10) || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab">安全</span><div class="ctl"><button class="hbtn" id="ac-out" data-ic="sign-out" data-sz="13">退出登录</button></div></div></div>` +
    `<div class="setsec"><div class="sh"><h3>合规声明</h3></div><div class="compliance">本产品仅提供基于公开数据的规则化分析与信息整理，不构成投资建议。付费文案统一为「数据分析工具使用权」。VIP 指标由系统统一计算，页面只负责展示。</div></div>`;
  body.querySelector("#ac-out")!.addEventListener("click", () => { logout(); void render(); });
  body.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
    if (!el.querySelector("svg")) el.innerHTML = ic(el.dataset.ic!, +(el.dataset.sz || 14)) + el.innerHTML;
  });
}

/* ── 管理端 · 普通/VIP 用户与可用时间 ── */
let adminUsers: AdminUser[] = [];
let adminEditing: string | null = null;
let trialDays = 7;

function awText(v?: string | null): string {
  return v ? v.slice(0, 16).replace("T", " ") : "";
}

function awValue(v?: string | null): string {
  return v ? v.slice(0, 16) : "";
}

function awWindow(u: AdminUser): string {
  if (!u.pro_starts_at && !u.pro_expires_at) return "未设置";
  return `${awText(u.pro_starts_at) || "立即"} → ${awText(u.pro_expires_at) || "永久"}`;
}

function awName(u: AdminUser): string {
  return u.username || u.email.split("@")[0] || u.email;
}

function awRow(u: AdminUser): string {
  const lab = `<span class="lab">${esc(awName(u))}<br>` +
    `<small style="color:var(--faint);font-weight:400">${esc(u.email)}</small></span>`;
  if (adminEditing === u.id) {
    return `<div class="setrow">${lab}<div class="ctl" style="flex-wrap:wrap;gap:6px">` +
      `<span style="font-size:11px;color:var(--faint)">生效</span>` +
      `<input class="field" id="aw-s" type="datetime-local" value="${awValue(u.pro_starts_at)}" style="width:168px">` +
      `<span style="font-size:11px;color:var(--faint)">到期</span>` +
      `<input class="field" id="aw-e" type="datetime-local" value="${awValue(u.pro_expires_at)}" style="width:168px">` +
      `<button class="hbtn primary" data-save="${u.id}">保存</button>` +
      `<button class="hbtn" data-clear="${u.id}">撤销 VIP</button>` +
      `<button class="hbtn" data-edit="${u.id}">取消</button></div></div>`;
  }
  return `<div class="setrow">${lab}<div class="ctl">` +
    `<span class="tag ${u.tier === "pro" ? "vip" : "flat"}">${u.tier === "pro" ? "VIP" : "普通"}</span>` +
    `<span style="font-size:11.5px;color:var(--dim)">${awWindow(u)}</span>` +
    `<button class="hbtn" data-edit="${u.id}">设置时间</button></div></div>`;
}

function awSection(title: string, list: AdminUser[]): string {
  return `<div style="margin-top:10px"><div class="sh"><h3 style="font-size:12px">${title}</h3>` +
    `<span class="sp"></span><span class="tag flat">${list.length}</span></div>` +
    (list.length ? list.map(awRow).join("") : `<div class="setrow"><span class="lab" style="color:var(--faint)">暂无</span></div>`) +
    `</div>`;
}

function bindAdminActions(body: HTMLElement): void {
  const refresh = (): void => { void renderAdminUsers(body); };
  body.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      adminEditing = adminEditing === b.dataset.edit ? null : b.dataset.edit!;
      refresh();
    }));
  body.querySelectorAll<HTMLElement>("[data-clear]").forEach((b) =>
    b.addEventListener("click", async () => {
      const u = adminUsers.find((x) => x.id === b.dataset.clear);
      if (!u || !window.confirm(`撤销 ${awName(u)} 的 VIP 权限？`)) return;
      b.setAttribute("disabled", "true");
      try {
        await adminApi.setWindow(u.id, { enabled: false, start_at: null, end_at: null });
        toast(`已撤销 ${awName(u)} 的 VIP 权限`);
        adminEditing = null;
        refresh();
      } catch (e) {
        toast((e as Error).message || "操作失败");
        b.removeAttribute("disabled");
      }
    }));
  body.querySelectorAll<HTMLElement>("[data-save]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.save!;
      const s = (body.querySelector<HTMLInputElement>("#aw-s")?.value || "").trim();
      const e = (body.querySelector<HTMLInputElement>("#aw-e")?.value || "").trim();
      if (s && e && s >= e) { toast("生效时间必须早于到期时间"); return; }
      b.setAttribute("disabled", "true");
      try {
        await adminApi.setWindow(id, { enabled: true, start_at: s || null, end_at: e || null });
        toast("已更新可用时间");
        adminEditing = null;
        refresh();
      } catch (err) {
        toast((err as Error).message || "保存失败");
        b.removeAttribute("disabled");
      }
    }));
  body.querySelector<HTMLElement>("#aw-trial-save")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLElement;
    const v = Number((body.querySelector<HTMLInputElement>("#aw-trial")?.value || "").trim());
    if (!Number.isFinite(v) || v < 0 || v > 365) { toast("体验期天数需在 0~365 之间"); return; }
    btn.setAttribute("disabled", "true");
    try {
      await adminApi.setTrial(Math.round(v));
      toast("已更新注册体验期（新用户生效）");
      refresh();
    } catch (err) {
      toast((err as Error).message || "保存失败");
      btn.removeAttribute("disabled");
    }
  });
}

async function renderAdminUsers(body: HTMLElement): Promise<void> {
  if (getState().user?.role !== "admin") {
    body.innerHTML = `<div class="setsec"><div class="empty" style="padding:40px"><b>仅管理员可见</b>` +
      `<span>该页面用于维护普通用户 / VIP 用户的可用时间</span></div></div>`;
    return;
  }
  try {
    [adminUsers, trialDays] = await Promise.all([adminApi.users(), adminApi.trial().then((r) => r.trial_days).catch(() => 7)]);
  } catch (e) {
    body.innerHTML = `<div class="setsec"><div style="font-size:12px;color:var(--up)">${esc((e as Error).message || "用户列表读取失败")}</div></div>`;
    return;
  }
  const vip = adminUsers.filter((u) => u.tier === "pro");
  const free = adminUsers.filter((u) => u.tier !== "pro");
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("user", 15)}<h3>用户管理</h3><span class="sp"></span>` +
    `<span class="tag flat">${adminUsers.length} 位</span></div>` +
    `<div style="font-size:11px;color:var(--faint);padding:2px 2px 8px">设置起止时间后，该用户在窗口内为 VIP，到期自动回落免费版；生效留空＝立即，到期留空＝永久。</div>` +
    /* 注册体验期（全局）：新用户注册起免费体验 N 天整站 VIP，全系统生效 */
    `<div class="setrow"><span class="lab">注册体验期</span><div class="ctl">` +
    `<input type="number" id="aw-trial" min="0" max="365" value="${trialDays}" style="width:70px;height:26px;border-radius:7px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);padding:0 8px;font-size:12px">` +
    `<span style="font-size:11px;color:var(--faint)">天</span>` +
    `<button class="hbtn" id="aw-trial-save" style="height:26px;padding:0 12px;font-size:11.5px">保存</button>` +
    `<span style="font-size:10.5px;color:var(--faint)" title="新注册用户按注册时间免费体验 N 天整站 VIP；设为 0 关闭体验">新注册用户默认免费体验 · 全系统生效</span>` +
    `</div></div>` +
    awSection("VIP 用户", vip) + awSection("普通用户", free) + `</div>`;
  bindAdminActions(body);
}

/* ── F10 · 飞书推送（webhook/secret 不回显，留空 = 保持不变） ── */
async function renderFeishu(body: HTMLElement): Promise<void> {
  if (!getState().user) {
    body.innerHTML =
      `<div class="setsec"><div class="empty" style="padding:50px">${ic("paper-plane-tilt", 30)}<b>飞书推送 · 未登录</b><span>登录后把每日核心标早报推到你的飞书群</span></div></div>`;
    return;
  }
  let cfg: FeishuCfg;
  try { cfg = await meApi.feishu(); } catch (e) {
    body.innerHTML = `<div class="setsec"><div style="font-size:12px;color:var(--up)">${esc((e as Error).message || "配置读取失败")}</div></div>`;
    return;
  }
  const [tagCls, tagTxt] = cfg.enabled && cfg.webhook_set ? ["ok", "已启用"]
    : cfg.webhook_set ? ["warn", "已配置 · 未启用"] : ["flat", "未配置"];
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("paper-plane-tilt", 15)}<h3>飞书推送</h3><span class="sp"></span>` +
    `<span class="tag ${tagCls}">${tagTxt}</span></div>` +
    `<div class="setrow"><span class="lab">机器人地址</span><div class="ctl">` +
    `<input class="field" id="fs-url" style="flex:1;min-width:260px" placeholder="${cfg.webhook_set ? "已配置 · 留空保持不变" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"}"></div></div>` +
    `<div class="setrow"><span class="lab">签名密钥</span><div class="ctl">` +
    `<input class="field" id="fs-secret" type="password" style="flex:1;min-width:260px" placeholder="${cfg.has_secret ? "已配置 · 留空保持不变" : "机器人开启「加签」时才填"}"></div></div>` +
    `<div class="setrow"><span class="lab">核心标早报</span><div class="ctl">` +
    `<span class="switch${cfg.enabled ? " on" : ""}" id="fs-sw"><i></i></span>` +
    `<span style="font-size:11px;color:var(--faint)">每个交易日 08:35 推送核心标名单</span></div></div>` +
    `<div class="setrow"><span class="lab">两点乾坤</span><div class="ctl">` +
    `<span class="switch${cfg.push_enabled ? " on" : ""}" id="fs-push-sw"><i></i></span>` +
    `<input class="field" id="fs-times" style="flex:1;min-width:220px" value="${esc(cfg.push_times.join(", "))}" ` +
    `placeholder="09:45, 10:30, 14:30（逗号分隔，最多 12 个）"></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl">` +
    `<span style="font-size:11px;color:var(--faint)">趋势柱线当日上穿零轴 + 中线趋势橙（站上中线趋势线）：交易日到点计算并推送，无命中不发消息</span></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl">` +
    `<button class="hbtn primary" id="fs-save">保存</button>` +
    `<button class="hbtn" id="fs-test">发送测试消息</button>` +
    `<button class="hbtn" id="fs-push-now">立即推送两点乾坤</button></div></div>` +
    `<div style="font-size:10.5px;color:var(--faint);line-height:1.7">获取方式：飞书群 → 设置 → 群机器人 → 添加自定义机器人 → 复制机器人地址。<br>` +
    `推送内容：核心标早报（追涨池 / 低吸池，含六分段与排名）+ 两点乾坤信号（盘中按实时行情判定）；无命中不打扰。</div></div>`;
  let enabled = cfg.enabled;
  let pushEnabled = cfg.push_enabled;
  document.getElementById("fs-sw")!.addEventListener("click", (e) => {
    enabled = !enabled;
    (e.currentTarget as HTMLElement).classList.toggle("on", enabled);
  });
  document.getElementById("fs-push-sw")!.addEventListener("click", (e) => {
    pushEnabled = !pushEnabled;
    (e.currentTarget as HTMLElement).classList.toggle("on", pushEnabled);
  });
  document.getElementById("fs-save")!.addEventListener("click", async () => {
    const rawTimes = (document.getElementById("fs-times") as HTMLInputElement).value;
    const times = parsePushTimes(rawTimes);
    if (times === null) {
      toast("时间格式需为 HH:MM，例如 09:45, 10:30, 14:30");
      return;
    }
    try {
      await meApi.putFeishu({
        webhook_url: (document.getElementById("fs-url") as HTMLInputElement).value.trim() || undefined,
        secret: (document.getElementById("fs-secret") as HTMLInputElement).value.trim() || undefined,
        enabled,
        push_enabled: pushEnabled,
        push_times: times,
      });
      toast("飞书推送配置已保存");
      void render();
    } catch (e) { toast((e as Error).message || "保存失败"); }
  });
  document.getElementById("fs-test")!.addEventListener("click", async () => {
    try {
      const r = await meApi.testFeishu();
      toast(`${r.ok ? "✓" : "✗"} ${r.message}`);
    } catch (e) { toast((e as Error).message || "测试请求失败"); }
  });
  document.getElementById("fs-push-now")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await meApi.pushFeishuTargets();
      toast(`${r.ok ? "✓" : "✗"} ${r.message}`);
    } catch (err) { toast((err as Error).message || "推送请求失败"); }
    finally { btn.disabled = false; }
  });
}

/** 解析时间点输入：逗号/分号/空白分隔，校验 HH:MM，去重升序，最多 12 个；非法返回 null */
function parsePushTimes(raw: string): string[] | null {
  const out = new Set<string>();
  for (const part of raw.split(/[,，;；\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    out.add(`${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`);
  }
  return [...out].sort().slice(0, 12);
}

/* ── F11 · 大模型 BYOK（key 不回显，留空 = 保持不变；"" = 清除由后端支持，前端不暴露防误触） ── */
async function renderLlm(body: HTMLElement): Promise<void> {
  if (!getState().user) {
    body.innerHTML =
      `<div class="setsec"><div class="empty" style="padding:50px">${ic("spark", 30)}<b>大模型 · 未登录</b><span>登录后可以配置你自己的大模型密钥（随账户云同步）</span></div></div>`;
    return;
  }
  let cfg: LlmCfg;
  try { cfg = await meApi.llm(); } catch (e) {
    body.innerHTML = `<div class="setsec"><div style="font-size:12px;color:var(--up)">${esc((e as Error).message || "配置读取失败")}</div></div>`;
    return;
  }
  const [tagCls, tagTxt] = cfg.enabled && cfg.key_set ? ["ok", "已启用"]
    : cfg.key_set ? ["warn", "已配置 · 未启用"] : ["flat", "未配置"];
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("spark", 15)}<h3>大模型（自带密钥）</h3><span class="sp"></span>` +
    `<span class="tag ${tagCls}">${tagTxt}</span></div>` +
    `<div class="setrow"><span class="lab">接口地址</span><div class="ctl">` +
    `<input class="field" id="llm-url" style="flex:1;min-width:260px" placeholder="https://api.deepseek.com/v1（OpenAI 兼容）" value="${esc(cfg.base_url)}"></div></div>` +
    `<div class="setrow"><span class="lab">API Key</span><div class="ctl">` +
    `<input class="field" id="llm-key" type="password" style="flex:1;min-width:260px" placeholder="${cfg.key_set ? "已配置 · 留空保持不变" : "sk-…"}">` +
    `<span style="font-size:11px;color:var(--faint)">只存你自己的账户，永不明文回显；更换直接输入新 Key 保存</span></div></div>` +
    `<div class="setrow"><span class="lab">模型</span><div class="ctl">` +
    `<input class="field" id="llm-model" style="flex:1;min-width:260px" placeholder="deepseek-chat / kimi-k2 / gpt-4o-mini …" value="${esc(cfg.model)}"></div></div>` +
    `<div class="setrow"><span class="lab">启用</span><div class="ctl">` +
    `<span class="switch${cfg.enabled ? " on" : ""}" id="llm-sw"><i></i></span>` +
    `<span style="font-size:11px;color:var(--faint)">启用后 Agent 中心等模块才能调用</span></div></div>` +
    `<div class="setrow"><span class="lab">问答提示词</span><div class="ctl" style="flex-direction:column;align-items:stretch;gap:6px">` +
    `<textarea class="field" id="llm-prompt" rows="6" spellcheck="false" style="width:100%;min-height:140px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6" placeholder="${esc(cfg.prompt_default)}">${esc(cfg.prompt)}</textarea>` +
    `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--faint)">` +
    `<button class="hbtn" id="llm-prompt-reset" type="button">恢复默认</button>` +
    `<span id="llm-prompt-state">${cfg.prompt ? "已自定义" : "当前为默认提示词"}</span>` +
    `<span class="sp"></span><span>留空 = 使用默认；数值一律由本地指标接口计算，模型只选工具和组织语言</span></div></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl">` +
    `<button class="hbtn primary" id="llm-save">保存</button>` +
    `<button class="hbtn" id="llm-test">测试连通</button></div></div>` +
    `<div style="font-size:10.5px;color:var(--faint);line-height:1.7">任何 OpenAI chat/completions 兼容端点均可（DeepSeek / Kimi / 通义 / OpenAI 等）。` +
    `测试直接用上方当前输入（改动不必先保存）。</div></div>`;
  let enabled = cfg.enabled;
  document.getElementById("llm-sw")!.addEventListener("click", (e) => {
    enabled = !enabled;
    (e.currentTarget as HTMLElement).classList.toggle("on", enabled);
  });
  const promptEl = document.getElementById("llm-prompt") as HTMLTextAreaElement;
  const promptState = document.getElementById("llm-prompt-state")!;
  const syncPromptState = () => {
    promptState.textContent = promptEl.value.trim() ? "已自定义" : "留空将使用默认提示词";
  };
  promptEl.addEventListener("input", syncPromptState);
  document.getElementById("llm-prompt-reset")!.addEventListener("click", () => {
    promptEl.value = "";
    syncPromptState();
  });
  document.getElementById("llm-save")!.addEventListener("click", async () => {
    try {
      await meApi.putLlm({
        base_url: (document.getElementById("llm-url") as HTMLInputElement).value.trim() || undefined,
        api_key: (document.getElementById("llm-key") as HTMLInputElement).value.trim() || undefined,
        model: (document.getElementById("llm-model") as HTMLInputElement).value.trim() || undefined,
        enabled,
        // "" 不是 undefined：显式清空 = 恢复后端默认提示词
        prompt: promptEl.value.trim(),
      });
      toast("大模型配置已保存");
      document.dispatchEvent(new CustomEvent("yc:llm-changed"));
      void render();
    } catch (e) { toast((e as Error).message || "保存失败"); }
  });
  document.getElementById("llm-test")!.addEventListener("click", async () => {
    try {
      const base_url = (document.getElementById("llm-url") as HTMLInputElement).value.trim();
      const api_key = (document.getElementById("llm-key") as HTMLInputElement).value.trim();
      const model = (document.getElementById("llm-model") as HTMLInputElement).value.trim();
      const r = await meApi.testLlm({ base_url, api_key, model });
      toast(`${r.ok ? "✓" : "✗"} ${r.message}`);
    } catch (e) { toast((e as Error).message || "测试请求失败"); }
  });
}

/* ── 顶栏数据状态 chip：唯一落笔口 ──
 * 以前 refreshDatachip 与 refreshUpChip 各自直接写 DOM：SSE 每推一次 data:update
 * 两个函数各写一遍，正文字符就在「行情底座 · 已就绪」和「更新中 · xx 45%」之间来回跳。
 * 现在两者只更新各自的字段，由 paintChip 按「更新中 > 排队 > 常态」优先级落笔，
 * 同一时刻只有一个来源能决定显示什么，不会再抖。 */
type ChipFace = { text: string; cls: string; title: string };
/** 任务名在顶栏用日常说法（后端 label 是给数据页/日志看的技术名，含「快照」这类黑话）；
 *  以 kind 为键，比按字符串替换稳 —— 「行情快照」「库快照备份」替换成「行情」会出洋相。 */
const PLAIN_KIND: Record<string, string> = {
  quotes: "实时行情",
  sector_index: "板块行情",
  kline_update: "日K线",
  backup: "数据备份",
  valuation: "全市场估值",
  capital_flow: "资金流",
};
/** 北京时间 HHMM（与会话时区无关）：A 股开盘口径不能跟用户本地钟点走 */
function bjHHMM(): number {
  const bj = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60_000);
  return bj.getHours() * 100 + bj.getMinutes();
}
/** 是否交易日：先用周末兜底，/data/status 返回后按后端交易日历（含法定节假日）校正 */
let mktTradingDay = (() => {
  const bj = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60_000);
  const wd = bj.getDay();
  return wd >= 1 && wd <= 5;
})();
/** market_snapshot 按时段换词：15:05 后收盘快照还会补一轮（expected_asof 15:10 才切
 *  当日），顶着「盘中行情」跑到 15:2x，盘后看着像还在盘中（2026-11-03 反馈）。
 *  周末/节假日没有盘中：一律「休市补采」，别在休市日报盘中（2026-11-08 反馈）。 */
const plainLabel = (kind: string, label: string): string => {
  if (kind === "market_snapshot") {
    if (!mktTradingDay) return "休市补采";
    const hhmm = bjHHMM();
    return hhmm >= 925 && hhmm < 1505 ? "盘中行情" : hhmm < 925 ? "盘前行情" : "收盘行情";
  }
  return PLAIN_KIND[kind] ?? label;
};
/** 采集阶段名同规范化：「采集行情快照」→「采集行情」、「拉取快照」→「拉取行情」 */
const plainStage = (s: string): string => s.replace(/行情快照/g, "行情").replace(/快照/g, "行情");
let chipIdle: ChipFace = { text: "行情数据 · 检测中", cls: "", title: "正在检测行情数据状态" };
let chipRun: ChipFace | null = null;
let chipQueue: ChipFace | null = null;

function paintChip(): void {
  const el = document.getElementById("datachip");
  const t = document.getElementById("datachip-t");
  if (!el || !t) return;
  const f = chipRun ?? chipQueue ?? chipIdle;
  if (t.textContent !== f.text) t.textContent = f.text;
  const cls = "datachip" + (f.cls ? " " + f.cls : "");
  if (el.className !== cls) el.className = cls;
  if (el.title !== f.title) el.title = f.title;
}

/** 顶栏数据状态 chip（轮询 /data/status） */
export async function refreshDatachip(): Promise<void> {
  let face: ChipFace;
  try {
    const st = await dataApi.status();
    if (typeof st.trading_day === "boolean") {
      if (mktTradingDay !== st.trading_day) {
        mktTradingDay = st.trading_day;
        void refreshUpChip();   // 交易日口径变了（周末 / 节假日），更新中的文案要跟着改
      }
    }
    // 「更新至」只认已收盘的日级数据（YYYY-MM-DD）。盘中快照那列是带时刻的
    // （如 2026-11-02 15:12），直接取 max 会把它排到最后，看起来像「盘后没更新、
    // 卡在 15 点」——快照本身收盘后就该停，日线要等 17:00 链位。
    const daily = st.tables.map((x) => x.latest_date)
      .filter((x): x is string => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    const latest = daily[daily.length - 1];
    const snap = st.tables.find((x) => x.table === "market_snapshot")?.latest_date ?? null;
    const [label, cls] = STAGE_TEXT[st.stage] ?? ["状态未知", "bad"];
    face = {
      text: `行情数据 · ${label}${latest ? " · 更新至 " + latest : ""}`,
      // i-ok：健康用绿点（--up 是 A 股涨的红，语义是行情不是状态，勿用于健康态）
      cls: cls === "ok" ? "i-ok" : cls === "warn" ? "i-mid" : "",
      title: latest
        ? `本地行情数据${label}，收盘数据更新至 ${latest}` +
          (snap ? `；盘中快照最后 ${snap}（收盘后停止轮询属正常）` : "") +
          `。点击查看数据底座与体检`
        : `本地行情数据${label}。点击查看数据底座`,
    };
  } catch {
    face = { text: "行情数据 · 连接失败", cls: "", title: "暂时连不上服务，点击查看数据底座" };
  }
  chipIdle = face;
  paintChip();
}

/* ── 顶栏全局进度徽章（策影同款）：更新任务运行/排队时 datachip 变进度胶囊 ──
 * 自适应轮询：活动态 3s 跟进度，空闲即停（恢复常规 status 显示）；
 * 唤醒源 = SSE data:update（任务开始/进度/结束都推）+ 启动与 60s status 兜底。 */
let upActive = false;
let upChipTimer: ReturnType<typeof setTimeout> | null = null;

export async function refreshUpChip(): Promise<void> {
  if (upChipTimer) { clearTimeout(upChipTimer); upChipTimer = null; }
  if (!document.getElementById("datachip")) return;
  let snap: UpdateSnapshot | null = null;
  try { snap = await dataApi.state(); } catch { /* 快照不可达保持原样 */ }
  const r = snap?.running;
  const q = snap?.queued?.length ?? 0;
  const active = !!(r || q);
  if (r) {
    const lb = plainLabel(r.kind, r.label);
    chipRun = {
      text: `正在更新 · ${lb} ${(r.percent ?? 0).toFixed(0)}%`,
      cls: "i-run",
      title: `${plainStage(r.stage || lb)}${r.total ? ` · ${r.done}/${r.total}` : ""} · 点击查看详情`,
    };
    chipQueue = null;
  } else if (q) {
    chipRun = null;
    chipQueue = { text: `${q} 个更新任务排队中`, cls: "i-mid", title: "任务排队中 · 点击查看详情" };
  } else {
    chipRun = null;
    chipQueue = null;
  }
  paintChip();
  if (active !== upActive) {
    upActive = active;
    if (!active) void refreshDatachip();   // 刚结束：刷新回「行情数据 · 正常 · 更新至 …」
  }
  if (active) upChipTimer = setTimeout(() => void refreshUpChip(), 3000);
}

export function initSettings(): void {
  // 用户角色异步到达（登录 / 会话恢复）时重建导航，管理员专属页签不用等手动切页才出现
  let lastRole = getState().user?.role;
  subscribe(() => {
    const role = getState().user?.role;
    if (role === lastRole) return;
    lastRole = role;
    void render();
  });
  void render();
  void refreshDatachip();
  void refreshUpChip();          // 启动即查一次更新活动（首屏就有徽章态）
  setInterval(() => {
    if (!upActive) void refreshDatachip();
  }, 60_000);
  // 登录后 tier 实时刷新
  void authApi.me().then((u) => setUser(u)).catch(() => { /* 未登录静默 */ });
}
