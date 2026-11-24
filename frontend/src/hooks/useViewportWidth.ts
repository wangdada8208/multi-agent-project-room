import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const viewportWidth = () => window.innerWidth;

export function useViewportWidth() {
  return useSyncExternalStore(subscribe, viewportWidth, () => 1024);
}
