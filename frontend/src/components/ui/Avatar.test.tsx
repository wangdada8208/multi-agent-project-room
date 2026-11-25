import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "./Avatar";

it.each([
  ["me", "我", false], ["human", "人类", false], ["cloud", "云端 Agent", true], ["local", "电脑端 Agent", true],
] as const)("encodes the %s actor with its label, variant and avatar content", (actor, label, branded) => {
  const rendered = renderToStaticMarkup(<Avatar actor={actor} name="Muse" presence="paused" />);
  expect(rendered).toContain(`aria-label="Muse · ${label} · 已暂停"`);
  expect(rendered).toContain(`ui-avatar--${actor}`);
  expect(rendered).toContain("ui-avatar__presence--paused");
  if (branded) {
    expect(rendered).toContain("ui-avatar__brand");
    expect(rendered).toContain("<svg");
  } else {
    expect(rendered).not.toContain("ui-avatar__brand");
    expect(rendered).toContain(">M</span>");
  }
});
