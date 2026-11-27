import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "./Avatar";

it.each([
  ["me", "我"], ["human", "人类"], ["cloud", "云端 Agent"], ["local", "电脑端 Agent"],
] as const)("encodes the %s actor with its label, variant and presence", (actor, label) => {
  const rendered = renderToStaticMarkup(<Avatar actor={actor} name="Muse" presence="paused" />);
  expect(rendered).toContain(`aria-label="Muse · ${label} · 已暂停"`);
  expect(rendered).toContain(`ui-avatar--${actor}`);
  expect(rendered).toContain("ui-avatar__presence--paused");
});

it("uses a named vector brand mark for known agents instead of letter tiles", () => {
  const rendered = renderToStaticMarkup(<Avatar actor="cloud" name="Grok Bot" />);
  expect(rendered).toContain("<svg");
  expect(rendered).not.toContain("ui-avatar__mark");
  expect(rendered).not.toContain(">G</span>");
});
