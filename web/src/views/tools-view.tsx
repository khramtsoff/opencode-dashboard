/* Tools — per-source tool usage ranking and time-bucket breakdown (Vael).
   Costs/latency are not part of tool data, so those columns are omitted.
   Source column is only shown if entries carry distinct source_id (overview
   view); a per-source view omits it. */
import { useEffect, useMemo, useState } from 'react'
import {
  Card,
  StatCard,
  DataTable,
  Badge,
  BarRow,
  Button,
  Drawer,
  EmptyState,
  SearchInput,
  Skeleton,
  ErrorState,
  Notice,
  type Column,
  type SortSpec,
} from '../components/vael'
import { useDashboardContext } from '../components/layout/dashboard-context'
import { getDailyDimension, getMessageDetail, getMessages, getTools } from '../lib/api'
import { usePeriodControls } from '../lib/use-period-controls'
import { usePeriodResource } from '../lib/use-period-resource'
import { getNextSortState, type SortState } from '../lib/table-sort'
import { formatCompactInteger, formatDateTime, formatInteger, formatPercentage, formatShortDate, safeDivide } from '../lib/format'
import {
  buildDailyToolRows,
  buildDailyToolTotals,
  flattenToolCalls,
  type DailyToolRow,
  type DailyToolTotalRow,
  type ToolCallRow,
} from '../lib/daily-tools'
import type { MessageDetail, SourceID, ToolEntry } from '../types/api'

type SortKey = 'tool' | 'invocations' | 'successRate' | 'failures' | 'sessions' | 'share'

const DEFAULT_SORT_DIRECTIONS: Record<SortKey, 'asc' | 'desc'> = {
  tool: 'asc',
  invocations: 'desc',
  successRate: 'desc',
  failures: 'desc',
  sessions: 'desc',
  share: 'desc',
}

const DEFAULT_SORT: SortState<SortKey> = { key: 'invocations', direction: 'desc' }

function getDailyTools(period: string, signal?: AbortSignal, sourceId?: SourceID) {
  return getDailyDimension('tool', period, signal, sourceId, 'day')
}

const TOOL_CALL_MESSAGE_PAGE_SIZE = 100
const TOOL_CALL_DETAIL_BATCH_SIZE = 8

async function loadToolCallsForDay(date: string, signal: AbortSignal, sourceId: SourceID) {
  const period = `from_${date}_to_${date}`
  const messageIds: string[] = []
  let page = 1

  while (true) {
    const result = await getMessages(period, page, TOOL_CALL_MESSAGE_PAGE_SIZE, 'time:desc', signal, sourceId)
    messageIds.push(...result.messages.filter((message) => message.role === 'assistant').map((message) => message.id))
    if (page * result.page_size >= result.total) break
    page += 1
  }

  const details: MessageDetail[] = []
  let failedDetails = 0
  for (let i = 0; i < messageIds.length; i += TOOL_CALL_DETAIL_BATCH_SIZE) {
    const batch = await Promise.all(messageIds.slice(i, i + TOOL_CALL_DETAIL_BATCH_SIZE).map(async (id) => {
      try {
        return await getMessageDetail(id, signal, sourceId)
      } catch (caught) {
        if (signal.aborted) throw caught
        failedDetails += 1
        return null
      }
    }))
    details.push(...batch.filter((detail) => detail !== null))
  }

  return { calls: flattenToolCalls(details), failedDetails }
}

interface ToolRow extends ToolEntry {
  share: number
  successRate: number
}

function toolLabel(tool: ToolEntry) {
  return tool.name || 'Unknown tool'
}

function stabilityTone(failures: number) {
  if (failures === 0) return 'success' as const
  if (failures < 5) return 'warning' as const
  return 'danger' as const
}

function stabilityLabel(failures: number) {
  if (failures === 0) return 'stable'
  if (failures < 5) return 'watch'
  return 'hot'
}

function successColor(rate: number) {
  if (rate >= 95) return 'var(--success)'
  if (rate >= 90) return 'var(--fg-primary)'
  return 'var(--warning)'
}

function compareRows(key: SortKey, a: ToolRow, b: ToolRow): number {
  switch (key) {
    case 'tool': return toolLabel(a).localeCompare(toolLabel(b))
    case 'successRate': return b.successRate - a.successRate
    case 'failures': return b.failures - a.failures
    case 'sessions': return b.sessions - a.sessions
    case 'share':
    case 'invocations': default: return b.invocations - a.invocations
  }
}

export function ToolsView() {
  const { requestRefresh, selectedSourceId } = useDashboardContext()
  const { cacheKey } = usePeriodControls()
  const { data, loading, error } = usePeriodResource(getTools, cacheKey)
  const {
    data: dailyData,
    loading: dailyLoading,
    error: dailyError,
  } = usePeriodResource(getDailyTools, cacheKey)
  const [sortState, setSortState] = useState<SortState<SortKey> | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedDay, setSelectedDay] = useState<DailyToolTotalRow | null>(null)
  const [selectedCall, setSelectedCall] = useState<ToolCallRow | null>(null)
  const [dayCalls, setDayCalls] = useState<ToolCallRow[]>([])
  const [dayCallsLoading, setDayCallsLoading] = useState(false)
  const [dayCallsError, setDayCallsError] = useState<string | null>(null)
  const [failedCallDetails, setFailedCallDetails] = useState(0)
  const [dayCallsNonce, setDayCallsNonce] = useState(0)

  const summary = useMemo(() => {
    if (!data) return null

    const totalInvocations = data.tools.reduce((a, t) => a + t.invocations, 0)
    const totalSuccesses = data.tools.reduce((a, t) => a + t.successes, 0)
    const totalFailures = data.tools.reduce((a, t) => a + t.failures, 0)

    const rows = data.tools.map<ToolRow>((tool) => ({
      ...tool,
      share: safeDivide(tool.invocations, totalInvocations) * 100,
      successRate: safeDivide(tool.successes, tool.invocations) * 100,
    }))

    const effective = sortState ?? DEFAULT_SORT
    const sortedRows = [...rows].sort((left, right) => {
      const primary = compareRows(effective.key, left, right)
      const m = effective.direction === DEFAULT_SORT_DIRECTIONS[effective.key] ? 1 : -1
      const d = primary * m
      if (d !== 0) return d
      if (right.invocations !== left.invocations) return right.invocations - left.invocations
      return toolLabel(left).localeCompare(toolLabel(right))
    })

    const usageLeader = [...rows].sort((a, b) => b.invocations - a.invocations)[0] ?? null

    return {
      rows: sortedRows,
      usageLeader,
      totalInvocations,
      totalSuccesses,
      totalFailures,
      overallSuccessRate: safeDivide(totalSuccesses, totalInvocations) * 100,
      empty: rows.length === 0,
    }
  }, [data, sortState])

  // The filter narrows the table only — the KPI cards and each row's share stay
  // relative to every tool in the range, so a share doesn't silently rebase to
  // the visible subset (matches the TUI's `/` filter).
  const visibleRows = useMemo(() => {
    const rows = summary?.rows ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) => toolLabel(row).toLowerCase().includes(needle))
  }, [summary?.rows, filter])

  const dailyRows = useMemo(() => buildDailyToolRows(dailyData?.days), [dailyData?.days])
  const dailyTotals = useMemo(() => buildDailyToolTotals(dailyRows), [dailyRows])

  const visibleDailyRows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return dailyRows
    return dailyRows.filter((row) => row.name.toLowerCase().includes(needle))
  }, [dailyRows, filter])

  const dailySummary = useMemo(() => ({
    buckets: dailyTotals.length,
    calls: dailyTotals.reduce((total, row) => total + row.calls, 0),
  }), [dailyTotals])

  useEffect(() => {
    if (!selectedDay) return

    const controller = new AbortController()

    loadToolCallsForDay(selectedDay.date, controller.signal, selectedSourceId)
      .then((result) => {
        if (controller.signal.aborted) return
        setDayCalls(result.calls)
        setFailedCallDetails(result.failedDetails)
      })
      .catch((caught) => {
        if (controller.signal.aborted) return
        setDayCallsError(caught instanceof Error ? caught.message : 'Failed to load tool calls for this day')
      })
      .finally(() => {
        if (!controller.signal.aborted) setDayCallsLoading(false)
      })

    return () => controller.abort()
  }, [dayCallsNonce, selectedDay, selectedSourceId])

  // "Most failed" leaders — the TUI surfaces these prominently and the web had
  // no equivalent, so a tool that fails constantly was only visible by sorting.
  const failureLeaders = useMemo(() => {
    const failing = (summary?.rows ?? []).filter((row) => row.failures > 0)
    if (failing.length === 0) return []
    return [...failing].sort((a, b) => b.failures - a.failures).slice(0, 3)
  }, [summary?.rows])

  // Only surface a source column if entries actually carry distinct sources.
  const distinctSources = useMemo(() => {
    const ids = new Set((data?.tools ?? []).map((t) => t.source_id).filter(Boolean))
    return ids.size > 1
  }, [data?.tools])

  const sortSpec: SortSpec = {
    key: (sortState ?? DEFAULT_SORT).key,
    dir: (sortState ?? DEFAULT_SORT).direction,
  }

  const handleSort = (key: string) => {
    setSortState((current) => {
      const next = getNextSortState(current, key as SortKey, DEFAULT_SORT_DIRECTIONS[key as SortKey])
      return next ?? DEFAULT_SORT
    })
  }

  const columns: Column<ToolRow>[] = useMemo(() => {
    const cols: Column<ToolRow>[] = [
      {
        key: 'tool',
        header: 'Tool',
        sortable: true,
        render: (row, i) => (
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                flexShrink: 0,
                background: `color-mix(in srgb, var(--cat-${(i % 6) + 1}) 16%, var(--ink-800))`,
                border: '1px solid var(--border-subtle)',
              }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ font: '600 13px/1 var(--font-mono)', color: 'var(--fg-primary)' }}>{toolLabel(row)}</span>
            </span>
            <Badge tone={stabilityTone(row.failures)}>{stabilityLabel(row.failures)}</Badge>
          </span>
        ),
      },
      {
        key: 'invocations',
        header: 'Runs',
        numeric: true,
        sortable: true,
        width: 110,
        render: (row) => formatCompactInteger(row.invocations),
      },
      {
        key: 'successRate',
        header: 'Success %',
        numeric: true,
        sortable: true,
        width: 120,
        render: (row) => <span style={{ color: successColor(row.successRate) }}>{formatPercentage(row.successRate)}</span>,
      },
      {
        key: 'failures',
        header: 'Errors',
        numeric: true,
        sortable: true,
        width: 100,
        render: (row) => formatCompactInteger(row.failures),
      },
      {
        key: 'sessions',
        header: 'Sessions',
        numeric: true,
        sortable: true,
        width: 110,
        render: (row) => formatCompactInteger(row.sessions),
      },
      {
        key: 'share',
        header: 'Share',
        numeric: true,
        sortable: true,
        width: 150,
        render: (row) => {
          // The bar must use the same denominator as the number beside it —
          // share of total invocations. It used to be drawn as a share of the
          // *largest* tool, so the top row rendered a full bar labelled "40%".
          const pct = row.share
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              <span style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--ink-700)', overflow: 'hidden' }}>
                <span style={{ display: 'block', width: `${Math.min(100, Math.max(pct, row.invocations > 0 ? 4 : 0))}%`, height: '100%', background: 'var(--accent)' }} />
              </span>
              <span style={{ width: 34, textAlign: 'right' }}>{formatPercentage(row.share)}</span>
            </span>
          )
        },
      },
    ]
    return cols
  }, [])

  const dailyTotalColumns: Column<DailyToolTotalRow>[] = useMemo(() => [
    {
      key: 'date',
      header: 'Date',
      render: (row) => (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ font: '600 13px/1 var(--font-mono)', color: 'var(--fg-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {formatShortDate(row.date)}
          </span>
          <span style={{ font: '400 11px/1.2 var(--font-ui)', color: 'var(--fg-faint)' }}>Open individual calls</span>
        </span>
      ),
    },
    {
      key: 'calls',
      header: 'Total calls',
      numeric: true,
      width: 140,
      render: (row) => <span style={{ font: '700 13px/1 var(--font-mono)', color: 'var(--fg-primary)' }}>{formatInteger(row.calls)}</span>,
    },
    {
      key: 'tools',
      header: 'Distinct tools',
      numeric: true,
      width: 150,
      render: (row) => formatInteger(row.tools),
    },
    {
      key: 'inspect',
      header: '',
      numeric: true,
      width: 130,
      render: () => <span style={{ color: 'var(--accent)', font: '600 12px/1 var(--font-ui)' }}>View calls →</span>,
    },
  ], [])

  const dailyColumns: Column<DailyToolRow>[] = useMemo(() => [
    {
      key: 'date',
      header: 'Date',
      width: 150,
      render: (row) => (
        <span style={{ font: '500 12px/1 var(--font-mono)', color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {formatShortDate(row.date)}
        </span>
      ),
    },
    {
      key: 'tool',
      header: 'Tool',
      wrap: true,
      render: (row) => (
        <span style={{ font: '600 12px/1.3 var(--font-mono)', color: 'var(--fg-primary)' }}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'calls',
      header: 'Calls',
      numeric: true,
      width: 100,
      render: (row) => formatInteger(row.calls),
    },
    {
      key: 'sessions',
      header: 'Sessions',
      numeric: true,
      width: 110,
      render: (row) => formatInteger(row.sessions),
    },
    {
      key: 'share',
      header: 'Share of date',
      numeric: true,
      width: 170,
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <span style={{ width: 68, height: 6, borderRadius: 3, background: 'var(--ink-700)', overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${Math.min(100, Math.max(row.share, row.calls > 0 ? 4 : 0))}%`, height: '100%', background: 'var(--cat-2)' }} />
          </span>
          <span style={{ width: 38, textAlign: 'right' }}>{formatPercentage(row.share)}</span>
        </span>
      ),
    },
  ], [])

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ background: 'var(--ink-800)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
              <Skeleton width={90} height={11} />
              <Skeleton width={120} height={28} style={{ marginTop: 12 }} />
            </div>
          ))}
        </div>
        <div style={{ background: 'var(--ink-800)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-xl)', height: 320 }} />
      </div>
    )
  }

  if (!data || !summary) {
    return <Card><ErrorState title="Tools failed to load" message={error ?? undefined} onRetry={requestRefresh} /></Card>
  }

  const topToolLabel = summary.usageLeader ? toolLabel(summary.usageLeader) : 'No data'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Notice tone="warning" title="Tools partially loaded">{error}</Notice>}
      {dailyError && <Notice tone="warning" title="Daily tool usage failed to load">{dailyError}</Notice>}

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <StatCard
          accent
          label="Tracked tools"
          value={formatInteger(summary.rows.length)}
          hint={summary.rows.length === 1 ? 'One tool recorded' : 'Distinct tool names'}
        />
        <StatCard
          label="Total runs"
          value={formatInteger(summary.totalInvocations)}
          title={formatInteger(summary.totalInvocations)}
          hint={`${formatCompactInteger(summary.totalSuccesses)} ok · ${formatCompactInteger(summary.totalFailures)} failed`}
        />
        <StatCard
          label="Overall success"
          value={formatPercentage(summary.overallSuccessRate)}
          hint={summary.totalFailures > 0 ? `${formatInteger(summary.totalFailures)} failed runs` : 'No failed runs'}
        />
        <StatCard
          label="Top tool"
          value={topToolLabel}
          title={topToolLabel}
          hint={summary.usageLeader ? `${formatPercentage(summary.usageLeader.share)} of all runs` : 'Awaiting activity'}
        />
      </div>

      <Card
        title="Calls by day"
        subtitle={`${formatInteger(dailySummary.calls)} calls across ${formatInteger(dailySummary.buckets)} days · select a day to inspect every call`}
        pad={0}
      >
        {dailyLoading && !dailyData ? (
          <div style={{ padding: 16 }}><Skeleton width="100%" height={180} /></div>
        ) : dailyError && !dailyData ? (
          <ErrorState title="Daily tool usage failed to load" message={dailyError} onRetry={requestRefresh} />
        ) : dailyTotals.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="No tool calls in this range"
            description="Adjust the time range or check that the selected source records tool events."
          />
        ) : (
          <DataTable
            columns={dailyTotalColumns}
            rows={dailyTotals}
            rowKey={(row) => row.date}
            onRowClick={(row) => {
              setSelectedCall(null)
              setDayCalls([])
              setDayCallsError(null)
              setFailedCallDetails(0)
              setDayCallsLoading(true)
              setSelectedDay(row)
            }}
            dense
          />
        )}
      </Card>

      {!summary.empty && failureLeaders.length > 0 && (
        <Card title="Most failed" subtitle="Tools with the most failed invocations in this range">
          {failureLeaders.map((row) => (
            <BarRow
              key={`${row.source_id ?? ''}/${row.name}`}
              label={toolLabel(row)}
              value={`${formatInteger(row.failures)} failed`}
              rawValue={row.failures}
              max={failureLeaders[0].failures}
              color="var(--danger)"
              sub={`${formatPercentage(row.successRate)} success over ${formatCompactInteger(row.invocations)} runs`}
            />
          ))}
        </Card>
      )}

      {summary.empty ? (
        <Card>
          <Notice tone="info" title="No tool usage recorded">
            No tool event data was found for this range. Adjust the time range or check that the source provides tool events.
          </Notice>
        </Card>
      ) : (
        <Card
          title="Tool usage"
          subtitle="What your agents call, ranked by volume"
          action={<SearchInput value={filter} onChange={setFilter} placeholder="Filter tools…" label="Filter tools" width={220} />}
          pad={0}
        >
          {visibleRows.length === 0 ? (
            <EmptyState
              icon="search"
              title="No tools match this filter"
              description={`No tool name contains “${filter.trim()}”.`}
              action={<Button size="sm" variant="secondary" onClick={() => setFilter('')}>Clear filter</Button>}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={visibleRows}
              sort={sortSpec}
              onSort={handleSort}
              rowKey={(row) => `${row.source_id ?? ''}/${row.name}`}
            />
          )}
          {distinctSources && (
            <div style={{ padding: '10px 14px', font: '400 12px/1 var(--font-ui)', color: 'var(--fg-faint)' }}>
              Tools aggregated across multiple sources.
            </div>
          )}
        </Card>
      )}

      <Card
        title="Tool breakdown by day"
        subtitle="Aggregated by tool within each date · most recent first"
        action={<SearchInput value={filter} onChange={setFilter} placeholder="Filter tools…" label="Filter daily tools" width={220} />}
        pad={0}
      >
        {dailyLoading && !dailyData ? (
          <div style={{ padding: 16 }}><Skeleton width="100%" height={220} /></div>
        ) : dailyError && !dailyData ? (
          <ErrorState title="Daily tool usage failed to load" message={dailyError} onRetry={requestRefresh} />
        ) : dailyRows.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="No daily tool calls in this range"
            description="Adjust the time range or check that the selected source records tool events."
          />
        ) : visibleDailyRows.length === 0 ? (
          <EmptyState
            icon="search"
            title="No daily calls match this filter"
            description={`No tool name contains “${filter.trim()}”.`}
            action={<Button size="sm" variant="secondary" onClick={() => setFilter('')}>Clear filter</Button>}
          />
        ) : (
          <DataTable
            columns={dailyColumns}
            rows={visibleDailyRows}
            rowKey={(row) => `${row.sourceId ?? ''}/${row.date}/${row.name}`}
            dense
          />
        )}
      </Card>

      <ToolCallsDrawer
        day={selectedDay}
        calls={dayCalls}
        loading={dayCallsLoading}
        error={dayCallsError}
        failedDetails={failedCallDetails}
        selectedCall={selectedCall}
        onSelectCall={setSelectedCall}
        onBack={() => setSelectedCall(null)}
        onRetry={() => {
          setSelectedCall(null)
          setDayCalls([])
          setDayCallsError(null)
          setFailedCallDetails(0)
          setDayCallsLoading(true)
          setDayCallsNonce((nonce) => nonce + 1)
        }}
        onClose={() => {
          setSelectedCall(null)
          setDayCalls([])
          setDayCallsError(null)
          setFailedCallDetails(0)
          setDayCallsLoading(false)
          setSelectedDay(null)
        }}
      />
    </div>
  )
}

function toolStatusTone(status: string) {
  switch (status) {
    case 'completed': return 'success' as const
    case 'error': return 'danger' as const
    case 'running': return 'accent' as const
    case 'pending': return 'warning' as const
    default: return 'neutral' as const
  }
}

interface ToolCallsDrawerProps {
  day: DailyToolTotalRow | null
  calls: ToolCallRow[]
  loading: boolean
  error: string | null
  failedDetails: number
  selectedCall: ToolCallRow | null
  onSelectCall: (call: ToolCallRow) => void
  onBack: () => void
  onRetry: () => void
  onClose: () => void
}

function ToolCallsDrawer({
  day,
  calls,
  loading,
  error,
  failedDetails,
  selectedCall,
  onSelectCall,
  onBack,
  onRetry,
  onClose,
}: ToolCallsDrawerProps) {
  const columns: Column<ToolCallRow>[] = useMemo(() => [
    {
      key: 'time',
      header: 'Time',
      width: 150,
      render: (row) => <span style={{ font: '500 11px/1 var(--font-mono)', color: 'var(--fg-secondary)' }}>{formatDateTime(row.timeCreated)}</span>,
    },
    {
      key: 'tool',
      header: 'Tool',
      wrap: true,
      render: (row) => (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ font: '600 12px/1.2 var(--font-mono)', color: 'var(--fg-primary)' }}>{row.tool}</span>
          {row.summary && <span style={{ font: '400 11px/1.3 var(--font-ui)', color: 'var(--fg-faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.summary}</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 110,
      render: (row) => <Badge tone={toolStatusTone(row.status)}>{row.status}</Badge>,
    },
    {
      key: 'session',
      header: 'Session',
      wrap: true,
      width: 190,
      render: (row) => (
        <span title={row.sessionId} style={{ font: '400 11px/1.3 var(--font-ui)', color: 'var(--fg-secondary)' }}>
          {row.sessionTitle || row.sessionId.slice(0, 16)}
        </span>
      ),
    },
  ], [])

  const state = selectedCall?.part.state
  const duration = state?.time?.start && state.time.end && state.time.end >= state.time.start
    ? `${((state.time.end - state.time.start) / 1000).toFixed(2)}s`
    : null

  return (
    <Drawer
      open={day !== null}
      onClose={onClose}
      width={820}
      title={selectedCall ? selectedCall.tool : day ? `Tool calls · ${formatShortDate(day.date)}` : 'Tool calls'}
      subtitle={selectedCall ? `Call ${selectedCall.part.call_id || selectedCall.key}` : day ? `${formatInteger(day.calls)} recorded calls` : undefined}
    >
      {selectedCall ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><Button size="sm" variant="secondary" onClick={onBack}>← Back to day</Button></div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Badge tone={toolStatusTone(selectedCall.status)}>{selectedCall.status}</Badge>
            <Badge>{selectedCall.sessionTitle || 'Untitled session'}</Badge>
            {duration && <Badge>{duration}</Badge>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <CallFact label="Recorded at" value={formatDateTime(selectedCall.timeCreated)} />
            <CallFact label="Message" value={selectedCall.messageId} />
            <CallFact label="Session" value={selectedCall.sessionId} />
          </div>

          {state?.title && <PayloadBlock title="Title" value={state.title} />}
          {state?.input && Object.keys(state.input).length > 0 && <PayloadBlock title="Input" value={state.input} json />}
          {state?.output && <PayloadBlock title="Output" value={state.output} />}
          {state?.error && <PayloadBlock title="Error" value={state.error} danger />}
          {state?.metadata && Object.keys(state.metadata).length > 0 && <PayloadBlock title="Metadata" value={state.metadata} json />}
          {state?.truncation?.truncated && (
            <Notice tone="warning" title="Payload truncated">
              Large tool content is shortened by the dashboard detail API before it reaches this view.
            </Notice>
          )}
        </div>
      ) : loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton width="45%" height={20} />
          <Skeleton width="100%" height={260} />
        </div>
      ) : error ? (
        <ErrorState title="Tool calls failed to load" message={error} onRetry={onRetry} />
      ) : calls.length === 0 ? (
        <EmptyState icon="wrench" title="No call details found" description="The daily aggregate exists, but this source returned no message-level tool parts for the selected date." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {day && (calls.length !== day.calls || failedDetails > 0) && (
            <Notice tone="warning" title="Call detail is incomplete">
              Loaded {formatInteger(calls.length)} of {formatInteger(day.calls)} aggregated calls.
              {failedDetails > 0 ? ` ${formatInteger(failedDetails)} message details could not be read.` : ''}
            </Notice>
          )}
          <DataTable columns={columns} rows={calls} rowKey={(row) => row.key} onRowClick={onSelectCall} dense />
        </div>
      )}
    </Drawer>
  )
}

function CallFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--ink-850)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '10px 12px', minWidth: 0 }}>
      <div style={{ font: '600 10px/1 var(--font-ui)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{label}</div>
      <div title={value} style={{ marginTop: 6, font: '500 11px/1.4 var(--font-mono)', color: 'var(--fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

function PayloadBlock({ title, value, json = false, danger = false }: { title: string; value: unknown; json?: boolean; danger?: boolean }) {
  const content = json ? JSON.stringify(value, null, 2) : String(value)
  return (
    <Card title={title} pad={14}>
      <pre style={{ margin: 0, font: '400 11px/1.55 var(--font-mono)', color: danger ? 'var(--danger)' : 'var(--fg-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto' }}>
        {content}
      </pre>
    </Card>
  )
}
