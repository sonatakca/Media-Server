import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface DatabaseExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export type DatabaseConnection = Pool | PoolClient | DatabaseExecutor;
