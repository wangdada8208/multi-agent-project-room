export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "mapr-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage can be unavailable in private or embedded browsing.
  }
  return "system";
}

let preference: ThemePreference | undefined;

function applyTheme(value: ThemePreference, dark = window.matchMedia?.(DARK_QUERY).matches ?? false) {
  document.documentElement.dataset.theme = value === "system" ? (dark ? "dark" : "light") : value;
}

export function setThemePreference(value: ThemePreference) {
  preference = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Apply the preference for the current page even without storage.
  }
  applyTheme(value);
}

export function initializeTheme() {
  preference = getThemePreference();
  const media = window.matchMedia?.(DARK_QUERY);
  applyTheme(preference, media?.matches);
  const update = (event: MediaQueryListEvent) => {
    if (preference === "system") applyTheme(preference, event.matches);
  };
  media?.addEventListener("change", update);
  return () => media?.removeEventListener("change", update);
}
