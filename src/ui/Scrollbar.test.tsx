import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Scrollbar } from "./Scrollbar";

function Harness({ onScroll, contentHeight }: { onScroll: (top: number) => void; contentHeight: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ position: "relative" }}>
      <Scrollbar target={ref} contentHeight={contentHeight} />
      <div ref={ref} data-testid="scroller" onScroll={(e) => onScroll(e.currentTarget.scrollTop)} />
    </div>
  );
}

describe("Scrollbar", () => {
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
    thumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: 10 }));
    track.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 46 }));

    // A 32px thumb travels 68px of the track for 900px of content: 36px ≈ 476px.
    expect(top).toBeCloseTo((36 / 68) * 900);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenLastCalledWith(top);
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
});
