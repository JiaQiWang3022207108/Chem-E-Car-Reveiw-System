export interface FankeQueueResult {
  processed: number;
  ignored: number;
  invalid: number;
  retried: number;
  remaining: number;
  ready: number;
  processing: number;
  waitingRetry: number;
}

// Drains bounded server requests, not one long-lived request for all EDPs.
// A delayed retry or somebody else's live claim must stay visible, without
// issuing hundreds of empty requests or causing a duplicate download.
export async function drainFankeQueue(
  collect: () => Promise<FankeQueueResult>,
  stopped: () => boolean = () => false,
  progress?: (result: FankeQueueResult) => void,
): Promise<FankeQueueResult> {
  const totals: FankeQueueResult = { processed: 0, ignored: 0, invalid: 0, retried: 0, remaining: 0, ready: 0, processing: 0, waitingRetry: 0 };
  for (let round = 0; round < 200 && !stopped(); round += 1) {
    const result = await collect();
    totals.processed += result.processed;
    totals.ignored += result.ignored;
    totals.invalid += result.invalid;
    totals.retried += result.retried;
    totals.remaining = result.remaining;
    totals.ready = result.ready;
    totals.processing = result.processing;
    totals.waitingRetry = result.waitingRetry;
    progress?.({ ...totals });
    if (!result.remaining || !result.ready) break;
  }
  return totals;
}
