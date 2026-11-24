import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "./Avatar";

it.each([
  ["me", "我", ""], ["human", "人类", ""], ["cloud", "云端 Agent", "☁"], ["local", "电脑端 Agent", "&gt;_"],
] as const)("encodes the %s actor with its label, variant and correct mark", (actor, label, mark) => {
  const rendered = renderToStaticMarkup(<Avatar actor={actor} name="Muse" presence="paused" />);
  expect(rendered).toContain(`aria-label="Muse · ${label} · 已暂停"`);
  expect(rendered).toContain(`ui-avatar--${actor}`);
  expect(rendered).toContain("ui-avatar__presence--paused");
  if (mark) expect(rendered).toContain(`aria-hidden="true">${mark}</span>`);
  else expect(rendered).not.toContain("ui-avatar__mark");
});
