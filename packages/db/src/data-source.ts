import { DataSource } from "typeorm";

/**
 * The database handle, as everything above this package sees it.
 *
 * Exported under our own name for the same reason no vendor type leaves a provider
 * package: swapping the driver should be a change here, not in the Nest module and the
 * tenant registry and everything else that happens to hold a connection.
 */
export type Db = DataSource;

export interface DbConfig {
  /**
   * Must point at a role with `rolbypassrls = false`. Supabase's `postgres` has
   * BYPASSRLS and would render every policy inert — see migrations/0002_rls.sql.
   */
  readonly url: string;
  readonly poolSize?: number;
}

export const createDataSource = (config: DbConfig): DataSource =>
  new DataSource({
    type: "postgres",
    url: config.url,
    // Migrations are the only authority on schema. synchronize would let a code change
    // silently alter production tables, including dropping the RLS policies.
    synchronize: false,
    logging: false,
    entities: [],
    poolSize: config.poolSize ?? 10,
  });
