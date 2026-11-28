// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingView, type OnboardingProgress } from "./OnboardingPage";

function progress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    roomCount: 0,
    hasAgentSeat: false,
    hasInvitedMember: false,
    isLoading: false,
    allComplete: false,
    firstRoomId: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderOnboarding(options: {
  progress?: OnboardingProgress;
  onStartTemplate?: () => void;
  onDismiss?: () => void;
} = {}) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <OnboardingView
          embedded
          progress={options.progress ?? progress()}
          onStartTemplate={options.onStartTemplate}
          onDismiss={options.onDismiss}
        />
      </MemoryRouter>,
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`找不到按钮「${text}」`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Q06 empty onboarding", () => {
  it("keeps one primary template action and one secondary invite action without the prompt picker", async () => {
    const onStartTemplate = vi.fn();
    await renderOnboarding({ onStartTemplate });

    const primary = [...container.querySelectorAll<HTMLButtonElement>(".wb-onb .ui-button--primary")];
    const secondary = [...container.querySelectorAll<HTMLButtonElement>(".wb-onb .ui-button--secondary")];
    expect(primary.map((button) => button.textContent?.trim())).toEqual(["用模板开第一个房间"]);
    expect(secondary.map((button) => button.textContent?.trim())).toEqual(["粘贴邀请链接加入"]);
    expect(container.querySelector(".agent-prompt-setup")).toBeNull();
    expect(container.querySelector(".wb-onb-choice")).toBeNull();
    expect(container.textContent).not.toContain("先接入一个云端 Agent");

    await act(async () => buttonByText("用模板开第一个房间").click());
    expect(onStartTemplate).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("mapr-onboarded")).toBeNull();
  });

  it("does not write the legacy graduation flag when the invite path is used", async () => {
    await renderOnboarding();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="粘贴邀请链接"]');
    if (!input) throw new Error("missing invite input");
    await act(async () => {
      setInputValue(input, "https://hub.example/rooms/room-1?invite=abc");
    });
    await act(async () => buttonByText("粘贴邀请链接加入").click());

    expect(container.textContent).not.toContain("请粘贴有效的房间邀请链接");
    expect(localStorage.getItem("mapr-onboarded")).toBeNull();
  });
});

describe("Q07 real onboarding progress", () => {
  it("marks only the room step complete when a real room exists", async () => {
    await renderOnboarding({
      progress: progress({ roomCount: 1, firstRoomId: "room-1" }),
    });

    expect(container.querySelector('[aria-label="第 1 步：开第一个房间，已完成"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="第 2 步：接入一个 Agent，未完成"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="第 3 步：邀请成员，未完成"]')).not.toBeNull();
    expect(container.textContent).toContain("去接入 Agent");
  });

  it("moves to the invite step only after a real agent seat exists", async () => {
    await renderOnboarding({
      progress: progress({ roomCount: 1, hasAgentSeat: true, firstRoomId: "room-1" }),
    });

    expect(container.querySelector('[aria-label="第 2 步：接入一个 Agent，已完成"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="第 3 步：邀请成员，未完成"]')).not.toBeNull();
    expect(container.querySelector('a[href="/rooms/room-1?panel=invite"]')?.textContent).toContain("去邀请成员");
  });

  it("uses an explicit dismiss control instead of click-based graduation", async () => {
    const onDismiss = vi.fn();
    await renderOnboarding({ onDismiss });
    await act(async () => buttonByText("我知道了，收起引导").click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("mapr-onboarded")).toBeNull();
  });
});
