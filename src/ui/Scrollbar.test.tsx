import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scrollbar } from "./Scrollbar";

function Harness({ onScroll, contentHeight = 1000 }: { onScroll: (top: number) => void; contentHeight?: number }) {
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

/** Counts reads of the scroller's layout properties, which force a layout when the page is dirty. */
function measuredScroller(scroller: HTMLElement, size: { client: number; content: number }) {
  let top = 0;
  const reads = vi.fn();
  const read = (value: () => number) => ({
    configurable: true,
    get: () => {
      reads();
      return value();
    },
  });
  Object.defineProperties(scroller, {
    clientHeight: read(() => size.client),
    scrollHeight: read(() => size.content),
    offsetTop: read(() => 26),
    scrollTop: { configurable: true, get: () => top, set: (v: number) => (top = v) },
  });
  return reads;
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
    const resize = fakeResizeObserver();
    const { getByTestId, container } = render(<Harness onScroll={() => {}} />);
    const scroller = getByTestId("scroller");
    Object.defineProperties(scroller, {
      clientHeight: { value: clientHeight },
      scrollHeight: { value: scrollHeight },
      scrollTop: { value: 0 },
    });
    resize(scroller);
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    expect(track.style.display !== "none").toBe(shown);
  });

  it("moves the thumb on scroll without measuring the scroller", () => {
    const { getByTestId, container, rerender } = render(<Harness onScroll={() => {}} contentHeight={0} />);
    const scroller = getByTestId("scroller");
    const reads = measuredScroller(scroller, { client: 100, content: 1000 });
    rerender(<Harness onScroll={() => {}} contentHeight={1000} />);
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.style.top).toBe("26px");
    expect(thumb.style.transform).toBe("translateY(0px)");

    reads.mockClear();
    for (const top of [150, 450, 900]) {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    }
    // A 32px thumb travels 68px of the track for 900px of content.
    expect(thumb.style.transform).toBe("translateY(68px)");
    expect(reads).not.toHaveBeenCalled();
  });

  it("resizes the thumb when the content height changes without a scroll", () => {
    const { getByTestId, container, rerender } = render(<Harness onScroll={() => {}} contentHeight={0} />);
    const scroller = getByTestId("scroller");
    const size = { client: 100, content: 200 };
    measuredScroller(scroller, size);
    rerender(<Harness onScroll={() => {}} contentHeight={200} />);
    const thumb = container.querySelector<HTMLElement>("[aria-hidden]")!.firstElementChild as HTMLElement;
    expect(thumb.style.height).toBe("50px");

    size.content = 1000;
    rerender(<Harness onScroll={() => {}} contentHeight={1000} />);
    expect(thumb.style.height).toBe("32px");
  });

  it("measures again when the scroller or its content resizes without a scroll", () => {
    const resize = fakeResizeObserver();
    const { getByTestId, container } = render(<Harness onScroll={() => {}} contentHeight={100} />);
    const scroller = getByTestId("scroller");
    const size = { client: 100, content: 100 };
    measuredScroller(scroller, size);
    resize(scroller);
    const track = container.querySelector<HTMLElement>("[aria-hidden]")!;
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.style.display).toBe("none");

    // Content that grows after it is drawn (an image loading) with the same `contentHeight`.
    size.content = 200;
    resize(getByTestId("content"));
    expect(track.style.display).toBe("");
    expect(thumb.style.height).toBe("50px");

    // The scroller itself shrinking (a splitter drag).
    size.client = 50;
    resize(scroller);
    expect(track.style.height).toBe("50px");
    expect(thumb.style.height).toBe("32px");
  });
});
