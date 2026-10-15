/**
 * Read a table entry by a key that came from outside.
 *
 * Plain indexing also finds inherited properties, so a key such as
 * `"constructor"` or `"toString"` — which a payload, a filename or a caller
 * can supply — would return a function from `Object.prototype` and be taken
 * for a real entry.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
