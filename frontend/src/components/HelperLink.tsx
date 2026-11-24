import type { ComponentPropsWithoutRef } from "react";
import { ownerConsolePageUrl } from "../lib/ownerConsole";
import { HELPER_ORIGIN, helperHandoffUrl, isMobileBrowser, type HelperHandoffAction } from "../lib/localHelper";

type Action = HelperHandoffAction | "console" | { approvalPort: number };

function urlFor(action: Action) {
  if (action === "console") return `${HELPER_ORIGIN}/`;
  if ("approvalPort" in action) return ownerConsolePageUrl(action.approvalPort);
  return helperHandoffUrl(action);
}

export function openHelperLink(action: Action): Window | null {
  if (isMobileBrowser()) return null;
  return window.open(urlFor(action), "_blank", "noopener,noreferrer");
}

export function HelperLink({ action, ...props }: Omit<ComponentPropsWithoutRef<"a">, "href"> & { action: Action }) {
  if (isMobileBrowser()) return null;
  return <a target="_blank" rel="noopener noreferrer" {...props} href={urlFor(action)} />;
}
