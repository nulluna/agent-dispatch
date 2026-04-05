export type LogWriter = (entry: string) => void

export function writeJsonLog(
  entry: Record<string, unknown>,
  writer: LogWriter = console.log,
): void {
  writer(JSON.stringify(entry))
}
