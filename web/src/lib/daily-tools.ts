import type { DimensionDayStats, MessageDetail, ToolPart } from '../types/api'

export interface DailyToolRow {
  date: string
  name: string
  calls: number
  sessions: number
  share: number
  sourceId?: string
}

export interface DailyToolTotalRow {
  date: string
  calls: number
  tools: number
}

export interface ToolCallRow {
  key: string
  messageId: string
  sessionId: string
  sessionTitle: string
  timeCreated: string
  tool: string
  status: string
  summary: string
  part: ToolPart
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

export function buildDailyToolTotals(rows: readonly DailyToolRow[]): DailyToolTotalRow[] {
  const totals = new Map<string, { calls: number; tools: Set<string> }>()
  for (const row of rows) {
    const total = totals.get(row.date) ?? { calls: 0, tools: new Set<string>() }
    total.calls += row.calls
    total.tools.add(row.name)
    totals.set(row.date, total)
  }

  return [...totals.entries()]
    .map(([date, total]) => ({ date, calls: total.calls, tools: total.tools.size }))
    .sort((left, right) => right.date.localeCompare(left.date))
}

function callTime(part: ToolPart, fallback: string): string {
  const startedAt = part.state.time?.start
  // Epoch milliseconds before 2000 are much more likely to be provider-local
  // durations or test values than real timestamps. Fall back to the message.
  if (!startedAt || startedAt < 946684800000) return fallback
  const parsed = new Date(startedAt)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function callSummary(part: ToolPart): string {
  if (part.state.status === 'error' && part.state.error) return part.state.error
  if (part.state.title) return part.state.title
  if (part.state.output) return part.state.output
  return ''
}

export function flattenToolCalls(details: readonly MessageDetail[]): ToolCallRow[] {
  const rows: ToolCallRow[] = []
  for (const detail of details) {
    detail.content.tool_parts.forEach((part, index) => {
      rows.push({
        key: `${detail.id}/${part.call_id || index}`,
        messageId: detail.id,
        sessionId: detail.session_id,
        sessionTitle: detail.session_title,
        timeCreated: callTime(part, detail.time_created),
        tool: part.tool || 'unknown-tool',
        status: part.state.status || 'unknown',
        summary: callSummary(part).slice(0, 240),
        part,
      })
    })
  }

  return rows.sort((left, right) => {
    const byTime = right.timeCreated.localeCompare(left.timeCreated)
    if (byTime !== 0) return byTime
    return left.tool.localeCompare(right.tool)
  })
}
