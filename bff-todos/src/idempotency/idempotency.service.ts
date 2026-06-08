import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}

// Closes the at-least-once gap: if the BFF ran a mutation but the response
// never reached the client, the FE retries with the same X-Client-Op-Id and
// `guardOrReplay` returns the cached response from the first run instead of
// re-executing the work.
//
// Resolver usage:
//   return this.idem.guardOrReplay(opId, () => this.svc.createTodo(input));
//
// When `opId` is missing (header not sent) the helper falls through to a
// plain call — the FE only sends the header for ops that come through the
// durable queue.
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async guardOrReplay<T>(
    clientOpId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!clientOpId) return work();

    const cached = await this.prisma.clientOpResult.findUnique({
      where: { clientOpId },
    });
    if (cached) {
      try {
        // Revive ISO-8601 strings back into Date instances. Prisma returns
        // Date objects from `findUnique` etc.; on first run we cached the
        // resolver return value as JSON so retries see the same shape.
        // Apollo's DateTime scalar's `serialize` rejects plain strings —
        // it wants a Date. Without this reviver every retried mutation
        // that returns a row with `createdAt`/`updatedAt` would 500.
        return JSON.parse(cached.responseJson, reviveDates) as T;
      } catch {
        // Corrupt row — fall through and re-execute. The upsert below
        // overwrites it.
      }
    }

    const result = await work();
    try {
      await this.prisma.clientOpResult.upsert({
        where: { clientOpId },
        create: {
          clientOpId,
          responseJson: JSON.stringify(result ?? null),
        },
        update: {},
      });
    } catch (err) {
      // Don't fail the user's mutation if the dedup write fails — worst case
      // a retry re-runs server work, which is the same risk as before this
      // helper existed.
      console.warn(
        '[idempotency] failed to persist result for',
        clientOpId,
        err,
      );
    }
    return result;
  }
}
