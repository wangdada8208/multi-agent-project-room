import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownLite } from "./MarkdownLite";

function render(text: string, candidates: Parameters<typeof MarkdownLite>[0]["candidates"] = []) {
  return renderToStaticMarkup(<MarkdownLite text={text} candidates={candidates} />);
}

describe("MarkdownLite safe rich inline rendering", () => {
  it("renders bold, italic, automatic links, and safe Markdown links as React elements", () => {
    const html = render("请看 **加粗** 和 *斜体*，访问 https://example.com 或 [文档](https://example.com/docs)。");

    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>');
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">文档</a>');
  });

  it("keeps inline code, code blocks, and mentions intact", () => {
    const html = render("请 @助手 看 `**code**`。\n```ts\nconst x = 1;\n```", [
      { id: "seat-1", name: "助手", actor: "local", disabled: false },
    ]);

    expect(html).toContain('<mark data-actor="local">@助手</mark>');
    expect(html).toContain("<code>**code**</code>");
    expect(html).toContain('<div class="wb-code">');
    expect(html).toContain("const x = 1;");
  });

  it("does not italicize spaced arithmetic or underscore variable names", () => {
    const html = render("公式 2 * 3 * 4 与 snake_case_value 保持原样");

    expect(html).not.toContain("<em>");
    expect(html).toContain("2 * 3 * 4");
    expect(html).toContain("snake_case_value");
  });

  it("rejects javascript and data links and never emits raw HTML", () => {
    const html = render("[点我](javascript:alert(1)) [数据](data:text/html;base64,PGltZz4=) <img src=x onerror=alert(1)>");

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("dangerouslySetInnerHTML");
    expect(html).toContain("[点我](javascript:alert(1))");
  });
});
