/** AED 350,000 */
export function formatAed(amount: number): string {
  return `AED ${Math.round(amount).toLocaleString('en-US')}`;
}
