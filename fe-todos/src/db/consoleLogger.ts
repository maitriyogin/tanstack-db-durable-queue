import type { MutationLogger, MutationLogStage } from './mutationQueue';

// Group stages into colored "lanes" so a mutation's flow stands out even
// when other ops are running concurrently. The browser's console handles
// %c-style formatting; nothing else picks up the color codes.
const STAGE_COLOR: Record<MutationLogStage, string> = {
  enqueue: 'color: #22c55e; font-weight: bold',                   // green
  pick: 'color: #94a3b8',                                          // grey
  inflight: 'color: #3b82f6; font-weight: bold',                  // blue (Sending…)
  ack: 'color: #16a34a; font-weight: bold',                       // green (success)
  reject: 'color: #f59e0b',                                        // amber (transient fail)
  'retry-scheduled': 'color: #f59e0b',
  'retry-immediate': 'color: #f59e0b',
  quarantine: 'color: #dc2626; font-weight: bold',                // red
  cascade: 'color: #dc2626',
  'recovery-retry': 'color: #8b5cf6; font-weight: bold',          // purple
  'recovery-discard': 'color: #8b5cf6; font-weight: bold',
  'recovery-discard-anchor': 'color: #8b5cf6; font-weight: bold',
  'cold-boot-recover': 'color: #ec4899',                          // pink
  'cold-boot-cap-quarantine': 'color: #dc2626',
  'trigger-drain': 'color: #0ea5e9',                              // cyan
  'wake-scheduled': 'color: #94a3b8',
  'bind-temp-to-server': 'color: #14b8a6',                        // teal
  'projection-apply': 'color: #16a34a',
  'projection-error': 'color: #dc2626',
  invalidate: 'color: #14b8a6',
  'register-collection': 'color: #94a3b8',
  'offline-paused': 'color: #f97316',                              // orange
  'clear-local-state': 'color: #ef4444; font-weight: bold',        // red (destructive)
  'store-snapshot': 'color: #6366f1; font-weight: bold',           // indigo
};

// Default browser-friendly logger. Prefixes every line with [durableQueue],
// colors the stage, then dumps the detail object as the second arg so it's
// expandable in DevTools.
export const consoleLogger: MutationLogger = (stage, detail) => {
  const style = STAGE_COLOR[stage] ?? 'color: inherit';
  // eslint-disable-next-line no-console
  console.log(`%c[durableQueue] %c${stage}`, 'color: #64748b', style, detail);
};
