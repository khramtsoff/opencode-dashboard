import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyToolRows } from './daily-tools.ts'
import type { DimensionDayStats } from '../types/api.ts'

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
