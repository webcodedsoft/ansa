import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { EmptyState, Table, Td, Th, Tr } from "./feedback";

/**
 * One column, described rather than drawn.
 *
 * The header and the cell live in the same object on purpose: the commonest
 * table bug is a header that no longer names what is under it, and that cannot
 * happen when adding a column means adding one entry.
 */
export interface Column<T> {
  /** Stable across renders, and the React key for the cell. */
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /** Numbers read right-aligned; text does not. */
  readonly align?: "right";
  /** A Tailwind width class, e.g. `w-[92px]`, applied to header and cells alike. */
  readonly width?: string;
  /** Extra classes for the cells in this column, not the header. */
  readonly className?: string;
  /**
   * For a column whose header would be noise — an actions column, a chevron.
   * The header text is still rendered for screen readers, just not shown.
   */
  readonly headerHidden?: boolean;
}

export interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowKey: (row: T) => string;
  /** Shown instead of the table when there are no rows. */
  readonly empty: { readonly title: ReactNode; readonly description?: ReactNode };
  /**
   * Replaces the default row rendering while keeping the shared header.
   *
   * The escape hatch exists for one real case: a row that is itself a client
   * component holding its own state — a member row with an inline confirm, for
   * instance. Cells cannot share state between them, so such a row has to own
   * its whole `<tr>`. Everything else should use `columns` and leave this
   * alone.
   */
  readonly renderRow?: (row: T) => ReactNode;
}

/**
 * The table every list in this app is drawn with.
 *
 * It deliberately does not sort, filter or paginate. Sorting and filtering
 * belong to the API — a client that reorders the page it happens to hold is
 * lying about the whole set — and pagination is `Pagination`, next to it,
 * because a cursor belongs to the URL and not to a component's state.
 */
export const DataTable = <T,>({ rows, columns, rowKey, empty, renderRow }: DataTableProps<T>) => {
  if (rows.length === 0) {
    return <EmptyState title={empty.title}>{empty.description}</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          {columns.map((column) => (
            <Th
              key={column.key}
              className={cn(column.width, column.align === "right" && "text-right")}
            >
              {column.headerHidden === true ? (
                <span className="sr-only">{column.header}</span>
              ) : (
                column.header
              )}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) =>
          renderRow !== undefined ? (
            renderRow(row)
          ) : (
            <Tr key={rowKey(row)}>
              {columns.map((column) => (
                <Td
                  key={column.key}
                  className={cn(column.width, column.align === "right" && "text-right", column.className)}
                >
                  {column.cell(row)}
                </Td>
              ))}
            </Tr>
          ),
        )}
      </tbody>
    </Table>
  );
};
