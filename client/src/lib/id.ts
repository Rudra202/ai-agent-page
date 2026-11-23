let counter = 0;

/** Unique id for messages, events and documents. */
export function newId(): string {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${random.slice(0, 8)}-${counter}`;
}
