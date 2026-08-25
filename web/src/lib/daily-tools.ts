import type { DimensionDayStats } from '../types/api'

export interface DailyToolRow {
  date: string
  name: string
  calls: number
  sessions: number
  share: number
  sourceId?: string
}

/**
 * Converts the generic tool-dimension response into rows suitable for the
 * Tools page. The API names invocation counts `messages` because dimensions
 * share one response shape; for the tool dimension each message is one call.
 */
export function buildDailyToolRows(days: readonly DimensionDayStats[] | undefined): DailyToolRow[] {
  if (!days || days.length === 0) return []

  const validDays = days.filter((day) => day.dimension_key.trim().length > 0)
  const totalsByDate = new Map<string, number>()
  for (const day of validDays) {
    totalsByDate.set(day.date, (totalsByDate.get(day.date) ?? 0) + day.messages)
  }

  return validDays
    .map((day) => {
      const total = totalsByDate.get(day.date) ?? 0
      return {
        date: day.date,
        name: day.dimension_key,
        calls: day.messages,
        sessions: day.sessions,
        share: total > 0 ? (day.messages / total) * 100 : 0,
        sourceId: day.source_id,
      }
    })
    .sort((left, right) => {
      const byDate = right.date.localeCompare(left.date)
      if (byDate !== 0) return byDate
      if (right.calls !== left.calls) return right.calls - left.calls
      return left.name.localeCompare(right.name)
    })
}
