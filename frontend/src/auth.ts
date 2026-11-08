/* 登录 / 注册 + VIP 徽章 + 兑换 + 云设置同步触发 */
import { authApi, licenseApi, type UserPublic } from "./api";
import { esc } from "./fmt";
import { getState, isVip, setUser, emit } from "./store";
import { flushSync, pullOnLogin } from "./sync";
import { toast, openModal, closeModals } from "./ui";

let mode: "login" | "register" = "login";

function drawUserchip(): void {
  const u = getState().user;
  const chip = document.getElementById("userchip")!;
  const name = document.getElementById("user-name")!;
  const ava = document.getElementById("user-ava")!;
  if (u) {
    const un = u.username || u.email.split("@")[0];
    name.textContent = un;
    ava.textContent = un.slice(0, 1).toUpperCase();
    const tierText = u.role === "admin" ? "管理员" : u.tier === "pro" ? "VIP" : "免费版";
    chip.title = `${u.email} · ${tierText} · 点击进入账户设置`;
  } else {
    name.textContent = "未登录";
    ava.textContent = "?";
    chip.title = "点击登录 / 注册";
  }
}

export function refreshVipUI(): void {
  const u = getState().user;
  const badge = document.getElementById("vipbadge")!;
  const tag = document.getElementById("vip-state-tag")!;
  const badgeT = document.getElementById("vipbadge-t")!;
  if (u?.role === "admin") {
    // 管理员 = 永久 VIP：金色皇冠，显示「管理员」而不是免费版
    badge.classList.remove("off");
    badgeT.textContent = "管理员";
    tag.textContent = "管理员 · 永久 VIP";
    tag.className = "tag vip";
  } else if (isVip()) {
    // pro_expires_at 为空＝永久 VIP；注册体验期（trial_until）单独标注，不冒充真实 VIP
    const until = u?.pro_expires_at ? u.pro_expires_at.slice(0, 10) : "";
    const trial = u?.trial_until ? u.trial_until.slice(0, 10) : "";
    badge.classList.remove("off");
    badgeT.textContent = until ? `VIP · 至 ${until}` : trial ? `体验至 ${trial}` : "VIP";
    tag.textContent = until ? `VIP有效 · ${until} 到期`
      : trial ? `注册体验 · ${trial} 到期` : "VIP有效 · 永久";
    tag.className = "tag vip";
  } else if (u) {
    // 免费版不戴皇冠、不用金色：灰色胶囊只标「免费版」
    badge.classList.add("off");
    badgeT.textContent = "免费版";
    tag.textContent = "免费版 · 无 VIP 指标";
    tag.className = "tag flat";
  } else {
    badge.classList.add("off");
    badgeT.textContent = "未登录";
    tag.textContent = "未登录";
    tag.className = "tag warn";
  }
  drawUserchip();
}

function drawAuth(): void {
  document.getElementById("auth-title")!.textContent = mode === "login" ? "登录" : "注册";
  document.getElementById("auth-desc")!.textContent =
    mode === "login"
      ? "登录后自选、外观与图表设置云同步，多端一致。"
      : "注册即创建账户（JWT 鉴权）；邮箱为登录标识，用户名可选。";
  document.querySelectorAll("#auth-tabs button").forEach((b) =>
    b.classList.toggle("on", (b as HTMLElement).dataset.t === mode));
  (document.getElementById("auth-user") as HTMLElement).style.display = mode === "register" ? "" : "none";
  (document.getElementById("auth-remember-row") as HTMLElement).style.display =
    mode === "login" ? "" : "none";
  document.getElementById("auth-go")!.textContent = mode === "login" ? "登录" : "注册";
  const err = document.getElementById("auth-err")!;
  err.style.display = "none";
}

export function openAuth(m: "login" | "register" = "login"): void {
  mode = m;
  drawAuth();
  openModal("modal-auth");
}

async function submitAuth(): Promise<void> {
  const err = document.getElementById("auth-err")!;
  const pwd = (document.getElementById("auth-pwd") as HTMLInputElement).value;
  const remember = (document.getElementById("auth-remember") as HTMLInputElement | null)?.checked ?? true;
  const btn = document.getElementById("auth-go") as HTMLButtonElement;
  err.style.display = "none";
  try {
    btn.disabled = true;
    let user: UserPublic;
    if (mode === "login") {
      const identifier = (document.getElementById("auth-id") as HTMLInputElement).value.trim();
      const r = await authApi.login({ identifier, password: pwd, remember });
      user = r.user;
      localStorage.setItem("yc_token", r.token);
    } else {
      const email = (document.getElementById("auth-id") as HTMLInputElement).value.trim();
      const username = (document.getElementById("auth-user") as HTMLInputElement).value.trim();
      const r = await authApi.register({ email, password: pwd, username: username || undefined });
      user = r.user;
      localStorage.setItem("yc_token", r.token);
    }
    setUser(user);
    closeModals();
    (document.getElementById("auth-pwd") as HTMLInputElement).value = "";
    toast(mode === "login" ? `欢迎回来，${user.username || user.email}` : "注册成功，已自动登录");
    // 登录后重读大模型状态：顶栏灯 / AI 入口按该账户的配置点亮
    document.dispatchEvent(new CustomEvent("yc:llm-changed"));
    // 云设置拉取合并：服务器缺失键回传本地，自选/卡片/外观跟账户走
    void pullOnLogin().then(() => emit());
  } catch (e) {
    err.textContent = (e as Error).message || "请求失败";
    err.style.display = "";
  } finally {
    btn.disabled = false;
  }
}

export async function redeem(): Promise<void> {
  const input = document.getElementById("redeem-input") as HTMLInputElement;
  const code = input.value.trim().toUpperCase();
  if (!/^YC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { toast("兑换码格式：YC-XXXX-XXXX"); return; }
  const btn = document.getElementById("redeem-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const r = await licenseApi.redeem(code);
    input.value = "";
    // 兑换成功：刷新用户 tier，弹出成功页
    const me = await authApi.me();
    setUser(me);
    closeModals();
    document.getElementById("pay-until")!.textContent = r.pro_expires_at.slice(0, 10);
    openModal("modal-pay-ok");
    emit(); // 触发右列 / K线 VIP 层重渲染
    toast(`兑换成功 · ${r.plan} · ${r.days} 天`);
  } catch (e) {
    toast((e as Error).message || "兑换失败");
  } finally {
    btn.disabled = false;
  }
}

export function logout(): void {
  flushSync();                    // 冲刷未落库的设置变更（尽力而为）
  localStorage.removeItem("yc_token");
  setUser(null);
  emit();
  document.dispatchEvent(new CustomEvent("yc:llm-changed"));
  toast("已退出登录");
}

export function initAuth(): void {
  document.getElementById("auth-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b) { mode = (b.dataset.t as "login" | "register"); drawAuth(); }
  });
  document.getElementById("auth-go")!.addEventListener("click", submitAuth);
  document.getElementById("auth-pwd")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });
  document.getElementById("userchip")!.addEventListener("click", () => {
    if (getState().user) {
      // 已登录：进入设置-账户页（监听方在 document 上，必须用 document 派发：
      // window 上的事件不会向下传到 document，之前点已登录的 chip 完全没反应）
      document.dispatchEvent(new CustomEvent("yc:goto-settings", { detail: "account" }));
    } else openAuth("login");
  });
  document.getElementById("vipbadge")!.addEventListener("click", () => {
    refreshVipUI();
    openModal("modal-vip");
  });
  document.getElementById("redeem-btn")!.addEventListener("click", redeem);
  document.getElementById("redeem-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") redeem();
  });
  // 会话过期（任意 /api 401）→ 清态弹登录
  window.addEventListener("yc:auth-expired", () => {
    setUser(null);
    emit();
    toast("登录已过期，请重新登录");
    openAuth("login");
  });
  drawUserchip();
  refreshVipUI();
}

export function userLabel(u: UserPublic | null): string {
  return esc(u ? (u.username || u.email) : "未登录");
}
