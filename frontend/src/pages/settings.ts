/* 设置页：数据底座（真实 API）· 外观 · VIP · 账户 · 规划中页签 */
import { authApi, dataApi, type DataStatus, type UpdateLogItem } from "../api";
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
  else renderPlanned(body, tab);
}

/* ── 数据底座 ── */
async function renderData(body: HTMLElement): Promise<void> {
  let st: DataStatus | null = null;
  let tasksR: Awaited<ReturnType<typeof dataApi.tasks>> | null = null;
  let logs: UpdateLogItem[] = [];
  try {
    [st, tasksR] = await Promise.all([dataApi.status(), dataApi.tasks()]);
    tasks = tasksR.items;
  } catch { /* 展示错误态 */ }
  try {
    logs = (await dataApi.updates(30)).items;
  } catch { logs = []; }
  const stage = STAGE_TEXT[st?.stage ?? "uninitialized"] ?? ["未知", "bad"];
  const totalRows = (st?.tables ?? []).reduce((s, t) => s + (t.rows ?? 0), 0);
  const latest = (st?.tables ?? []).map((t) => t.latest_date).filter(Boolean).sort().pop() || "—";

  body.innerHTML =
    `<div class="setsec"><div class="sh">${ic("database", 15)}<h3>数据底座</h3><span class="mono">DuckDB · 共享只读</span><span class="sp"></span>` +
    `<span class="datachip i-${stage[1] === "ok" ? "up" : stage[1] === "warn" ? "mid" : ""}" id="db-state"><i></i><span>${stage[0]}</span></span></div>` +
    `<div class="setrow"><span class="lab">库路径</span><div class="ctl"><span class="num" style="font-size:11px">${esc(st?.duckdb_path || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab">数据日期</span><div class="ctl"><span class="num">${latest}</span></div></div>` +
    `<div class="setrow"><span class="lab">记录总数</span><div class="ctl"><span class="num">${fmt(totalRows, 0)}</span><span style="color:var(--faint);font-size:11px">${(st?.tables ?? []).length} 张表</span></div></div>` +
    `<div class="setrow"><span class="lab">数据表</span><div class="ctl" style="flex-direction:column;align-items:stretch">` +
    (st?.tables ?? []).map((t) =>
      `<div style="display:flex;gap:10px;font-size:11.5px;align-items:center"><span class="mono" style="width:150px">${esc(t.table)}</span><span class="num" style="color:var(--dim)">${fmt(t.rows ?? 0, 0)} 行</span><span style="color:var(--faint)">最新 ${esc(t.latest_date || "—")}</span></div>`).join("") +
    `</div></div>` +
    `<div class="setrow"><span class="lab">调度链</span><div class="ctl"><span style="font-size:12px;color:var(--dim)">${esc(tasksR?.schedule || "—")}</span></div></div>` +
    `<div class="setrow"><span class="lab"></span><div class="ctl" style="gap:10px">` +
    tasks.map((t) => `<button class="hbtn" data-run="${t.kind}" title="${esc(t.description)}">${esc(t.label)}</button>`).join("") +
    `<span style="font-size:10.5px;color:var(--faint)">触发后经控制通道交 updater 进程执行（约 2s 消费）</span></div></div></div>` +
    `<div class="setsec"><div class="sh"><h3>更新日志</h3><span class="mono">update_log</span></div>` +
    `<table><thead><tr><th>时间</th><th>类型</th><th>状态</th><th class="n">新增记录</th><th>说明</th></tr></thead><tbody>` +
    (logs.length ? logs.map((l) => {
      const ok = l.status === "success" || l.status === "ok";
      return `<tr><td class="num">${esc(String(l.started_at || l.finished_at || "—")).replace("T", " ").slice(0, 16)}</td>` +
        `<td>${esc(String(l.data_type || "—"))}</td>` +
        `<td><span class="tag ${ok ? "" : "bad"}">${ok ? "成功" : esc(String(l.status || "—"))}</span></td>` +
        `<td class="n num">${l.rows != null ? "+" + fmt(l.rows, 0) : "—"}</td>` +
        `<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;color:var(--faint)">${esc(String(l.message || ""))}</td></tr>`;
    }).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--faint)">${esc("update_log 未初始化——运行 python -m app.updater")}</td></tr>`) +
    `</tbody></table></div>`;

  body.querySelectorAll<HTMLElement>("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await dataApi.trigger(b.dataset.run!);
        toast(`已触发 ${b.textContent} · updater 将消费执行`);
        setTimeout(() => void render(), 3000);
      } catch (e) {
        toast((e as Error).message || "触发失败");
      }
    }));
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
    `<div class="setrow"><span class="lab">解锁能力</span><div class="ctl"><span style="font-size:12px;color:var(--dim)">K线 VIP 通道 · 核心标三因子明细 · 六分段判定 · 趋势通道</span></div></div>` +
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

/* ── 规划中（飞书 / LLM：F10/F11 后端就绪后对接） ── */
function renderPlanned(body: HTMLElement, t: string): void {
  const name = NAV.find((n) => n[0] === t)?.[1] || t;
  body.innerHTML =
    `<div class="setsec"><div class="empty" style="padding:50px">${ic("spark", 30)}<b>${esc(name)} · 规划中</b><span>对应功能模块（F10 / F11）尚未上线，后端就绪后在此接入</span></div></div>`;
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

export function initSettings(): void {
  void render();
  void refreshDatachip();
  setInterval(() => void refreshDatachip(), 60_000);
  // 登录后 tier 实时刷新
  void authApi.me().then((u) => setUser(u)).catch(() => { /* 未登录静默 */ });
}
