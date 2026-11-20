/** One row of the graph column: the edges entering and leaving the row and the commit's node. */
import { Fragment, memo } from "react";
import { useTx } from "@/platform/i18n";
import { gitGraphBridge, type GraphLaneRow, type GraphLaneSegment } from "@/workbench/gitGraphBridge";
import styles from "./GitGraph.module.css";

export const LANE = 14;
const ROW_HEIGHT = 24;

const x = (lane: number) => lane * LANE + LANE / 2 + 2;

/**
 * From (`fx`, `fy`) to (`tx`, `ty`): straight when on one lane or `diagonal` (half of a lane change
 * drawn as one line across the row boundary), else an S-curve.
 */
function seg(fx: number, fy: number, tx: number, ty: number, diagonal: boolean) {
  if (fx === tx || diagonal) return `M${fx} ${fy}L${tx} ${ty}`;
  const mid = (fy + ty) / 2;
  return `M${fx} ${fy}C${fx} ${mid} ${tx} ${mid} ${tx} ${ty}`;
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues (as in the Git Log). */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}

/** The path of an edge entering (`up`) or leaving the node; null when it lies right of the column. */
export function segmentPath(s: GraphLaneSegment, up: boolean, width: number): string | null {
  const fromX = x(s.fromX ?? s.from);
  const toX = x(s.toX ?? s.to);
  if (Math.min(fromX, toX) > width) return null;
  const cy = ROW_HEIGHT / 2;
  const path = seg(fromX, up ? 0 : cy, toX, up ? cy : ROW_HEIGHT, s.fromX !== undefined || s.toX !== undefined);
  if (!s.arrow) return path;
  return path + (up ? arrowHead(fromX, 0, -1) : arrowHead(toX, ROW_HEIGHT, 1));
}

/**
 * Every edge and node carries its colour (branch line) in `data-lane-color`, so the list dims the
 * lines other than the hovered one with one style rule instead of re-rendering its rows.
 */
export const GraphCell = memo(function GraphCell({
  row,
  head,
  hollow,
  width,
  loaded,
  onNavigate,
}: {
  row: GraphLaneRow;
  head?: boolean;
  /** A pseudo row (uncommitted changes, stash): an outlined node. */
  hollow?: boolean;
  width: number;
  /** Rows loaded, when an arrow of this row points at or past it; unset when every target is loaded. */
  loaded?: number;
  /** Goes to the row at an arrow's other end. */
  onNavigate?: (targetRow: number) => void;
}) {
  const tx = useTx();
  const color = (i: number) => gitGraphBridge()?.laneColor(i) ?? "currentColor";
  const cy = ROW_HEIGHT / 2;
  const edge = (s: GraphLaneSegment, i: number, up: boolean) => {
    const d = segmentPath(s, up, width);
    if (d === null) return null;
    const key = `${up ? "u" : "d"}${i}`;
    const target = s.arrow ? s.targetRow : undefined;
    const navigable = target !== undefined && target >= 0 && (loaded === undefined || target < loaded) && !!onNavigate;
    const line = (
      <path
        key={key}
        data-lane-color={s.color}
        d={d}
        stroke={color(s.color)}
        strokeDasharray={s.dashed ? "2 2" : undefined}
        // Clicks on the drawn arrow reach the hit path under it, not the row.
        pointerEvents={navigable ? "none" : undefined}
      />
    );
    if (!navigable) return line;
    // As the Git Log's arrows: a wide transparent stroke to click (or Enter) that goes to the other end.
    const label = tx("Go to connected commit");
    return (
      <Fragment key={key}>
        <path
          d={d}
          stroke="transparent"
          // Inline: `.graph path` sets the stroke width for every edge.
          style={{ strokeWidth: 10, pointerEvents: "stroke" }}
          role="button"
          tabIndex={0}
          aria-label={label}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(target!);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onNavigate(target!);
            }
          }}
        >
          <title>{label}</title>
        </path>
        {line}
      </Fragment>
    );
  };
  return (
    <svg className={styles.graph} width={width} height={ROW_HEIGHT} aria-label={tx("Commit graph")}>
      {row.up.map((s, i) => edge(s, i, true))}
      {row.down.map((s, i) => edge(s, i, false))}
      {hollow ? (
        <circle
          data-lane-color={row.color}
          cx={x(row.lane)}
          cy={cy}
          r={4}
          fill="var(--graph-row-bg, var(--bg-editor))"
          stroke={color(row.color)}
          strokeWidth={1.5}
          strokeDasharray="2 1.5"
        />
      ) : head ? (
        <>
          <circle
            data-lane-color={row.color}
            cx={x(row.lane)}
            cy={cy}
            r={5}
            fill="var(--graph-row-bg, var(--bg-editor))"
            stroke={color(row.color)}
            strokeWidth={2}
          />
          <circle data-lane-color={row.color} cx={x(row.lane)} cy={cy} r={2} fill={color(row.color)} />
        </>
      ) : (
        <circle data-lane-color={row.color} cx={x(row.lane)} cy={cy} r={4} fill={color(row.color)} />
      )}
    </svg>
  );
});
