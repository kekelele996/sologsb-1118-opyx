/** 期别：正整数，编号越大代表越早（越深），未分期为 null */
export type Phase = number | null

/** 期别取值是否合法：空值（未分期）或正整数 */
export function isValidPhase(value: unknown): value is number | null {
  if (value === null || value === undefined || value === '') return true
  const num = Number(value)
  return Number.isInteger(num) && num >= 1
}
