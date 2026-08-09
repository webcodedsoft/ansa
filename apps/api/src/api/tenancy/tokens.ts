/**
 * The dashboard's own connection pool.
 *
 * Separate from the call path's `DATA_SOURCE` for two reasons that are both about failure
 * rather than tidiness.
 *
 * Capacity: a dashboard is bursty and a call is not. Sharing one pool means a report query
 * and twenty people refreshing a page can exhaust the connections a live call needs to
 * write its transcript, and the caller is the one who pays.
 *
 * Policy: the two want opposite things from an unreachable database. The call path
 * degrades to default configuration and answers anyway, because silence on the line is
 * worse than a generic greeting (R6.2). The dashboard must refuse — returning an empty
 * call list to someone auditing their calls is a lie, and returning "not signed in" to
 * someone who is would be worse. One pool cannot hold both policies.
 */
export const API_DATA_SOURCE = Symbol("API_DATA_SOURCE");
