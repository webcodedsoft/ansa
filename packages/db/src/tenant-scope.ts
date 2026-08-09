import { asTenantId, type TenantId } from "@ansa/shared";
import type { DataSource, EntityManager } from "typeorm";

/**
 * A database handle that is bound to one tenant for the life of a transaction.
 *
 * Everything reachable from here inherits `app.tenant_id`, so RLS filters it. Anything
 * obtained outside this scope does not, and — because `app.current_tenant()` returns
 * NULL when unset — sees zero rows rather than everyone's. It fails closed, but it
 * presents as "the database is empty", so use this and not `dataSource.getRepository()`.
 */
export interface TenantScope {
  readonly tenantId: TenantId;
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * `update` or `delete` with a `returning` clause. Use this, not `query`, for those two.
   *
   * TypeORM's Postgres driver returns the rows for a `select`, and `[rows, affectedCount]`
   * for an `update` or a `delete` — a two-element array whether or not anything matched.
   * So `(await scope.query("update … returning id")).length > 0` is **always true**, and
   * the shape of that bug is a handler that reports success for a row it did not touch.
   *
   * Found by the adversarial API test: "change a member of another organisation" answered
   * 200 while changing nothing, because RLS correctly matched zero rows and the check for
   * zero rows could not see it. RLS held; the code above it drew the wrong conclusion.
   */
  mutate<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  readonly manager: EntityManager;
}

/** Unwraps the `[rows, affectedCount]` an update or delete comes back as. */
const returnedRows = <T>(result: unknown): T[] => {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === "number"
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
};

/**
 * Runs `work` in a transaction scoped to one tenant.
 *
 * The tenant is set with `set_config(..., true)` — transaction-local. A session-level
 * `SET` would survive the connection's return to the pool and hand the next caller
 * someone else's tenant, which is the cross-tenant leak this whole layer exists to
 * prevent. It is also what makes this safe through Supabase's transaction-mode pooler.
 */
export const withTenant = async <T>(
  dataSource: DataSource,
  tenantId: TenantId,
  work: (scope: TenantScope) => Promise<T>,
): Promise<T> => {
  // Rejects here rather than letting a malformed value reach Postgres, where the cast
  // in app.current_tenant() would fail mid-transaction with a less obvious error.
  const tenant = asTenantId(tenantId);

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();

  try {
    await runner.query("select set_config('app.tenant_id', $1, true)", [tenant]);

    const result = await work({
      tenantId: tenant,
      query: async <R = unknown>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await runner.query(sql, [...params])) as R[],
      mutate: async <R = unknown>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        returnedRows<R>(await runner.query(sql, [...params])),
      manager: runner.manager,
    });

    await runner.commitTransaction();
    return result;
  } catch (error) {
    // The transaction may already be aborted by the failing statement; rolling back a
    // dead transaction would replace the real error with a meaningless one.
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction().catch(() => undefined);
    }
    throw error;
  } finally {
    await runner.release();
  }
};
