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
  readonly manager: EntityManager;
}

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
