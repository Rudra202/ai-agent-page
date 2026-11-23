/** A unique constraint was violated, for example a second account with the same email. */
export class DuplicateError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Duplicate value for ${field}`);
    this.name = 'DuplicateError';
    this.field = field;
  }
}
