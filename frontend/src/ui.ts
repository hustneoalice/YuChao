/* Toast / 弹窗公共 */
let toastTimer: number | undefined;
export function toast(msg: string): void {
  const t = document.getElementById("toast")!;
  document.getElementById("toast-t")!.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("on"), 2200);
}
export function openModal(id: string): void {
  document.getElementById("scrim")!.classList.add("on");
  document.getElementById(id)!.classList.add("on");
}
export function closeModals(): void {
  document.querySelectorAll(".modal").forEach((m) => m.classList.remove("on"));
  document.getElementById("scrim")!.classList.remove("on");
}
/* 多选修饰键：Ctrl / ⌘ / Shift，或按住 Tab（与浏览器原生多选习惯一致） */
let tabHeld = false;
window.addEventListener("keydown", (e) => { if (e.key === "Tab") tabHeld = true; });
window.addEventListener("keyup", (e) => { if (e.key === "Tab") tabHeld = false; });
window.addEventListener("blur", () => { tabHeld = false; });
export function multiPick(e: MouseEvent | KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey || tabHeld;
}

export function bindModalChrome(): void {
  document.getElementById("scrim")!.onclick = closeModals;
  document.querySelectorAll<HTMLElement>(".mclose,[data-close]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); closeModals(); }));
}
