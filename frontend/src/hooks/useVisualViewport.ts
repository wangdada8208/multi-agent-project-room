import { useEffect } from "react";

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--kb");
    const update = () => {
      const overlap = viewport.scale === 1
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;
      root.style.setProperty("--kb", `${overlap}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      if (previous) root.style.setProperty("--kb", previous);
      else root.style.removeProperty("--kb");
    };
  }, []);
}
