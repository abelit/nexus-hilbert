// The query string shared by instance pickers. The needle is a VALUE, not an
// expression: commas separate DSL terms and a trailing backslash escapes one,
// so both are escaped before the free-text wildcard is added.
export function instanceSearchQuery(typeID: number, needle: string): string {
  const text = needle
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,');
  return text ? `_type:${typeID},*${text}*` : `_type:${typeID}`;
}
