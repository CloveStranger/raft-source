/** Agent-facing App hint length is measured after trimming, in Unicode code points. */
export const APP_WHEN_TO_USE_MAX_CODE_POINTS = 160;
export function countAppWhenToUseCharacters(value: string): number {
  return Array.from(value.trim()).length;
}
export function isAppWhenToUseTooLong(value: string): boolean {
  return countAppWhenToUseCharacters(value) > APP_WHEN_TO_USE_MAX_CODE_POINTS;
}
