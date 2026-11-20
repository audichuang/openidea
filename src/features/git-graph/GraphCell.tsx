/** One row of the graph column: the edges entering and leaving the row and the commit's node. */
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
 * `highlight`: the colour (branch line) under the pointer; its edges stay bright and every
 * other line dims, so a hover shows where a branch runs.
 */
export function GraphCell({
  row,
  head,
  hollow,
  width,
  highlight,
}: {
  row: GraphLaneRow;
  head?: boolean;
  /** A pseudo row (uncommitted changes, stash): an outlined node. */
  hollow?: boolean;
  width: number;
  highlight: number | null;
}) {
  const color = (i: number) => gitGraphBridge()?.laneColor(i) ?? "currentColor";
  const cy = ROW_HEIGHT / 2;
  const dim = (c: number) => (highlight !== null && highlight !== c ? styles.dim : undefined);
  const edge = (s: GraphLaneSegment, i: number, up: boolean) => {
    const d = segmentPath(s, up, width);
    return d === null ? null : (
      <path
        key={`${up ? "u" : "d"}${i}`}
        className={dim(s.color)}
        d={d}
        stroke={color(s.color)}
        strokeDasharray={s.dashed ? "2 2" : undefined}
      />
    );
  };
  return (
    <svg className={styles.graph} width={width} height={ROW_HEIGHT} aria-hidden>
      {row.up.map((s, i) => edge(s, i, true))}
      {row.down.map((s, i) => edge(s, i, false))}
      {hollow ? (
        <circle
          className={dim(row.color)}
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
            className={dim(row.color)}
            cx={x(row.lane)}
            cy={cy}
            r={5}
            fill="var(--graph-row-bg, var(--bg-editor))"
            stroke={color(row.color)}
            strokeWidth={2}
          />
          <circle className={dim(row.color)} cx={x(row.lane)} cy={cy} r={2} fill={color(row.color)} />
        </>
      ) : (
        <circle className={dim(row.color)} cx={x(row.lane)} cy={cy} r={4} fill={color(row.color)} />
      )}
    </svg>
  );
}
