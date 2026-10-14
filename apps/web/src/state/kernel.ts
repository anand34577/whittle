/** Keeps the geometry kernel in sync with the document. */
import { WorkerKernel } from "@whittle/kernel";
import { findFeature, useApp } from "./store";

let kernel: WorkerKernel | null = null;
let scheduled = false;
let pending = 0;

export function getKernel(): WorkerKernel {
  if (!kernel) throw new Error("Kernel not started");
  return kernel;
}

function pickBeforeFor(): string | undefined {
  const { session, doc } = useApp.getState();
  if (!session) return undefined;
  const f = findFeature(doc, session.featureId);
  return f && ["fillet", "chamfer", "shell", "hole", "combine", "move"].includes(f.type) ? f.id : undefined;
}

function schedule() {
  if (scheduled || !kernel || !useApp.getState().kernelReady) return;
  scheduled = true;
  requestAnimationFrame(async () => {
    scheduled = false;
    const { doc, session } = useApp.getState();
    pending++;
    useApp.setState({ regenBusy: true });
    try {
      const result = await kernel!.regen(doc, session ? "preview" : "final", pickBeforeFor());
      if (result) useApp.setState({ regen: result, kernelError: null });
    } catch (e) {
      useApp.setState({ kernelError: e instanceof Error ? e.message : String(e) });
    } finally {
      pending--;
      if (pending === 0) useApp.setState({ regenBusy: false });
    }
  });
}

export function startKernel() {
  if (kernel) return;
  kernel = new WorkerKernel();
  kernel.ready
    .then(() => {
      useApp.setState({ kernelReady: true });
      schedule();
    })
    .catch((e: Error) => useApp.setState({ kernelError: e.message }));

  let lastDoc = useApp.getState().doc;
  let lastSession = useApp.getState().session;
  useApp.subscribe((s) => {
    if (s.doc !== lastDoc || s.session !== lastSession) {
      lastDoc = s.doc;
      lastSession = s.session;
      schedule();
    }
  });
}