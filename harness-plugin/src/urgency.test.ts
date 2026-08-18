import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyUrgency } from './urgency.ts'

describe('classifyUrgency', () => {
  it('honors exact urgent and defer overrides', () => {
    assert.equal(classifyUrgency('!urgent deploy the hotfix').decision, 'run')
    assert.equal(classifyUrgency('[延后]整理这批文件').decision, 'defer')
  })

  it('does not mistake a negated urgency phrase for an incident', () => {
    const result = classifyUrgency('这个不紧急，晚点重构就行')
    assert.equal(result.decision, 'defer')
    assert.equal(result.source, 'routine')
    assert.equal(classifyUrgency('这并不是很紧急，明天再做').decision, 'defer')
  })

  it('runs production incidents and short deadlines immediately', () => {
    assert.equal(classifyUrgency('线上服务宕机，马上排查').decision, 'run')
    assert.equal(classifyUrgency('Please finish within 2 hours').source, 'deadline')
    assert.equal(classifyUrgency('今天下午六点前修好').decision, 'run')
  })

  it('defers routine batch work', () => {
    const result = classifyUrgency('今晚跑一遍批处理并整理周报')
    assert.equal(result.decision, 'defer')
    assert.equal(result.source, 'routine')
  })

  it('uses configured keywords before built-in signals', () => {
    assert.equal(classifyUrgency('客户演示环境坏了', {
      unknownTaskPolicy: 'defer',
      urgentKeywords: ['客户演示'],
      deferKeywords: [],
    }).decision, 'run')
  })

  it('makes the ambiguous-task fallback configurable', () => {
    assert.equal(classifyUrgency('实现一个新的搜索页面').decision, 'defer')
    assert.equal(classifyUrgency('实现一个新的搜索页面', {
      unknownTaskPolicy: 'run',
      urgentKeywords: [],
      deferKeywords: [],
    }).decision, 'run')
  })
})
