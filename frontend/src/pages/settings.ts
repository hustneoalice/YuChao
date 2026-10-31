/* 设置页：数据底座（真实 API）· 外观 · VIP · 账户 · 飞书推送（F10）· 大模型（F11） */
import { authApi, dataApi, meApi, type DataStatus, type HealthReport,
         type UpdateLogItem, type UpdateSnapshot, type LlmCfg, type FeishuCfg } from "../api";
import { esc, fmt } from "../fmt";
import { ic } from "../icons";
import { getState, patch, setUser, isVip } from "../store";
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
let tab = "data";
let tasks: { kind: string; label: string; description: string }[] = [];

export function openSettingsTab(t: string): void {
  tab = t;
  void render();
}

const STAGE_TEXT: Record<string, [string, string]> = {
  uninitialized: ["未初始化", "bad"],
  initializing: ["初始化中", "warn"],
  ready: ["已就绪", "ok"],
  updating: ["更新中", "warn"],
  update_failed: ["更新失败", "bad"],
};

async function render(): Promise<void> {
  document.getElementById("setnav")!.innerHTML = NAV.map((n) =>
    `<button data-set="${n[0]}" class="${tab === n[0] ? "on" : ""}">${ic(n[2], 15)}<span>${n[1]}</span></button>`).join("");
  document.querySelectorAll<HTMLElement>("#setnav button").forEach((b) =>
    b.addEventListener("click", () => { tab = b.dataset.set!; void render(); }));
  const body = document.getElementById("setbody")!;
  body.innerHTML = `<div class="setsec" style="color:var(--faint);font-size:12px">加载中…</div>`;
  if (tab === "data") await renderData(body);
  else if (tab === "look") renderLook(body);
  else if (tab === "vip") renderVip(body);
  else if (tab === "account") renderAccount(body);
  else if (tab === "feishu") await renderFeishu(body);
  else if (tab === "llm") await renderLlm(body);
}

/* ── 数据底座 ── */
/* 表名 → 中文标签（与后端 _INVENTORY 对齐，仅展示用） */
const TABLE_ZH: Record<string, string> = {
  daily_ohlcv: "日线 K 线", adjust_factor: "复权因子", capital_flow: "个股资金流",
  financials: "财务数据", stock_universe: "证券清单", sector_index: "行业板块",
  daily_valuation: "全市场估值", corepicks_result: "核心标结果", stock_profile: "个股档案",
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

/* 更新记录里的数据类型 → 散户能懂的叫法（兜底显示原文） */
const DATA_TYPE_ZH: Record<string, string> = {
  daily_ohlcv: "日 K 线", kline: "日 K 线", capital_flow: "资金流向",
  daily_valuation: "估值数据", financials: "财务数据", stock_universe: "证券清单",
  sector_index: "行业板块", adjust_factor: "复权因子", corepicks: "核心标选股",
  corepicks_result: "核心标选股", stock_profile: "个股档案", valuation: "估值数据",
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

/** 日志级别 → 颜色类（info 灰 / success 绿 / warning 黄 / error 红） */
const logCls = (lv?: string): string => (["success", "warning", "error"].includes(lv || "") ? lv! : "info");

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
    parts.push(
      `<div class="uprow">` +
      `<i class="logdot ${st.dot}"${isRun ? ' style="animation:pulse 1.2s infinite"' : ""}></i>` +
      `<b style="font-size:12.5px">${esc(r.label)}</b>` +
      `<span class="upstat ${st.cap}">${esc(st.label)}</span>` +
      `<span style="font-size:11px;color:var(--faint)">${esc(r.trigger === "manual" ? "手动触发" : "自动触发")}</span>` +
      `<span style="flex:1"></span><b class="num" style="font-size:12.5px">${(r.percent ?? 0).toFixed(1)}%</b>` +
      (isRun ? `<button class="hbtn upstop" id="up-stop" title="排队任务直接移除，运行中的采集会尽快退出">停止</button>` : "") + `</div>`,
      `<div class="upbar"><i style="width:${pct}%"></i></div>`,
      `<div style="display:flex;justify-content:space-between;font-size:11px">` +
      `<span style="color:var(--dim)">${esc(r.stage || "")}</span>` +
      (r.total ? `<span style="color:var(--faint)"><b class="num" style="color:var(--text)">${fmt(r.done ?? 0, 0)}</b>/${fmt(r.total, 0)}</span>` : "") +
      `</div>`,
      `<div class="upstats">` +
      `<div><div class="k">成功 / 失败</div><div class="v">` +
      `<span style="color:var(--down)">${fmt(r.succeeded ?? 0, 0)}</span><span style="color:var(--faint)"> / </span>` +
      `<span style="color:${r.failed ? "var(--up)" : "var(--faint)"}">${fmt(r.failed ?? 0, 0)}</span></div></div>` +
      `<div><div class="k">已写入数据</div><div class="v">${r.rows != null ? fmtW(r.rows) : "—"}</div></div>` +
      `<div><div class="k">${isRun ? "已用时间" : "总耗时"}</div><div class="v">${fmtDur(r.elapsed_s)}</div></div></div>`,
    );
    if (r.message) parts.push(`<div style="font-size:11px;color:var(--faint)">${esc(r.message)}</div>`);
    const logs = (r.logs ?? []).slice(-8).reverse();
    if (logs.length)
      parts.push(`<div class="uplogs">${logs.map((l) =>
        `<div><i class="${logCls(l.level)}">${esc(l.time || "")}</i> ${esc(l.message || "")}</div>`).join("")}</div>`);
    if (r.error) parts.push(`<div style="font-size:11px;color:var(--up);background:var(--up-soft);border-radius:8px;padding:7px 9px;line-height:1.5;word-break:break-all">${esc(r.error.slice(0, 300))}</div>`);
  } else if (queued.length) {
    parts.push(queued.map((q) =>
      `<div class="uprow"><i class="logdot warn"></i>` +
      `<span>排队等待：<b style="color:var(--text)">${esc(q.label)}</b></span></div>`).join(""));
  } else {
    parts.push(`<div style="font-size:12px;color:var(--dim);line-height:1.6">数据都是最新的。每个交易日收盘后会自动补齐最新行情，错过的也会自动补上，平时不需要手动操作。</div>`);
    if (recent.length) {
      parts.push(`<details><summary class="uprecent">最近 ${Math.min(recent.length, 5)} 次更新记录</summary>` +
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
    ["新鲜度", h.freshness?.score ?? 0,
      kline ? `行情 ${ (kline.latest || "").slice(5, 10) } · 滞后${kline.lag_days}日` : "—",
      kline && kline.lag_days === 0 ? "ok" : kline && kline.lag_days <= 1 ? "mid" : "bad"],
    ["覆盖率", h.coverage?.score ?? 0,
      covWorst ? `${esc(TABLE_ZH[covWorst.table] || covWorst.table)} ${Math.round(covWorst.coverage ?? 0)}%` : "全表完整",
      (covWorst?.coverage ?? 100) >= 90 ? "ok" : (covWorst?.coverage ?? 100) >= 50 ? "mid" : "bad"],
    ["断档", h.gap?.score ?? 0,
      gapMiss ? `近10日 ${gapMiss} 处异常` : "近10日无断档",
      gapMiss ? "bad" : "ok"],
    ["落账", h.ledger?.score ?? 0,
      h.ledger?.updater_alive ? (ret ? `在线 · 自动重试${ret}次` : "进程在线") : "进程离线",
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
      const labels = r.submitted.map((s) => DATA_TYPE_ZH[s.kind] || s.kind).join("、");
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
    /* ① 数据更新（置顶 · 策影 UpdateProgressCard 同构）：现在更新什么/跑到哪了；没在更新时为什么不用管 */
    `<div class="setsec"><div class="sh">${ic("paper-plane-tilt", 15)}<h3>数据更新</h3>` +
    `<span id="up-chip" style="display:inline-flex"></span><span class="sp"></span><span class="sub num" id="up-saved"></span></div>` +
    `<div class="upcard" id="up-body"><span style="color:var(--faint);font-size:11.5px">正在读取更新状态…</span></div>` +
    `<div class="setrow" style="border-top:1px solid var(--border-soft);margin-top:12px;padding-top:10px"><span class="lab">手动更新</span><div class="ctl" style="gap:8px">` +
    `<button class="hbtn primary" data-run="kline_update" title="拉取全市场日线增量（核心数据，收盘后自动执行）">立即更新</button>` +
    `<details style="display:inline-block"><summary class="hbtn" data-sz="13" style="display:inline-flex;cursor:pointer;list-style:none">更多 ▾</summary>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">` +
    tasks.filter((t) => t.kind !== "kline_update").map((t) => `<button class="hbtn" data-run="${t.kind}" title="${esc(t.description)}">${esc(t.label)}</button>`).join("") +
    `</div></details></div></div>` +
    `<div style="font-size:10.5px;color:var(--faint)">平时不需要手动操作；更新失败会自动重试，错过的链位自动补上</div></div>` +
    /* ①.5 数据体检（P1）：四维卡片（分数+具体事实）+ 问题清单 + 一键修复 */
    `<div class="setsec"><div class="sh">${ic("database", 15)}<h3>数据体检</h3>` +
    `<span id="health-chip" style="display:inline-flex"></span><span class="sp"></span>` +
    `<button class="hbtn primary" id="health-repair" data-sz="13">一键修复</button></div>` +
    `<div class="upcard" id="health-body"><span style="color:var(--faint);font-size:11.5px">正在体检…</span></div>` +
    `<div style="font-size:10.5px;color:var(--faint);margin-top:8px">体检看四件事：数据新不新鲜、覆盖全不全、有没有断档、更新进程是否健康；发现的问题点「一键修复」自动补齐</div></div>` +
    /* ② 数据内容：每类数据更新到哪天（只展示有数据的卡；卖点 = 数据范围年限） */
    `<div class="setsec"><div class="sh"><h3>数据内容</h3>` +
    `<span class="sub">${esc(rangeSub)} · ${fmtW(totalRows)} 条</span><span class="sp"></span>` +
    `<span class="datachip i-${stage[1] === "ok" ? "up" : stage[1] === "warn" ? "mid" : ""}"><i></i><span>${esc(stage[0])}</span></span></div>` +
    `<div class="dsgrid">` +
    (filled.length ? filled.map((t) => {
      const n = daysAgo(t.latest_date);
      const cls = freshCls(n);
      const cov = typeof t.coverage === "number" ? t.coverage : null;
      const covCls = cov == null ? "" : cov >= 90 ? "" : cov >= 50 ? "mid" : "bad";
      return `<div class="dscard"><div class="ds-h"><i class="logdot ${cls}"></i><b>${esc(TABLE_ZH[t.table] || t.table)}</b></div>` +
        `<div class="ds-date num">${esc(t.latest_date || "—")}</div>` +
        `<div class="ds-m"><span class="num">${fmtW(t.rows ?? 0)} 条</span>` +
        `<span class="fresh ${cls}">${freshLabel(n)}</span></div>` +
        (cov != null ? `<div class="ds-cov ${covCls}"><div class="bar"><i style="width:${Math.max(cov, 1.5)}%"></i></div>` +
          `<span class="num">${cov >= 99 ? "完整" : cov.toFixed(0) + "%"}</span></div>` : "") +
        `</div>`;
    }).join("") : `<div style="color:var(--faint);font-size:12px">数据还在准备中 — 用上方「手动更新」按钮开始第一次更新</div>`) +
    `</div></div>` +
    /* ④ 更新记录：每天自动更新了什么、成功与否、新增多少 */
    `<div class="setsec"><div class="sh"><h3>更新记录</h3><span class="sub">最近的自动 / 手动更新历史</span></div>` +
    `<table><thead><tr><th>时间</th><th>更新内容</th><th>结果</th><th class="n">新增数据</th><th>备注</th></tr></thead><tbody>` +
    (logs.length ? logs.slice(0, 8).map((l) => {
      const [txt, cls] = STATUS_TEXT[String(l.status)] ?? [String(l.status || "—"), "flat"];
      return `<tr><td class="num">${esc(String(l.created_at || l.started_at || "—")).replace("T", " ").slice(0, 16)}</td>` +
        `<td>${esc(DATA_TYPE_ZH[String(l.data_type || "")] || String(l.data_type || "—"))}</td>` +
        `<td><span class="tag ${cls}">${esc(txt)}</span></td>` +
        `<td class="n num">${l.rows != null ? "+" + fmtW(l.rows) : "—"}</td>` +
        `<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;color:var(--faint)">${esc(String(l.detail || l.error || l.message || ""))}</td></tr>`;
    }).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--faint)">${esc("还没有更新记录 — 点上方「手动更新」试试")}</td></tr>`) +
    `</tbody></table></div>`;

  body.querySelectorAll<HTMLElement>("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await dataApi.trigger(b.dataset.run!);
        toast(`已触发 ${b.textContent} · updater 将消费执行`);
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
      toast("已请求停止 · updater 将消费");
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
    `<div class="setsec"><div class="sh">${ic("circle-half", 15)}<h3>外观与主题</h3><span class="mono">F08 · user_prefs</span></div>` +
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
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("crown-simple", 15)}<h3>VIP 与订阅</h3><span class="mono">F09 · license</span><span class="sp"></span>` +
    `<span class="tag ${vip ? "vip" : "warn"}">${vip ? `VIP有效${until ? " · " + until + " 到期" : ""}` : u ? "免费版" : "未登录"}</span></div>` +
    `<div class="setrow"><span class="lab">当前方案</span><div class="ctl"><span style="font-size:12.5px">${vip ? "VIP · 完整指标" : "免费版 · 公开名单与开源指标"}</span>` +
    `<span style="font-size:11px;color:var(--faint)">${vip ? "tier 服务端实时校验" : "VIP 指标服务端计算，未授权不返回数据"}</span></div></div>` +
    `<div class="setrow"><span class="lab">解锁能力</span><div class="ctl"><span style="font-size:12px;color:var(--dim)">K线 VIP 通道 · 核心标三因子明细 · 六分段判定 · 短中线趋势</span></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl"><button class="hbtn primary" id="set-vip-go" data-ic="credit-card" data-sz="13">${vip ? "续费 / 叠加" : "立即开通"}</button>` +
    `<span style="font-size:10.5px;color:var(--faint)">兑换码（YC-XXXX-XXXX）核销 → license 自动签发 / 续期</span></div></div></div>`;
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
      `<div class="setsec"><div class="sh">${ic("user", 15)}<h3>账户</h3><span class="mono">F12 · JWT</span></div>` +
      `<div class="empty" style="padding:30px"><b>未登录</b><span>登录后同步账户与 VIP 权益</span></div></div>`;
    return;
  }
  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("user", 15)}<h3>账户</h3><span class="mono">F12 · JWT</span></div>` +
    `<div class="setrow"><span class="lab">邮箱</span><div class="ctl"><span>${esc(u.email)}</span></div></div>` +
    `<div class="setrow"><span class="lab">用户名</span><div class="ctl"><span>${esc(u.username || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab">用户 ID</span><div class="ctl"><span class="num" style="font-size:11px">${esc(u.id)}</span></div></div>` +
    `<div class="setrow"><span class="lab">注册时间</span><div class="ctl"><span class="num">${esc(u.created_at?.slice(0, 10) || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab">安全</span><div class="ctl"><button class="hbtn" id="ac-out" data-ic="sign-out" data-sz="13">退出登录</button></div></div></div>` +
    `<div class="setsec"><div class="sh"><h3>合规声明</h3></div><div class="compliance">本产品仅提供基于公开数据的规则化分析与信息整理，不构成投资建议。付费文案统一为「数据分析工具使用权」。主仓库开源，VIP 指标计算位于闭源包，前端只渲染不计算。</div></div>`;
  body.querySelector("#ac-out")!.addEventListener("click", () => { logout(); void render(); });
  body.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
    if (!el.querySelector("svg")) el.innerHTML = ic(el.dataset.ic!, +(el.dataset.sz || 14)) + el.innerHTML;
  });
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
    `<div class="setsec"><div class="sh">${ic("paper-plane-tilt", 15)}<h3>飞书推送</h3><span class="mono">F10 · user_prefs.feishu</span><span class="sp"></span>` +
    `<span class="tag ${tagCls}">${tagTxt}</span></div>` +
    `<div class="setrow"><span class="lab">Webhook 地址</span><div class="ctl">` +
    `<input class="field" id="fs-url" style="flex:1;min-width:260px" placeholder="${cfg.webhook_set ? "已配置 · 留空保持不变" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"}"></div></div>` +
    `<div class="setrow"><span class="lab">签名密钥</span><div class="ctl">` +
    `<input class="field" id="fs-secret" type="password" style="flex:1;min-width:260px" placeholder="${cfg.has_secret ? "已配置 · 留空保持不变" : "机器人开启「加签」时才填"}"></div></div>` +
    `<div class="setrow"><span class="lab">启用</span><div class="ctl">` +
    `<span class="switch${cfg.enabled ? " on" : ""}" id="fs-sw"><i></i></span>` +
    `<span style="font-size:11px;color:var(--faint)">每个交易日 08:35 推送核心标早报</span></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl">` +
    `<button class="hbtn primary" id="fs-save">保存</button>` +
    `<button class="hbtn" id="fs-test">发送测试消息</button></div></div>` +
    `<div style="font-size:10.5px;color:var(--faint);line-height:1.7">获取方式：飞书群 → 设置 → 群机器人 → 添加自定义机器人 → 复制 Webhook 地址。<br>` +
    `推送内容：核心标早报（追涨池 / 低吸池，含六分段与排名）；名单为空不打扰。</div></div>`;
  let enabled = cfg.enabled;
  document.getElementById("fs-sw")!.addEventListener("click", (e) => {
    enabled = !enabled;
    (e.currentTarget as HTMLElement).classList.toggle("on", enabled);
  });
  document.getElementById("fs-save")!.addEventListener("click", async () => {
    try {
      await meApi.putFeishu({
        webhook_url: (document.getElementById("fs-url") as HTMLInputElement).value.trim() || undefined,
        secret: (document.getElementById("fs-secret") as HTMLInputElement).value.trim() || undefined,
        enabled,
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
}

/* ── F11 · 大模型 BYOK（key 不回显，留空 = 保持不变；"" = 清除由后端支持，前端不暴露防误触） ── */
async function renderLlm(body: HTMLElement): Promise<void> {
  if (!getState().user) {
    body.innerHTML =
      `<div class="setsec"><div class="empty" style="padding:50px">${ic("spark", 30)}<b>大模型 · 未登录</b><span>登录后配置你自己的大模型 Key（BYOK，随账户云同步）</span></div></div>`;
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
    `<div class="setsec"><div class="sh">${ic("spark", 15)}<h3>大模型（BYOK）</h3><span class="mono">F11 · user_prefs.llm</span><span class="sp"></span>` +
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
    `<div class="setrow"><span class="lab"></span><div class="ctl">` +
    `<button class="hbtn primary" id="llm-save">保存</button>` +
    `<button class="hbtn" id="llm-test">测试连通</button></div></div>` +
    `<div style="font-size:10.5px;color:var(--faint);line-height:1.7">任何 OpenAI chat/completions 兼容端点均可（DeepSeek / Kimi / 通义 / OpenAI 等）。` +
    `测试会用已保存配置真实请求一次（max_tokens=1），请先保存再测试。</div></div>`;
  let enabled = cfg.enabled;
  document.getElementById("llm-sw")!.addEventListener("click", (e) => {
    enabled = !enabled;
    (e.currentTarget as HTMLElement).classList.toggle("on", enabled);
  });
  document.getElementById("llm-save")!.addEventListener("click", async () => {
    try {
      await meApi.putLlm({
        base_url: (document.getElementById("llm-url") as HTMLInputElement).value.trim() || undefined,
        api_key: (document.getElementById("llm-key") as HTMLInputElement).value.trim() || undefined,
        model: (document.getElementById("llm-model") as HTMLInputElement).value.trim() || undefined,
        enabled,
      });
      toast("大模型配置已保存");
      void render();
    } catch (e) { toast((e as Error).message || "保存失败"); }
  });
  document.getElementById("llm-test")!.addEventListener("click", async () => {
    try {
      const r = await meApi.testLlm();
      toast(`${r.ok ? "✓" : "✗"} ${r.message}`);
    } catch (e) { toast((e as Error).message || "测试请求失败"); }
  });
}

/** 顶栏数据状态 chip（轮询 /data/status） */
export async function refreshDatachip(): Promise<void> {
  const el = document.getElementById("datachip")!;
  const t = document.getElementById("datachip-t")!;
  try {
    const st = await dataApi.status();
    const latest = st.tables.map((x) => x.latest_date).filter(Boolean).sort().pop();
    const [label, cls] = STAGE_TEXT[st.stage] ?? ["未知", "bad"];
    t.textContent = `行情底座 · ${label}${latest ? " · " + latest : ""}`;
    el.className = "datachip" + (cls === "ok" ? " i-up" : cls === "warn" ? " i-mid" : "");
  } catch {
    t.textContent = "行情底座 · 不可达";
    el.className = "datachip";
  }
}

/* ── 顶栏全局进度徽章（策影同款）：更新任务运行/排队时 datachip 变进度胶囊 ──
 * 自适应轮询：活动态 3s 跟进度，空闲即停（恢复常规 status 显示）；
 * 唤醒源 = SSE data:update（任务开始/进度/结束都推）+ 启动与 60s status 兜底。 */
let upActive = false;
let upChipTimer: ReturnType<typeof setTimeout> | null = null;

export async function refreshUpChip(): Promise<void> {
  if (upChipTimer) { clearTimeout(upChipTimer); upChipTimer = null; }
  const el = document.getElementById("datachip");
  const t = document.getElementById("datachip-t");
  if (!el || !t) return;
  let snap: UpdateSnapshot | null = null;
  try { snap = await dataApi.state(); } catch { /* 快照不可达保持原样 */ }
  const r = snap?.running;
  const q = snap?.queued?.length ?? 0;
  const active = !!(r || q);
  if (r) {
    t.textContent = `更新中 · ${r.label} ${(r.percent ?? 0).toFixed(0)}%`;
    el.className = "datachip i-run";
    el.title = `${r.stage || r.label}${r.total ? ` · ${r.done}/${r.total}` : ""} · 点击查看详情`;
  } else if (q) {
    t.textContent = `更新排队 · ${q} 项`;
    el.className = "datachip i-mid";
    el.title = "任务排队中 · 点击查看详情";
  }
  if (active !== upActive) {
    upActive = active;
    if (!active) void refreshDatachip();   // 刚结束：恢复「行情底座 · 健康 · 日期」
  }
  if (active) upChipTimer = setTimeout(() => void refreshUpChip(), 3000);
}

export function initSettings(): void {
  void render();
  void refreshDatachip();
  void refreshUpChip();          // 启动即查一次更新活动（首屏就有徽章态）
  setInterval(() => {
    if (!upActive) void refreshDatachip();
  }, 60_000);
  // 登录后 tier 实时刷新
  void authApi.me().then((u) => setUser(u)).catch(() => { /* 未登录静默 */ });
}
