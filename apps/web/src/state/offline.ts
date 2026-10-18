/**
 * Offline use of the web app (browser and self-hosted server; the desktop app is offline already).
 * Registers the service worker in public/sw.js, which keeps this build's files, and offers a reload
 * when a newer build has been installed alongside.
 */
import { tauri } from "./platform";
import { toast } from "./store";

export function startOffline() {
  // Development builds change on every save; a kept copy would only get in the way.
  if (!import.meta.env.PROD || tauri() || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  let reloading = false;
  // The new build took over because the person asked for it: load it.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) window.location.reload();
  });
  const offer = (worker: ServiceWorker) =>
    toast("info", "A new version of Whittle is ready.", {
      label: "Reload",
      run: () => {
        reloading = true;
        worker.postMessage("update");
      },
    });
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          // The first install needs no reload: this page already runs that build.
          if (next.state === "installed" && navigator.serviceWorker.controller) offer(next);
        });
      });
      // Long sessions still hear about new builds.
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    })
    .catch(() => undefined);
}
