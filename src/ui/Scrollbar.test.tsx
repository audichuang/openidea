import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scrollbar } from "./Scrollbar";

function Harness({ onScroll, contentHeight }: { onScroll: (top: number) => void; contentHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ position: "relative" }}>
      <Scrollbar target={ref} contentHeight={contentHeight} />
      <div ref={ref} data-testid="scroller" onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
        <div data-testid="content" />
      </div>
    </div>
  );
}

/** A ResizeObserver the test fires by hand, for the elements it was told to observe. */
function fakeResizeObserver() {
  const observers = new Set<{ callback: () => void; targets: Set<Element> }>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: { callback: () => void; targets: Set<Element> };
      constructor(callback: () => void) {
        this.entry = { callback, targets: new Set() };
        observers.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    },
  );
  return (target: Element) => {
    act(() => {
      for (const o of observers) if (o.targets.has(target)) o.callback();
    });
  };
}

describe("Scrollbar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("notifies scroll listeners synchronously while the thumb is dragged", () => {
    const onScroll = vi.fn();
    const { getByTestId, container, rerender } = render(<Harness onScroll={onScroll} contentHeight={0} />);
    const scroller = getByTestId("scroller");
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 1000 },
      scrollTop: { get: () => top, set: (v: number) => (top = v) },
    });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      top = Math.max(0, Math.min(900, options.top ?? top));
    }) as typeof scroller.scrollTo;
    rerender(<Harness onScroll={onScroll} contentHeight={1000} />);

    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    track.setPointerCapture = () => {};
    track.hasPointerCapture = () => false;
    thumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientY: 10 }));
    expect(document.querySelector("[data-scrollbar-drag-surface]")).not.toBeNull();
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }));
    expect(document.querySelector("[data-scrollbar-drag-surface]")).not.toBeNull();
    track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 46 }));

    // A 32px thumb travels 68px of the track for 900px of content: 36px ≈ 476px.
    expect(top).toBeCloseTo((36 / 68) * 900);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenLastCalledWith(top);
    track.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));
    expect(document.querySelector("[data-scrollbar-drag-surface]")).toBeNull();

    thumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientY: 10 }));
    expect(thumb.dataset.dragging).toBe("");
    window.dispatchEvent(new Event("blur"));
    expect(thumb.dataset.dragging).toBeUndefined();
    expect(document.querySelector("[data-scrollbar-drag-surface]")).toBeNull();
  });

  it.each([
    [318, 318, false],
    // WebKit after a splitter drag: one commit row, scrollHeight a pixel over the viewport.
    [318, 319, false],
    [318, 320, true],
    [100, 1000, true],
  ])("shows the track for clientHeight %i and scrollHeight %i: %s", (clientHeight, scrollHeight, shown) => {
    const { getByTestId, container, rerender } = render(<Harness onScroll={() => {}} contentHeight={0} />);
    const scroller = getByTestId("scroller");
    Object.defineProperties(scroller, {
      clientHeight: { value: clientHeight },
      scrollHeight: { value: scrollHeight },
      scrollTop: { value: 0 },
    });
    // The fork's scrollbar measures again when the content's height changes, not on every scroll.
    rerender(<Harness onScroll={() => {}} contentHeight={scrollHeight} />);
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    expect(track.style.display !== "none").toBe(shown);
  });

  it("moves the thumb on scroll without remeasuring or moving the track", () => {
    const onScroll = vi.fn();
    const { getByTestId, container, rerender } = render(<Harness onScroll={onScroll} contentHeight={0} />);
    const scroller = getByTestId("scroller");
    const height = vi.fn(() => 100);
    const content = vi.fn(() => 1000);
    const offset = vi.fn(() => 26);
    Object.defineProperties(scroller, {
      clientHeight: { get: height },
      scrollHeight: { get: content },
      offsetTop: { get: offset },
    });
    rerender(<Harness onScroll={onScroll} contentHeight={1000} />);
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.style.top).toBe("26px");
    expect(thumb.style.transform).toBe("translateY(0px)");
    height.mockClear();
    content.mockClear();
    offset.mockClear();
    scroller.scrollTop = 450;
    fireEvent.scroll(scroller);
    expect(thumb.style.transform).toBe("translateY(34px)");
    expect(height).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(offset).not.toHaveBeenCalled();
  });

  it("measures again when the scroller or its content resizes without a scroll", async () => {
    const resize = fakeResizeObserver();
    const { getByTestId, container } = render(<Harness onScroll={() => {}} contentHeight={100} />);
    const scroller = getByTestId("scroller");
    const size = { client: 100, content: 100 };
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => size.client },
      scrollHeight: { configurable: true, get: () => size.content },
      scrollTop: { configurable: true, value: 0 },
    });
    resize(scroller);
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.style.display).toBe("none");

    // Content that grows with the same `contentHeight` and the same scroller size.
    size.content = 200;
    resize(getByTestId("content"));
    expect(track.style.display).toBe("");
    expect(thumb.style.height).toBe("50px");

    // Content replaced (a Markdown preview re-rendered), then growing.
    const replaced = document.createElement("div");
    act(() => {
      scroller.replaceChildren(replaced);
    });
    await Promise.resolve();
    size.content = 400;
    resize(replaced);
    expect(thumb.style.height).toBe("32px");
  });
});
