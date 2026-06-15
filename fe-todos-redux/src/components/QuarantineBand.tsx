import { runner } from '../queue/runner';
import type { QuarantineRow } from '../queue/types';

export function QuarantineBand({ op }: { op: QuarantineRow }) {
  return (
    <div className="mt-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm">
      <div className="flex items-center gap-2 text-red-300 font-semibold">
        <span aria-hidden>⚠️</span>
        <span>Failed</span>
      </div>
      <div className="text-red-200/80 mt-1 break-words">
        {op.quarantineError ?? 'unknown error'}
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => runner.retryCascade(op.correlationKey)}
          className="bg-red-500/30 hover:bg-red-500/50 text-red-100 px-3 py-1 rounded text-sm transition-colors"
        >
          Retry
        </button>
        <button
          onClick={() => runner.discardCascade(op.correlationKey)}
          className="bg-transparent hover:bg-red-500/20 text-red-200 border border-red-500/40 px-3 py-1 rounded text-sm transition-colors"
        >
          Discard
        </button>
      </div>
    </div>
  );
}