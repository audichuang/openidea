import { useRef, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { reorderedTabs, useWindowGroup } from "@/platform/windowGroups";
import { clampZoom } from "@/platform/zoom";
import { Icon, IconButton, showContextMenu } from "@/ui";
import { notifications } from "./contributions";
import styles from "./WindowGroupTabs.module.css";

function run(work: Promise<unknown>) {
  void work.catch((e) => notifications().notify({ level: "error", title: "Window group", body: String(e) }));
}

/**
 * macOS draws the group's tabs in its own tab bar over the page, below the title bar or, in
 * fullscreen, at the very top: keep that room free on the matching side of the title bar.
 */
function SystemTabBarSpace({ top }: { top: boolean }) {
  const bar = useWindowGroup((state) => state.systemTabBar);
  const zoom = useProject((s) => clampZoom(s.settings?.appearance?.zoom));
  const height = bar.height ?? 0;
  if (height <= 0 || bar.top !== top) return null;
  // Native points; page zoom scales CSS pixels.
  return <div className={styles.systemBar} style={{ height: (height * 100) / zoom }} data-window-group="system" />;
}

/**
 * `top`: the slot above the title bar (only the macOS fullscreen tab bar uses it). `hidePageTabs`
 * (Distraction Free) hides page-drawn tabs; the system tab bar stays, and so does its room.
 */
export function WindowGroupTabs({ top = false, hidePageTabs = false }: { top?: boolean; hidePageTabs?: boolean }) {
  const system = usePlatform((s) => s.overlayTitleBar);
  if (system) return <SystemTabBarSpace top={top} />;
  return top || hidePageTabs ? null : <PageTabs />;
}

function PageTabs() {
  const tabs = useWindowGroup((state) => state.tabs);
  const drag = useRef<{ label: string; x: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const tx = useTx();
  if (tabs.length < 2) return null;
  return (
    <div className={styles.bar} data-window-group>
      <div className={styles.tabs} role="tablist" aria-label={tx("Project windows")}>
        {tabs.map((tab) => (
          <div
            className={`${styles.item} ${tab.current ? styles.selected : ""} ${dragging === tab.label ? styles.dragging : ""}`}
            key={tab.label}
            data-project-tab={tab.label}
            onPointerDown={(e) => {
              drag.current = null;
              if (e.button === 0 && (e.target as Element).closest('[role="tab"]'))
                drag.current = { label: tab.label, x: e.clientX, moved: false };
            }}
            onPointerMove={(e) => {
              if (drag.current && Math.abs(e.clientX - drag.current.x) > 5) {
                drag.current.moved = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(tab.label);
              }
            }}
            onPointerUp={(e) => {
              const source = drag.current;
              if (source?.moved) {
                const target = document
                  .elementFromPoint(e.clientX, e.clientY)
                  ?.closest<HTMLElement>("[data-project-tab]")?.dataset.projectTab;
                if (target) run(executeAction("window.reorderTabs", reorderedTabs(tabs, source.label, target)));
              }
              setDragging(null);
              // Keep the moved flag through the click following pointerup.
              if (!source?.moved) drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(null);
            }}
            onClickCapture={(e) => {
              if (drag.current?.moved) {
                e.preventDefault();
                e.stopPropagation();
                drag.current = null;
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showContextMenu(e, [
                {
                  label: "Move Tab to New Window",
                  disabled: !tab.current,
                  run: () => executeAction("window.detachTab"),
                },
                { label: "Close Tab", run: () => executeAction("window.closeTab", tab.label) },
              ]);
            }}
          >
            <button
              className={styles.tab}
              role="tab"
              aria-selected={tab.current}
              tabIndex={tab.current ? 0 : -1}
              title={tab.root ?? tab.name}
              onClick={() => run(executeAction("window.selectTab", tab.label))}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const index = tabs.indexOf(tab);
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? tabs.length - 1
                      : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                run(executeAction("window.selectTab", tabs[next]!.label));
              }}
            >
              <Icon name="folder" size={14} />
              <span>{tab.name}</span>
            </button>
            <IconButton
              icon="close"
              size="small"
              title={tx`Close ${tab.name}`}
              onClick={() => run(executeAction("window.closeTab", tab.label))}
            />
          </div>
        ))}
      </div>
      <IconButton icon="external-link" title="Move Tab to New Window" action="window.detachTab" />
    </div>
  );
}
