import { analysesInProgress } from "../analysisJobs";
import { exportsInProgress } from "../audioExport";
import { narrationRunsInProgress } from "../narrationWorker";

/**
 * Long-running work happening in this process right now.
 *
 * On Cloudflare the container would otherwise be put to sleep after a quiet
 * spell with no page open, stopping a book mid-render. The Worker asks this
 * before letting it sleep, and the shutdown handler waits on it.
 */
export function workInProgress() {
  const narration = narrationRunsInProgress();
  const analysis = analysesInProgress();
  const exports = exportsInProgress();
  return { narration, analysis, exports, busy: narration + analysis + exports > 0 };
}
