import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { attemptSend, ChatInput, isSubmitKeyDown } from "./ChatInput";

describe("isSubmitKeyDown", () => {
  it("sends on plain Enter", () => {
    expect(isSubmitKeyDown({ key: "Enter" })).toBe(true);
  });

  it("does not send on Shift+Enter", () => {
    expect(isSubmitKeyDown({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does not send while an IME composition is active", () => {
    expect(
      isSubmitKeyDown({ key: "Enter", nativeEvent: { isComposing: true } }),
    ).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isSubmitKeyDown({ key: "a" })).toBe(false);
    expect(isSubmitKeyDown({ key: "Tab" })).toBe(false);
  });
});

describe("attemptSend", () => {
  it("skips empty text without calling onSend", async () => {
    const onSend = vi.fn();
    expect(await attemptSend({ text: "   ", onSend })).toBe("skipped");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("trims and sends, reporting sent on truthy result", async () => {
    const onSend = vi.fn(async () => true);
    expect(await attemptSend({ text: "  你好  ", onSend })).toBe("sent");
    expect(onSend).toHaveBeenCalledWith("你好");
  });

  it("reports failed when the send resolves false (retry keeps draft)", async () => {
    const onSend = vi.fn(async () => false);
    expect(await attemptSend({ text: "稍后再发", onSend })).toBe("failed");
  });

  it("reports failed when the send throws", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await attemptSend({ text: "x", onSend })).toBe("failed");
  });
});

describe("ChatInput markup", () => {
  it("renders a multiline textarea instead of a single-line input", () => {
    const html = renderToStaticMarkup(
      <ChatInput disabled={false} onlineAgents={[]} onSend={() => true} />,
    );
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("chat-input__send-error");
    expect(html).not.toContain("chat-input__reply-banner");
  });

  it("shows the replying banner with cancel affordance when a reply target is set", () => {
    const html = renderToStaticMarkup(
      <ChatInput
        disabled={false}
        onlineAgents={[]}
        onSend={() => true}
        replyTarget={{ id: "m1", senderName: "Alice", excerpt: "原消息摘录" }}
        onCancelReply={() => {}}
      />,
    );
    expect(html).toContain("chat-input__reply-banner");
    expect(html).toContain("回复 Alice：原消息摘录");
    expect(html).toContain("aria-label=\"取消回复\"");
  });

  it("renders mention chips for online agents", () => {
    const html = renderToStaticMarkup(
      <ChatInput disabled={false} onlineAgents={["agent-a", "agent-b"]} onSend={() => true} />,
    );
    expect(html).toContain("agent-a");
    expect(html).toContain("全体");
  });
});
