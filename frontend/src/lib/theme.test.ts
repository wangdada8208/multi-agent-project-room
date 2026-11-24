// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { getThemePreference, initializeTheme, setThemePreference } from "./theme";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it("follows the system setting until a preference overrides it and restores it on startup", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  const setSystemDark = (matches: boolean) => {
    media.matches = matches;
    media.dispatchEvent(Object.assign(new Event("change"), { matches }));
  };

  localStorage.setItem("mapr-theme", "invalid");
  expect(getThemePreference()).toBe("system");
  const stop = initializeTheme();
  try {
    expect(document.documentElement.dataset.theme).toBe("dark");
    setSystemDark(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    setThemePreference("dark");
    expect(localStorage.getItem("mapr-theme")).toBe("dark");
    setSystemDark(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    setThemePreference("system");
    expect(localStorage.getItem("mapr-theme")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  } finally {
    stop();
  }

  localStorage.setItem("mapr-theme", "light");
  setSystemDark(true);
  const stopAfterReload = initializeTheme();
  try {
    expect(document.documentElement.dataset.theme).toBe("light");
  } finally {
    stopAfterReload();
  }
});
