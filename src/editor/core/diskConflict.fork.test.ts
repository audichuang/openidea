import { afterEach, expect, it, vi } from "vitest";
import { EditorController } from "./controller";
import { createMemoryBackend } from "./backend";
import { forkDiskConflict } from "./forkDiskConflict";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";

let ctrl: EditorController | null = null;
afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  forkDiskConflict.upstream = false;
});

/** The notification the controller shows for a disk conflict on `/p/a.ts`. */
function conflictNotice() {
  const notify = vi.fn<NotificationService["notify"]>();
  provideNotificationService({ notify });
  let conflict: ((e: { doc: number; path: string }) => void) | undefined;
  const backend = createMemoryBackend({ "/p/a.ts": "a" });
  backend.onDiskConflict = (h) => {
    conflict = h;
    return () => {};
  };
  ctrl = new EditorController(backend);
  ctrl.start();
  conflict!({ doc: 1, path: "/p/a.ts" });
  return notify.mock.calls.find(([n]) => n.key === "disk-conflict:/p/a.ts")![0];
}

it("warns about a disk conflict without upstream's Load Changes from Disk by default (#441)", () => {
  const notice = conflictNotice();
  expect(notice.sticky).toBe(true);
  expect(notice.actions).toBeUndefined();
});

it("offers upstream's Load Changes from Disk behind the switch", () => {
  forkDiskConflict.upstream = true;
  expect(conflictNotice().actions?.map((a) => a.label)).toEqual(["Load Changes from Disk", "Keep Editor Changes"]);
});
