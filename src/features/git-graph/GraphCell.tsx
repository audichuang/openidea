/** One row of the graph column: the edges entering and leaving the row and the commit's node. */
import { gitGraphBridge, type GraphLaneRow } from "@/workbench/gitGraphBridge";
import styles from "./GitGraph.module.css";

export const LANE = 14;
const ROW_HEIGHT = 24;

const x = (lane: number) => lane * LANE + LANE / 2 + 2;

/** From (`fx`, `fy`) to (`tx`, `ty`): straight when on one lane, else an S-curve. */
function seg(fx: number, fy: number, tx: number, ty: number) {
  if (fx === tx) return `M${fx} ${fy}L${tx} ${ty}`;
  const mid = (fy + ty) / 2;
  return `M${fx} ${fy}C${fx} ${mid} ${tx} ${mid} ${tx} ${ty}`;
}

/**
 * `highlight`: the colour (branch line) under the pointer; its edges stay bright and every
 * other line dims, so a hover shows where a branch runs.
 */
export function GraphCell({
  row,
  head,
  width,
  highlight,
}: {
  row: GraphLaneRow;
  head?: boolean;
  width: number;
  highlight: number | null;
}) {
  const color = (i: number) => gitGraphBridge()?.laneColor(i) ?? "currentColor";
  const cy = ROW_HEIGHT / 2;
  const dim = (c: number) => (highlight !== null && highlight !== c ? styles.dim : undefined);
  return (
    <svg className={styles.graph} width={width} height={ROW_HEIGHT} aria-hidden>
      {row.up.map((s, i) => (
        <path
          key={`u${i}`}
          className={dim(s.color)}
          d={seg(x(s.from), 0, x(s.to), cy)}
          stroke={color(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {row.down.map((s, i) => (
        <path
          key={`d${i}`}
          className={dim(s.color)}
          d={seg(x(s.from), cy, x(s.to), ROW_HEIGHT)}
          stroke={color(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {head ? (
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
