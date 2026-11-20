const KEY = "sorachat-liquid-glass-icon";
export function getLiquidIcon(): boolean {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}
export function setLiquidIcon(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
  applyAppIcon();
  window.dispatchEvent(new Event("sorachat-icon-pref"));
}
export function applyAppIcon() {
  const liquid = getLiquidIcon();
  const icon = liquid ? "/icons/sorachat-liquid-512.png" : "/icons/sorachat-normal-512.png";
  const apple = liquid ? "/icons/icon-liquid-180.png" : "/icons/icon-180.png";
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", icon);
  document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.setAttribute("href", apple);
  document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute("href", liquid ? "/manifest-liquid.webmanifest" : "/manifest.webmanifest");
}
