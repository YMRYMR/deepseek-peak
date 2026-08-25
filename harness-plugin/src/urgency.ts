/**
 * Explainable, zero-token urgency classification for peak-hour admission.
 *
 * The classifier deliberately avoids an LLM call: paying peak rates merely to
 * decide whether to avoid peak rates defeats the purpose of the gate. Exact
 * user overrides win, then configured keywords, incident/deadline signals,
 * routine-work signals, and finally the configured unknown-task policy.
 */

/** What the peak-hour gate should do with one model request. */
export type UrgencyDecision = 'run' | 'defer'

/** Which rule family produced a decision. */
export type UrgencySource =
  | 'explicit'
  | 'configured-keyword'
  | 'incident'
  | 'deadline'
  | 'routine'
  | 'default'

/** One explainable admission decision. */
export interface UrgencyResult {
  readonly decision: UrgencyDecision
  readonly source: UrgencySource
  readonly reason: string
  readonly matched?: string
}

/** User-configurable parts of the classifier. */
export interface UrgencyPolicy {
  readonly unknownTaskPolicy: UrgencyDecision
  readonly urgentKeywords: readonly string[]
  readonly deferKeywords: readonly string[]
}

/** Conservative defaults: save money unless a task carries urgency evidence. */
export const DEFAULT_URGENCY_POLICY: UrgencyPolicy = {
  unknownTaskPolicy: 'defer',
  urgentKeywords: [],
  deferKeywords: [],
}

const EXPLICIT_RUN = /(?:\[(?:urgent|紧急)\]|！紧急|(?:^|\s)(?:!urgent|\/urgent|#urgent)(?=\s|$|[，。,:：]))/iu
const EXPLICIT_DEFER = /(?:\[(?:defer|延后)\]|！延后|(?:^|\s)(?:!defer|\/defer|#defer)(?=\s|$|[，。,:：]))/iu

const NOT_URGENT = /(?:并?不(?:是)?|非|无需|不用|不要)\s*(?:太|很|那么|特别)?\s*(?:紧急|着急|马上|立即|立刻)|not\s+urgent|no\s+rush|whenever\s+you\s+can/iu
const INCIDENT = /生产(?:环境)?(?:故障|事故|异常)|线上(?:故障|事故|宕机|中断)|服务(?:宕机|中断)|数据(?:丢失|泄露)|安全(?:事故|漏洞)|告警|报警|火警|事故响应|紧急|火速|马上|立即|立刻|尽快|urgent|asap|sev[ -]?[01]|p[ -]?0|outage|incident|prod(?:uction)?\s+(?:is\s+)?down|data\s+(?:loss|leak)|security\s+(?:incident|breach)|hotfix/iu
const SHORT_DEADLINE = /(?:\d+|一|两|二|三|几|半)(?:\s*)(?:分钟|小时)内|今天(?:上午|中午|下午|晚上)?[^。！？\n]{0,16}(?:前|之前|截止)|(?:within|in)\s+(?:an?\s+|\d+\s*)?(?:minutes?|hours?)\b|(?:before|by)\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/iu
const ROUTINE = /不着急|不急|可以晚点|稍后|有空(?:再)?|今晚跑|夜间跑|批量|批处理|定时报表|日报|周报|月报|整理|归档|清理|重构|补充文档|文档更新|测试覆盖|no\s+rush|later|overnight|batch|housekeeping|cleanup|refactor|documentation|weekly\s+report|monthly\s+report/iu

function keywordMatch(text: string, keywords: readonly string[]): string | undefined {
  const folded = text.toLocaleLowerCase()
  for (const raw of keywords) {
    const keyword = raw.trim()
    if (keyword.length > 0 && folded.includes(keyword.toLocaleLowerCase())) return keyword
  }
  return undefined
}

function regexMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  return match?.[0]?.trim()
}

/**
 * Classify one human task without network or model calls.
 *
 * @param prompt - Latest human-authored prompt for the active turn.
 * @param policy - User overrides and the fallback for ambiguous requests.
 * @returns Explainable run-now or defer-until-off-peak decision.
 */
export function classifyUrgency(
  prompt: string,
  policy: UrgencyPolicy = DEFAULT_URGENCY_POLICY,
): UrgencyResult {
  const text = prompt.trim()

  const explicitRun = regexMatch(text, EXPLICIT_RUN)
  if (explicitRun !== undefined) {
    return { decision: 'run', source: 'explicit', reason: 'explicit urgent override', matched: explicitRun }
  }
  const explicitDefer = regexMatch(text, EXPLICIT_DEFER)
  if (explicitDefer !== undefined) {
    return { decision: 'defer', source: 'explicit', reason: 'explicit defer override', matched: explicitDefer }
  }

  const noRush = regexMatch(text, NOT_URGENT)
  if (noRush !== undefined) {
    return { decision: 'defer', source: 'routine', reason: 'prompt explicitly says the task is not urgent', matched: noRush }
  }

  const configuredUrgent = keywordMatch(text, policy.urgentKeywords)
  if (configuredUrgent !== undefined) {
    return {
      decision: 'run',
      source: 'configured-keyword',
      reason: 'matched a configured urgent keyword',
      matched: configuredUrgent,
    }
  }
  const configuredDefer = keywordMatch(text, policy.deferKeywords)
  if (configuredDefer !== undefined) {
    return {
      decision: 'defer',
      source: 'configured-keyword',
      reason: 'matched a configured defer keyword',
      matched: configuredDefer,
    }
  }

  const incident = regexMatch(text, INCIDENT)
  if (incident !== undefined) {
    return { decision: 'run', source: 'incident', reason: 'time-critical or production-impact signal', matched: incident }
  }
  const deadline = regexMatch(text, SHORT_DEADLINE)
  if (deadline !== undefined) {
    return { decision: 'run', source: 'deadline', reason: 'short or same-day deadline signal', matched: deadline }
  }
  const routine = regexMatch(text, ROUTINE)
  if (routine !== undefined) {
    return { decision: 'defer', source: 'routine', reason: 'routine or delay-tolerant work signal', matched: routine }
  }

  return {
    decision: policy.unknownTaskPolicy,
    source: 'default',
    reason: policy.unknownTaskPolicy === 'defer'
      ? 'ambiguous task; configured default is to wait for off-peak'
      : 'ambiguous task; configured default is to run now',
  }
}
