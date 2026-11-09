import clsx from "clsx";
import { useLayoutEffect, useRef, useState } from "react";
import { fitName, fitPath, type Measure } from "./fitText";
import styles from "./clip.module.css";

let canvas: CanvasRenderingContext2D | null | undefined;

/** A measure for the text style of `el`, or null where there is no canvas (tests). */
function measurerFor(el: HTMLElement): Measure | null {
  if (canvas === undefined) {
    try {
      canvas = document.createElement("canvas").getContext("2d");
    } catch {
      canvas = null;
    }
  }
  const ctx = canvas;
  if (!ctx) return null;
  const s = getComputedStyle(el);
  ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  const spacing = Number.parseFloat(s.letterSpacing) || 0;
  return (text) => ctx.measureText(text).width + spacing * text.length;
}

/**
 * Plain text shortened to the width its box gets from the layout. The full text sits in the box's `::after`
 * (hidden, zero height) so the box asks for its full width and the surrounding flex rules decide how much it
 * gets; what is drawn is the string `fit` picked for that width, cut on whole characters.
 */
function FitText({
  text,
  fit,
  className,
  title,
}: {
  text: string;
  fit: (text: string, avail: number, measure: Measure) => string;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const run = () => {
      const width = el.clientWidth;
      const measure = width > 0 ? measurerFor(el) : null;
      // clientWidth is rounded. A box that got its full text's width shows it whole (it was sized by that very
      // text, so it can be a fraction narrower than the canvas measure); a cut text keeps a pixel of slack so its
      // last character is not clipped by the box.
      setShown(!measure || measure(text) <= width + 0.5 ? text : fit(text, width - 1, measure));
    };
    run();
    let alive = true;
    void document.fonts?.ready.then(() => alive && run());
    if (typeof ResizeObserver === "undefined") return () => void (alive = false);
    const observer = new ResizeObserver(run);
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [text, fit]);
  return (
    <span ref={ref} className={clsx(styles.fit, className)} data-full={text} title={title}>
      {shown}
    </span>
  );
}

const fitWholeName = (name: string, avail: number, measure: Measure) => fitName("", name, avail, measure);

/** A file name that elides in the middle: names that share a long prefix stay distinguishable by their ends. */
export function NameText({ name }: { name: string }) {
  return <FitText text={name} fit={fitWholeName} />;
}

/**
 * A path whose folders elide first (down to the first segment and an ellipsis), then the middle of the file
 * name; the name's end always shows.
 */
export function PathText({ path, title, className }: { path: string; title?: string; className?: string }) {
  return <FitText text={path} fit={fitPath} className={className} title={title ?? path} />;
}
