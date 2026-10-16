import { useEffect, useState } from "react";
import { stopRebuild } from "../state/kernel";
import { useApp } from "../state/store";
import { useTasks } from "../state/tasks";
import { ProgressBar, Spinner } from "./feedback";

/** True once `on` has stayed true for `ms`: short waits don't flash a spinner. */
function useAfter(on: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return setLate(false);
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && late;
}

/** What the person is waiting for right now, for the status bar (saving, opening, exporting, checking). */
export function Activity() {
  const task = useTasks((s) => s.tasks[s.tasks.length - 1]);
  if (!task) return null;
  return (
    <span className="busyline" aria-live="polite">
      <Spinner label={task.label} />
      <span className="busyline__label">{task.label}</span>
      {task.progress !== null && <ProgressBar value={task.progress} label={task.label} />}
    </span>
  );
}

/** A thin bar along the top of the status bar whenever anything is in progress. */
export function ActivityStrip() {
  const task = useTasks((s) => s.tasks[s.tasks.length - 1]);
  const building = useApp((s) => s.regenBusy && s.kernelReady);
  const showBuilding = useAfter(building, 350);
  if (!task && !showBuilding) return null;
  return (
    <div className="statusbar__strip" aria-hidden="true">
      <ProgressBar value={task ? task.progress : null} />
    </div>
  );
}

/** Over the 3D view while a rebuild takes noticeable time: step count, progress and a way to stop. */
export function RebuildChip() {
  const building = useApp((s) => s.regenBusy && s.kernelReady && !s.kernelError);
  const progress = useApp((s) => s.regenProgress);
  const show = useAfter(building, 400);
  if (!show) return null;
  const known = progress && progress.total > 1;
  return (
    <div className="viewport__chip" aria-live="polite">
      <Spinner label="Rebuilding" />
      <span>{known ? `Building step ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Building…"}</span>
      <ProgressBar value={known ? progress.done / progress.total : null} label="Rebuild progress" />
      <button className="btn btn--small btn--ghost" onClick={stopRebuild} title="Stop the rebuild (the engine restarts)">
        Stop
      </button>
    </div>
  );
}
