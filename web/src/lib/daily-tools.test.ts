import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyToolRows, buildDailyToolTotals, flattenToolCalls } from './daily-tools.ts'
import type { DimensionDayStats, MessageDetail, ToolPart } from '../types/api.ts'

const zeroTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function toolDay(date: string, name: string, calls: number, sessions = 1): DimensionDayStats {
  return {
    date,
    dimension_key: name,
    sessions,
    messages: calls,
    cost: 0,
    tokens: zeroTokens,
  }
}

test('buildDailyToolRows sorts newest buckets first and tools by call count', () => {
  const rows = buildDailyToolRows([
    toolDay('2026-08-24', 'read', 2),
    toolDay('2026-08-25', 'bash', 3),
    toolDay('2026-08-25', 'read', 7),
  ])

  assert.deepEqual(rows.map((row) => `${row.date}/${row.name}`), [
    '2026-08-25/read',
    '2026-08-25/bash',
    '2026-08-24/read',
  ])
})

test('buildDailyToolRows calculates share within each time bucket', () => {
  const rows = buildDailyToolRows([
    toolDay('2026-08-25', 'read', 3),
    toolDay('2026-08-25', 'bash', 1),
    toolDay('2026-08-24', 'grep', 2),
  ])

  assert.equal(rows.find((row) => row.name === 'read')?.share, 75)
  assert.equal(rows.find((row) => row.name === 'bash')?.share, 25)
  assert.equal(rows.find((row) => row.name === 'grep')?.share, 100)
})

test('buildDailyToolRows ignores blank tool names', () => {
  const rows = buildDailyToolRows([
    toolDay('2026-08-25', 'read', 2),
    toolDay('2026-08-25', '   ', 4),
  ])

  assert.deepEqual(rows.map((row) => row.name), ['read'])
  assert.equal(rows[0]?.share, 100)
})

test('buildDailyToolTotals sums calls and distinct tools per date', () => {
  const rows = buildDailyToolRows([
    toolDay('2026-08-25', 'read', 3),
    toolDay('2026-08-25', 'bash', 2),
    toolDay('2026-08-24', 'read', 4),
  ])

  assert.deepEqual(buildDailyToolTotals(rows), [
    { date: '2026-08-25', calls: 5, tools: 2 },
    { date: '2026-08-24', calls: 4, tools: 1 },
  ])
})

function messageDetail(id: string, timeCreated: string, parts: ToolPart[]): MessageDetail {
  return {
    id,
    session_id: `session-${id}`,
    session_title: `Session ${id}`,
    role: 'assistant',
    time_created: timeCreated,
    cost: 0,
    content: { text_parts: [], reasoning_parts: [], tool_parts: parts },
  }
}

test('flattenToolCalls creates individually selectable calls and prefers tool time', () => {
  const calls = flattenToolCalls([
    messageDetail('message-1', '2026-08-25T09:00:00Z', [
      {
        type: 'tool',
        call_id: 'call-read',
        tool: 'read',
        state: { status: 'completed', title: 'Read source', time: { start: Date.parse('2026-08-25T09:05:00Z') } },
      },
      {
        type: 'tool',
        call_id: 'call-bash',
        tool: 'bash',
        state: { status: 'error', error: 'command failed' },
      },
    ]),
  ])

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.tool, 'read')
  assert.equal(calls[0]?.timeCreated, '2026-08-25T09:05:00.000Z')
  assert.equal(calls[1]?.summary, 'command failed')
  assert.equal(calls[1]?.key, 'message-1/call-bash')
})
