import { Database } from 'bun:sqlite';
import {
  createSQLiteCorePersistenceAdapter,
  SingleProcessCoordinator,
  type PersistedCollectionPersistence,
  type SQLiteDriver,
  type SQLiteCoreAdapterOptions,
} from '@tanstack/db-sqlite-persistence-core';

// MEMORY journal_mode + busy_timeout avoids SQLITE_BUSY when re-opening a
// DB file across "session" boundaries inside the same process — a thing
// production never does, but tests do constantly.
const DEFAULT_PRAGMAS = [
  'journal_mode = MEMORY',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
];

// One driver instance has at most one outer transaction in flight at a time
// (serialized via `queue`). Within that transaction, an instance flag is
// enough to detect re-entrance — no need for AsyncLocalStorage.
class BunSqliteDriver implements SQLiteDriver {
  readonly db: Database;
  private queue: Promise<void> = Promise.resolve();
  private inTransaction = false;
  private nextSavepointId = 1;

  constructor(db: Database, pragmas: ReadonlyArray<string> = DEFAULT_PRAGMAS) {
    this.db = db;
    for (const p of pragmas) this.db.exec(`PRAGMA ${p}`);
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const queued = this.queue.then(operation, operation);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued as Promise<T>;
  }

  async exec(sql: string) {
    if (this.inTransaction) {
      this.db.exec(sql);
      return;
    }
    await this.enqueue(() => {
      this.db.exec(sql);
    });
  }

  async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> {
    if (this.inTransaction) return this.executeQuery<T>(sql, params);
    return this.enqueue(() => this.executeQuery<T>(sql, params));
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []) {
    if (this.inTransaction) {
      this.executeRun(sql, params);
      return;
    }
    await this.enqueue(() => {
      this.executeRun(sql, params);
    });
  }

  async transaction<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    if (this.inTransaction) return this.runNested(fn);
    return this.enqueue(async () => {
      // The DB may have been closed by a "simulated crash" between enqueue
      // and run. Bail with a quiet error rather than a stack trace.
      if (!this.db.filename) throw new Error('Database has closed');
      this.db.exec('BEGIN IMMEDIATE');
      this.inTransaction = true;
      try {
        const result = await fn(this);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // keep original error
        }
        throw error;
      } finally {
        this.inTransaction = false;
      }
    });
  }

  async transactionWithDriver<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  private executeQuery<T>(sql: string, params: ReadonlyArray<unknown>): ReadonlyArray<T> {
    const stmt = this.db.query(sql);
    return (params.length === 0 ? stmt.all() : stmt.all(...(params as any))) as ReadonlyArray<T>;
  }

  private executeRun(sql: string, params: ReadonlyArray<unknown>) {
    const stmt = this.db.prepare(sql);
    if (params.length === 0) stmt.run();
    else stmt.run(...(params as any));
  }

  private async runNested<T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> {
    const sp = `tsdb_sp_${this.nextSavepointId++}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      try {
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // The outer transaction may have already aborted, dropping the
        // savepoint. Ignore — the real outcome is decided by the outer
        // COMMIT/ROLLBACK.
      }
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // Same reason as above — savepoint cleanup is best-effort.
      }
      throw error;
    }
  }
}

// Mirrors @tanstack/node-db-sqlite-persistence's createNodeSQLitePersistence,
// but uses Bun's built-in SQLite via the driver above.
export function createBunSqlitePersistence(database: Database): PersistedCollectionPersistence {
  const driver = new BunSqliteDriver(database);
  const coordinator = new SingleProcessCoordinator();
  const adapterCache = new Map<string, ReturnType<typeof createSQLiteCorePersistenceAdapter>>();

  function getAdapter(mode: 'sync-present' | 'sync-absent', schemaVersion: number | undefined) {
    const policy = mode === 'sync-present' ? 'sync-present-reset' : 'sync-absent-error';
    const key = `${policy}|${schemaVersion ?? 'default'}`;
    const cached = adapterCache.get(key);
    if (cached) return cached;
    const adapter = createSQLiteCorePersistenceAdapter({
      driver,
      schemaMismatchPolicy: policy,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
    } as SQLiteCoreAdapterOptions);
    adapterCache.set(key, adapter);
    return adapter;
  }

  const persistence: PersistedCollectionPersistence = {
    adapter: getAdapter('sync-absent', undefined),
    coordinator,
  } as any;

  (persistence as any).resolvePersistenceForCollection = (opts: {
    collectionId: string;
    mode: 'sync-present' | 'sync-absent';
    schemaVersion?: number;
  }): PersistedCollectionPersistence =>
    ({ adapter: getAdapter(opts.mode, opts.schemaVersion), coordinator } as any);

  return persistence;
}
