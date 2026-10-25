export type SaveState = "pending" | "saving" | "saved" | "error";

// Serialize writes: a slow response for an old date must not overwrite a newer
// value. A failed latest value stays dirty until explicitly retried/changed.
export function createAutosave<T>(
  save: (value: T) => Promise<unknown>,
  notify: (state: SaveState) => void,
  delay = 600,
) {
  let pending: {value:T} | undefined;
  let running: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let revision = 0;
  async function flush(): Promise<void> {
    clearTimeout(timer);
    if (disposed) return;
    if (running) { await running; return flush(); }
    const next = pending;
    if (!next) return;
    pending = undefined;
    notify("saving");
    running = Promise.resolve().then(()=>save(next.value));
    try {
      await running;
      if (!disposed && !pending) notify("saved");
    } catch (error) {
      if (!disposed) { pending ??= next; notify("error"); }
      throw error;
    } finally { running = undefined; }
    if (pending && !disposed) await flush();
  }
  return {
    set(value:T) {
      if (disposed) return;
      revision += 1;
      pending={value}; notify("pending"); clearTimeout(timer);
      timer=setTimeout(()=>{void flush().catch(()=>{});},delay);
    },
    flush,
    isDirty:()=>Boolean(pending || running),
    revision:()=>revision,
    // A GET begun before/during a write can return old data AFTER the write
    // succeeds. Capture both edit sequence and initial dirty state.
    captureRead() {
      const startRevision=revision, startedDirty=Boolean(pending || running);
      return ()=>!disposed && !startedDirty && !pending && !running && revision===startRevision;
    },
    dispose() { disposed=true; pending=undefined; clearTimeout(timer); },
  };
}
