/**
 * Sentry Source: polls a Sentry project for new Issues and mirrors each one into a
 * GitHub Issue in the configured repository.
 *
 * Why it mirrors instead of producing Triggers
 * --------------------------------------------
 * dsh-superagent's other Sources produce Triggers and then reply into the original
 * conversation. Sentry is a poor conversation surface — it has no practical comment
 * API for this — so a Trigger whose Channel is Sentry would have nowhere to answer.
 *
 * Mirroring into GitHub keeps every existing piece working unchanged: the GitHub
 * Source already observes new Issues, the Policy's admission table already decides
 * whether they become candidates, and a Ticket's report already lands on the Pull
 * Request. This Source therefore produces no Triggers at all; it only writes the
 * Issue that the GitHub Source then picks up.
 *
 * Deliberate choices
 * ------------------
 * - **Polling, not webhooks.** Sentry's GitHub integration and alert-rule webhooks
 *   sit behind plans we do not have. The REST API does not, and the GitHub Source
 *   already establishes the polling precedent (`pollSeconds`, `failuresBeforeError`).
 *   Nothing about this Source requires a Sentry-side integration.
 * - **The token comes from the environment.** The Source stores the *name* of the
 *   variable to read (`tokenEnv`), not the token. A token pasted into settings would
 *   be persisted in the state database and shown in the panel; this keeps it in the
 *   process environment instead.
 * - **One mirrored Issue per Sentry Issue, ever.** Sentry re-sends the same Issue
 *   until it is resolved, so without a record every poll would open a duplicate. The
 *   Sentry Issue id is remembered in KV before the GitHub call is attempted.
 * - **Admission is deliberately conservative.** Most Sentry issues must never become
 *   work: failed network requests, extensions, and one-off noise would otherwise
 *   produce a stream of Pull Requests nobody wants to review. The filters here are
 *   the safety mechanism, not an optimisation.
 */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { family, record } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'sentry'

/**
 * Records the Sentry Issues already mirrored, and the position of the last poll.
 *
 * `mirrored` is written before the GitHub call so an Issue is never mirrored twice,
 * even if the caller dies between the two writes. `cursor` holds the newest
 * `lastSeen` we observed, which bounds the API query to recent Issues without
 * paginating the whole project on every poll.
 */
const mirrored = family<{ number?: number; at: string }, [issue: string]>('sentry-mirrored:')
const cursor = record<string>('sentry-cursor')

const ConfigSchema = z.object({
  /** Sentry organization slug. */
  organization: z.string().regex(/^[a-z0-9._-]+$/i).default(''),
  /** Sentry project slug. */
  project: z.string().regex(/^[a-z0-9._-]+$/i).default(''),
  /** Name of the environment variable holding the Sentry auth token. */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('SENTRY_AUTH_TOKEN'),
  /** Only mirror Issues with at least this many users affected; 1 disables the check. */
  minUsers: z.number().int().min(1).max(1000).default(2),
  /** Comma-separated labels applied to the created GitHub Issue. */
  labels: z.string().default('sentry'),
  /** Extra Sentry search terms appended to the fixed query. */
  query: z.string().max(500).default(''),
  /** Titles matching any of these JavaScript regular expressions are skipped. */
  ignore: z.string().max(2000).default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(300),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  /** Stop mirroring once this many GitHub Issues were opened, as a runaway guard. */
  maxPerPoll: z.number().int().min(1).max(20).default(3),
}).strict()
export type SentryConfig = z.infer<typeof ConfigSchema>

/** One Sentry Issue as the list endpoint prints it; only the fields mirrored below are read. */
const IssueSchema = z.looseObject({
  id: z.string().min(1),
  shortId: z.string().optional(),
  title: z.string().default(''),
  culprit: z.string().optional(),
  permalink: z.string().optional(),
  level: z.string().optional(),
  count: z.union([z.string(), z.number()]).optional(),
  userCount: z.number().optional(),
  firstSeen: z.string().optional(),
  lastSeen: z.string().optional(),
  metadata: z.looseObject({ type: z.string().optional(), value: z.string().optional() }).optional(),
  tags: z.array(z.looseObject({ key: z.string(), value: z.string() })).optional(),
}).transform(issue => ({
  id: issue.id,
  shortId: issue.shortId ?? issue.id,
  title: issue.title || issue.metadata?.type || 'Sentry issue',
  culprit: issue.culprit,
  permalink: issue.permalink,
  level: issue.level ?? 'error',
  count: Number(issue.count ?? 0),
  userCount: issue.userCount ?? 0,
  firstSeen: issue.firstSeen,
  lastSeen: issue.lastSeen,
  type: issue.metadata?.type,
  value: issue.metadata?.value,
  handled: issue.tags?.find(tag => tag.key === 'handled')?.value,
}))
type SentryIssue = z.infer<typeof IssueSchema>

/** Reads one entry of the keyed config; the panel stores it as either a record or a list of rows. */
function text(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : fallback
}

/** True when the deployment knows which repository to mirror into. */
function hasRepository(ctx: SourceContext): boolean {
  try {
    return !!ctx.commands.repository
  } catch {
    return false
  }
}

/**
 * Whether this Sentry Issue should become GitHub work.
 *
 * Split out from the poll so it can be tested without a network call, and so the
 * reason for skipping is visible in one place: these rules are the difference
 * between a useful agent and one that files Pull Requests for other people's
 * browser extensions.
 */
export function admit(
  issue: SentryIssue,
  config: Pick<SentryConfig, 'minUsers' | 'ignore'>,
): boolean {
  // A handled exception is one the application already reacted to; only unhandled
  // crashes reach here, so an explicit `handled=true` tag means someone swallowed it.
  if (issue.handled === 'true') return false;
  // Below the noise floor: a single user's transient failure is not work.
  if (issue.userCount < config.minUsers) return false;
  const patterns = config.ignore
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(`${issue.title} ${issue.value ?? ''}`)) return false
    } catch {
      // An invalid pattern must not stop mirroring entirely; the operator sees the
      // misconfiguration when the Issue they expected does not appear.
      continue
    }
  }
  return true
}

/** Builds the GitHub Issue body. Reproduction data first: that is what a fix needs. */
export function issueBody(issue: SentryIssue): string {
  const lines = [
    `Mirrored from Sentry: **${issue.shortId}**`,
    '',
    `| field | value |`,
    `| --- | --- |`,
    `| level | \`${issue.level}\` |`,
    `| events | ${issue.count} |`,
    `| users | ${issue.userCount} |`,
    `| first seen | ${issue.firstSeen ?? 'unknown'} |`,
    `| last seen | ${issue.lastSeen ?? 'unknown'} |`,
  ]
  if (issue.culprit) lines.push(`| culprit | \`${issue.culprit}\` |`)
  lines.push('')
  if (issue.type) {
    lines.push('```', issue.type, '```')
    if (issue.value) lines.push('', '```', issue.value, '```')
  }
  if (issue.permalink) lines.push('', `[Open in Sentry](${issue.permalink})`)
  lines.push(
    '',
    '---',
    '',
    'Opened automatically by the Sentry Source. The stack trace and breadcrumbs are on',
    'the Sentry issue; follow the link above before starting, because the trace there is',
    'authoritative and this body intentionally carries only the summary.',
  )
  return lines.join('\n')
}

export const sentryKind: SourceKind<SentryConfig> = {
  kind: SOURCE,
  title: { zh: 'Sentry', en: 'Sentry' },
  description: {
    zh: '轮询一个 Sentry 项目，把新的 Issue 镜像成仓库里的 GitHub Issue，由 GitHub 来源与策略接管。',
    en: 'Polls a Sentry project and mirrors new Issues into GitHub Issues in the repository, which the GitHub Source and Policy then take over.',
  },
  schema: ConfigSchema,
  health: ['sentry'],
  fields: [
    {
      key: 'organization',
      type: 'text',
      pattern: '[A-Za-z0-9._\\-]+',
      label: { zh: 'Sentry 组织 slug', en: 'Sentry organization slug' },
      hint: {
        zh: 'sentry.io 设置里的 organization slug，例如 acme-ab。留空则不轮询。',
        en: 'The organization slug from sentry.io settings, such as acme-ab. Left empty, nothing is polled.',
      },
    },
    {
      key: 'project',
      type: 'text',
      pattern: '[A-Za-z0-9._\\-]+',
      label: { zh: 'Sentry 项目 slug', en: 'Sentry project slug' },
      hint: {
        zh: '项目设置里的 slug，例如 oasisfit-web（不是显示名）。',
        en: 'The slug from project settings, such as oasisfit-web — not the display name.',
      },
    },
    {
      key: 'tokenEnv',
      type: 'text',
      pattern: '[A-Z][A-Z0-9_]*',
      advanced: true,
      label: { zh: '令牌所在的环境变量', en: 'Environment variable holding the token' },
      hint: {
        zh: '只保存变量名，不保存令牌本身。令牌需要 event:read 与 project:read 权限。',
        en: 'Only the variable name is stored, never the token. The token needs event:read and project:read.',
      },
    },
    {
      key: 'minUsers',
      type: 'number',
      min: 1,
      max: 1000,
      label: { zh: '至少影响几名用户才镜像', en: 'Minimum affected users' },
      hint: {
        zh: '单个用户的瞬时错误通常不该变成工作。置为 1 关闭此过滤。',
        en: 'A single user\'s transient failure is usually not work. Set 1 to disable this filter.',
      },
    },
    {
      key: 'labels',
      type: 'text',
      label: { zh: '新建 Issue 的标签', en: 'Labels for the created Issue' },
      hint: {
        zh: '逗号分隔。策略的接收表按标签准入，所以这里要与策略一致。',
        en: 'Comma-separated. The Policy admission table keys on labels, so keep this consistent with it.',
      },
    },
    {
      key: 'ignore',
      type: 'text',
      advanced: true,
      label: { zh: '忽略的标题正则（每行一条）', en: 'Ignored title patterns, one per line' },
      hint: {
        zh: '匹配标题或错误消息时跳过。用于排除网络故障、浏览器扩展、第三方脚本等噪声。',
        en: 'Skips an Issue when its title or message matches. Use it for network noise, extensions, and third-party scripts.',
      },
    },
    {
      key: 'query',
      type: 'text',
      advanced: true,
      label: { zh: '附加的 Sentry 搜索条件', en: 'Additional Sentry search terms' },
      hint: {
        zh: '追加到固定查询之后，例如 `release:latest`。',
        en: 'Appended to the fixed query, for example `release:latest`.',
      },
    },
    {
      key: 'pollSeconds',
      type: 'number',
      min: 60,
      max: 3600,
      advanced: true,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
    },
    {
      key: 'failuresBeforeError',
      type: 'number',
      min: 1,
      max: 20,
      advanced: true,
      label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
    },
    {
      key: 'maxPerPoll',
      type: 'number',
      min: 1,
      max: 20,
      advanced: true,
      label: { zh: '每轮最多新建几个 Issue', en: 'Maximum Issues opened per poll' },
      hint: {
        zh: '防止一次部署后的错误风暴把仓库刷满 Issue。',
        en: 'Stops an error storm after a deployment from flooding the repository.',
      },
    },
  ],
}

export const name = 'dsh-superagent-sentry'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(sentryKind), 'sentry: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, sentryKind)
    const controller = new AbortController()
    // An unhandled rejection terminates the DSH process, so a failure escaping the
    // polling loop is reported as source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report('sentry', { state: 'error', detail: String(error) })
    })
    return async () => {
      controller.abort()
      await running
    }
  })
}

/** Reports `error` once `failures` consecutive polls fail, so one network blip stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): { state: 'error'; detail: string } | undefined {
  return failures >= threshold
    ? { state: 'error', detail: `${failures} consecutive failed polls; last: ${String(error)}` }
    : undefined
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report('sentry', health('paused', 'setupPending'))
    return
  }
  while (!signal.aborted) {
    const config = ctx.config<SentryConfig>(SOURCE)
    try {
      if (config) {
        await pollRound(ctx, config, signal)
        ctx.report('sentry', { state: 'ready', detail: 'polling' })
      } else ctx.report('sentry', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 3, error)
      if (!signal.aborted && failed) ctx.report('sentry', failed)
    }
    await delay(Math.max(config?.pollSeconds ?? 300, 60) * 1000, undefined, { signal }).catch(() => undefined)
  }
}

/** The Sentry token, read from the environment variable the configuration names. */
export function tokenOf(config: SentryConfig, env: Record<string, string | undefined>): string {
  const value = env[config.tokenEnv]?.trim()
  if (!value) throw new Error(`The environment variable ${config.tokenEnv} is not set`)
  return value
}

/** Builds the list URL. `lastSeen` is bounded by the cursor so each poll reads only recent Issues. */
export function issuesUrl(config: SentryConfig, since: string | undefined): string {
  const query = ['is:unresolved', '!tags[handled]:true', config.query.trim()].filter(Boolean).join(' ')
  const params = new URLSearchParams({ query, sort: 'date', limit: '25' })
  // Sentry accepts a `lastSeen` range as part of the query string; keeping it here
  // means the same filter is visible in the panel and in the request.
  if (since) params.set('query', `${query} lastSeen:>${since}`)
  return `https://sentry.io/api/0/projects/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/issues/?${params}`
}

/** Reads recent Sentry Issues; parsing skips entries that do not match the shape. */
export async function fetchIssues(
  config: SentryConfig,
  env: Record<string, string | undefined>,
  since: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SentryIssue[]> {
  const response = await fetchImpl(issuesUrl(config, since), {
    headers: { authorization: `Bearer ${tokenOf(config, env)}`, accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Sentry returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
  const parsed = z.array(z.unknown()).safeParse(await response.json())
  if (!parsed.success) throw new Error('Sentry returned a list this Source cannot read')
  const issues: SentryIssue[] = []
  for (const entry of parsed.data) {
    const issue = IssueSchema.safeParse(entry)
    if (issue.success) issues.push(issue.data)
  }
  return issues
}

/** Mirrors each admitted, not-yet-mirrored Issue, at most `maxPerPoll` of them. */
async function pollRound(ctx: SourceContext, config: SentryConfig, signal: AbortSignal): Promise<void> {
  if (!config.organization || !config.project) return
  if (!hasRepository(ctx)) return
  const since = ctx.state.get(cursor)
  const issues = await fetchIssues(config, process.env, since, signal)
  if (issues.length === 0) return
  const newest = issues.reduce((latest, issue) => {
    const at = issue.lastSeen ?? ''
    return at > latest ? at : latest
  }, since ?? '')
  let opened = 0
  for (const issue of issues) {
    if (signal.aborted) return
    if (opened >= config.maxPerPoll) break
    const key = mirrored(issue.id)
    if (ctx.state.get(key)) continue
    if (!admit(issue, config)) {
      // Recorded so the filter is not re-evaluated (and the Issue not reconsidered)
      // on every poll; clearing the record lets an operator revisit the decision.
      ctx.state.set(key, { at: new Date().toISOString() })
      continue
    }
    // Written before the GitHub call: a crash between the two must not open a
    // second Issue for the same Sentry Issue on the next poll.
    ctx.state.set(key, { at: new Date().toISOString() })
    const fields = ['-f', `title=${issue.title}`.replace(/\n/g, ' '), '-f', `body=${issueBody(issue)}`]
    for (const label of config.labels.split(',').map(value => value.trim()).filter(Boolean)) {
      fields.push('-f', `labels[]=${label}`)
    }
    const created = await ctx.commands.withSignal(signal).gh<{ number?: number }>(['api', `repos/${ctx.commands.repository}/issues`, ...fields])
    if (typeof created.number === 'number') ctx.state.set(key, { number: created.number, at: new Date().toISOString() })
    opened += 1
  }
  if (newest) ctx.state.set(cursor, newest)
}
