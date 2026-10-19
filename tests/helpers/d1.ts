import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface TestDatabaseOptions {
  beforeStatement?: (query: string, batchIndex: number | null) => void;
}

export interface TestDatabase {
  db: D1Database;
  sqlite: DatabaseSync;
  close(): void;
}

function bindValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Unsupported D1 binding');
}

class SqlitePreparedStatement implements D1PreparedStatement {
  constructor(
    readonly database: SqliteD1Database,
    readonly query: string,
    readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(
      this.database,
      this.query,
      values.map(bindValue),
    );
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(
    colName?: string,
  ): Promise<T | null> {
    const row = this.database.execute<Record<string, unknown>>(this, null)
      .results[0];
    if (!row) {
      return null;
    }
    if (colName !== undefined) {
      if (!(colName in row)) {
        throw new Error(`D1 column not found: ${colName}`);
      }
      return row[colName] as T;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this, null);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this, null);
  }

  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const result = this.database.execute<Record<string, unknown>>(this, null);
    const rows = result.results.map((row) => Object.values(row) as T);
    if (options?.columnNames) {
      const names = this.database.sqlite
        .prepare(this.query)
        .columns()
        .map((column) => column.name);
      return [names, ...rows];
    }
    return rows;
  }
}

class SqliteD1Database implements D1Database {
  constructor(
    readonly sqlite: DatabaseSync,
    private readonly options: TestDatabaseOptions,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this, query);
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement, index) => {
        if (
          !(statement instanceof SqlitePreparedStatement) ||
          statement.database !== this
        ) {
          throw new Error('Statement belongs to another test database');
        }
        return this.execute<T>(statement, index);
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.options.beforeStatement?.(query, null);
    this.sqlite.exec(query);
    return {
      count: query.split(';').filter((statement) => statement.trim()).length,
      duration: 0,
    };
  }

  withSession(): D1DatabaseSession {
    // A single synchronous SQLite connection already provides session consistency.
    return {
      prepare: (query) => this.prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) =>
        this.batch<T>(statements),
      getBookmark: () => null,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error(
      'The deprecated D1 dump API is not supported by this helper',
    );
  }

  execute<T>(
    statement: SqlitePreparedStatement,
    batchIndex: number | null,
  ): D1Result<T> {
    this.options.beforeStatement?.(statement.query, batchIndex);
    const before = this.sqlite.prepare('SELECT total_changes() AS total').get();
    const results = this.sqlite
      .prepare(statement.query)
      .all(...statement.values);
    const after = this.sqlite
      .prepare(
        'SELECT total_changes() AS total, last_insert_rowid() AS last_id',
      )
      .get();
    const changes = Number(after?.total) - Number(before?.total);
    return {
      success: true,
      results: results as T[],
      meta: {
        changes,
        changed_db: changes > 0,
        duration: 0,
        last_row_id: Number(after?.last_id),
        rows_read: results.length,
        rows_written: changes,
        size_after: 0,
      },
    };
  }
}

export function createTestDatabase(
  options: TestDatabaseOptions = {},
): TestDatabase {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((entry) => entry.endsWith('.sql'))
      .sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return {
    db: new SqliteD1Database(sqlite, options),
    sqlite,
    close: () => sqlite.close(),
  };
}
