import { describe, expect, it, vi } from 'vitest'
import {
  admit, credentialResolver, fetchIssues, issueBody, issuesUrl, pollFailure, resolveToken, sentryKind,
  type SentryConfig,
} from '../src/sources/sentry.ts'

const config = (overrides: Partial<SentryConfig> = {}): SentryConfig =>
  sentryKind.schema.parse({ organization: 'acme', project: 'web', ...overrides })

/** A resolver that answers from a plain record, standing in for the credentials service. */
const fromRecord = (record: Record<string, string | undefined>) => async (name: string) => record[name]

/** One Sentry Issue as the list endpoint returns it. */
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: '1001', shortId: 'ACME-1', title: 'TypeError: x is undefined', level: 'error',
  count: '7', userCount: 4, firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z',
  culprit: 'app/page.tsx in Home', permalink: 'https://sentry.io/x/1001/',
  metadata: { type: 'TypeError', value: 'x is undefined' }, ...overrides,
})

/** Feeds raw entries through the Source's own fetch so the schema is exercised, not bypassed. */
const parse = async (entries: unknown[], overrides: Partial<SentryConfig> = {}) => {
  const response = { ok: true, json: async () => entries, text: async () => '' } as unknown as Response
  return fetchIssues(config(overrides), 't', undefined, new AbortController().signal, async () => response)
}

/** One parsed Issue, for the helpers that take the normalized shape. */
const one = async (overrides: Record<string, unknown> = {}) => (await parse([raw(overrides)]))[0]!

describe('sentry source: configuration', () => {
  it('stores the token variable name rather than a token', () => {
    // A token in settings would be persisted in the state database and shown in the
    // panel. The schema holds only the variable name; the resolver reads the value.
    const parsed = config()
    expect(parsed.tokenEnv).toBe('SENTRY_AUTH_TOKEN')
    expect(Object.keys(parsed)).not.toContain('token')
  })

  it('reads the token through the credential resolver, not the process environment', async () => {
    // DSH resolves credentials from its store first and the launch environment second,
    // and the environment layer is a snapshot taken at launch. A token saved to
    // .credentials.yaml therefore never appears in process.env, so reading env directly
    // would miss the normal way a user configures one.
    const resolved: string[] = []
    const token = await resolveToken(config(), async name => {
      resolved.push(name)
      return '  from-store  '
    })
    expect(token).toBe('from-store')
    expect(resolved).toEqual(['SENTRY_AUTH_TOKEN'])
  })

  it('falls back to the process environment only when the store has no value', async () => {
    process.env.SENTRY_RESOLVER_TEST = 'from-env'
    try {
      const resolver = credentialResolver(undefined)
      expect(await resolver('SENTRY_RESOLVER_TEST')).toBe('from-env')
      expect(await resolver('SENTRY_NOT_SET_ANYWHERE')).toBeUndefined()
    } finally {
      delete process.env.SENTRY_RESOLVER_TEST
    }
  })

  it('prefers the credential store over the environment when both answer', async () => {
    process.env.SENTRY_PRECEDENCE_TEST = 'from-env'
    try {
      const service = { resolve: async () => ({ value: 'from-store' }) }
      const resolver = credentialResolver(service)
      expect(await resolver('SENTRY_PRECEDENCE_TEST')).toBe('from-store')
      // An empty stored value counts as absent, so the environment applies again.
      const blank = credentialResolver({ resolve: async () => ({ value: '   ' }) })
      expect(await blank('SENTRY_PRECEDENCE_TEST')).toBe('from-env')
    } finally {
      delete process.env.SENTRY_PRECEDENCE_TEST
    }
  })

  it('refuses to poll without a token instead of reporting an empty result', async () => {
    // A missing token must look like an error. Returning no Issues would look like a
    // healthy project with nothing to report.
    await expect(resolveToken(config(), fromRecord({}))).rejects.toThrow(/SENTRY_AUTH_TOKEN/)
    await expect(resolveToken(config(), fromRecord({ SENTRY_AUTH_TOKEN: '   ' }))).rejects.toThrow(/SENTRY_AUTH_TOKEN/)
    // The error has to say where to put it, because this is the first thing an operator hits.
    await expect(resolveToken(config(), fromRecord({}))).rejects.toThrow(/credentials store/)
  })

  it('defaults to receiving nothing until an organization and project are set', () => {
    // The safe default is an inert Source: a half-configured one must not poll.
    const parsed = sentryKind.schema.parse({})
    expect(parsed.organization).toBe('')
    expect(parsed.project).toBe('')
    expect(parsed.pollSeconds).toBeGreaterThanOrEqual(60)
    expect(parsed.minUsers).toBeGreaterThan(1)
  })

  it('declares its own health entry and produces no Triggers', () => {
    // It mirrors into GitHub; the GitHub Source owns the Trigger. A `scope` or
    // `channel` here would mean this Source claims conversations it cannot answer.
    expect(sentryKind.health).toEqual(['sentry'])
    expect(sentryKind.scope).toBeUndefined()
    expect(sentryKind.channel).toBeUndefined()
    expect(sentryKind.policy).toBeUndefined()
  })
})

describe('sentry source: admission', () => {
  const base = config({ minUsers: 2, minEvents: 10 })

  it('admits an unhandled error that affects several users', async () => {
    expect(admit(await one(), base)).toBe(true)
  })

  it('admits a repeated back-end failure that affects only one user', async () => {
    // Verified against the real projects: a Worker failure that runs 1,251 times
    // reports userCount 1, and a user floor alone would reject it while admitting the
    // genuine transient next to it. Event count is what separates the two.
    const repeated = await one({ userCount: 1, count: '1251', title: 'Error: SCHEDULED_JOBS_FAILED:1' })
    expect(admit(repeated, base)).toBe(true)
  })

  it('rejects a one-off back-end failure as transient noise', async () => {
    const blip = await one({ userCount: 1, count: '1', title: 'Error: D1_ERROR: Network connection lost.' })
    expect(admit(blip, base)).toBe(false)
  })

  it('rejects an exception the application already handled', async () => {
    expect(admit(await one({ tags: [{ key: 'handled', value: 'true' }] }), base)).toBe(false)
  })

  it('rejects a single-user, single-event failure as below the noise floor', async () => {
    expect(admit(await one({ userCount: 1, count: '1' }), base)).toBe(false)
  })

  it('rejects titles matching an ignore pattern, and keeps going past an invalid one', async () => {
    const noise = config({ minUsers: 2, minEvents: 10, ignore: 'NetworkError\nFailed to fetch' })
    const real = config({ minUsers: 2, minEvents: 10, ignore: '[' })
    const network = await one({ userCount: 9, count: '99', metadata: { type: 'NetworkError', value: 'Failed to fetch' } })
    expect(admit(network, noise)).toBe(false)
    // An operator's typo in one pattern must not turn the whole Source off.
    const genuine = await one({ userCount: 9, count: '99', title: 'DatabaseError', metadata: { type: 'DatabaseError' } })
    expect(admit(genuine, real)).toBe(true)
  })
})

describe('sentry source: the request it makes', () => {
  it('asks only for unresolved, unhandled issues, bounded by the cursor', () => {
    const url = new URL(issuesUrl(config(), '2026-01-02T00:00:00Z'))
    // The filter belongs in the query so the same expression is visible in the panel.
    expect(url.searchParams.get('query')).toContain('is:unresolved')
    expect(url.searchParams.get('query')).toContain('!tags[handled]:true')
    expect(url.searchParams.get('query')).toContain('lastSeen:>2026-01-02T00:00:00Z')
    expect(url.pathname).toBe('/api/0/projects/acme/web/issues/')
  })

  it('omits the cursor on the first poll', () => {
    expect(new URL(issuesUrl(config(), undefined)).searchParams.get('query')).not.toContain('lastSeen')
  })

  it('reports an HTTP failure rather than returning no issues', async () => {
    const response = { ok: false, status: 403, text: async () => 'nope' } as unknown as Response
    await expect(fetchIssues(config(), 't', undefined, new AbortController().signal, async () => response))
      .rejects.toThrow(/403/)
  })

  it('sends the token as a bearer credential and never in the URL', async () => {
    const token = 'sntrys_DISTINCTIVE_VALUE'
    const url = issuesUrl(config(), undefined)
    // A secret in a query string ends up in access logs and proxy history.
    expect(url).not.toContain(token)
    const seen: Record<string, string> = {}
    const spy = (async (_url: string, init: RequestInit) => {
      Object.assign(seen, init.headers as Record<string, string>)
      return { ok: true, json: async () => [], text: async () => '' } as unknown as Response
    }) as unknown as typeof fetch
    await fetchIssues(config(), token, undefined, new AbortController().signal, spy)
    expect(seen['authorization']).toBe(`Bearer ${token}`)
  })

  it('skips entries it cannot read instead of failing the poll', async () => {
    // One malformed entry must not stop the Issues after it from being mirrored.
    const parsed = await parse([{ nonsense: true }, raw()])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.id).toBe('1001')
  })
})

describe('sentry source: the Issue it opens', () => {
  it('carries the reproduction facts and the Sentry link, with no secrets', async () => {
    const body = issueBody(await one())
    expect(body).toContain('ACME-1')
    expect(body).toContain('TypeError')
    expect(body).toContain('https://sentry.io/x/1001/')
    expect(body).toContain('| users | 4 |')
    // The token must never reach GitHub through the body.
    expect(body).not.toMatch(/Bearer|authorization/i)
  })

  it('says the stack trace is authoritative on Sentry rather than implying the body is complete', async () => {
    expect(issueBody(await one())).toMatch(/stack trace and breadcrumbs are on/)
  })
})

describe('sentry source: health', () => {
  it('stays quiet through a single failed poll and reports after the threshold', () => {
    expect(pollFailure(1, 3, new Error('boom'))).toBeUndefined()
    expect(pollFailure(2, 3, new Error('boom'))).toBeUndefined()
    expect(pollFailure(3, 3, new Error('boom'))).toMatchObject({ state: 'error' })
    expect(pollFailure(3, 3, new Error('boom'))!.detail).toContain('boom')
  })
})

describe('sentry source: plugin entry', () => {
  it('injects the orchestrator, registers the kind, and reports source-off while unconfigured', async () => {
    const { inject, apply, name } = await import('../src/sources/sentry.ts')
    expect(inject).toEqual(['orchestrator'])
    expect(name).toBe('dsh-superagent-sentry')

    const register = vi.fn(() => () => {})
    const report = vi.fn()
    const orchestrator = {
      sources: { register },
      // `sourceContext` reaches the host through `orchestrator.context`.
      context: () => ({ report, ready: Promise.resolve(), configured: () => false, config: () => undefined }),
    }
    const effect = vi.fn((run: () => unknown) => { run(); return () => {} })
    // The credentials service is looked up by name, so a composition without one must
    // still load: `get` returning undefined is the normal case for a bare profile.
    const get = vi.fn(() => undefined)
    apply({ orchestrator, effect, get } as never)
    expect(register).toHaveBeenCalledWith(sentryKind)
    expect(get).toHaveBeenCalledWith('credentials')

    // The polling loop must report why it is idle rather than looking healthy.
    await vi.waitFor(() => expect(report).toHaveBeenCalled())
    expect(report.mock.calls[0]![0]).toBe('sentry')
    expect(report.mock.calls[0]![1]).toMatchObject({ state: 'paused' })
  })

  it('keeps the schema strict so a typo is refused rather than silently ignored', () => {
    expect(() => sentryKind.schema.parse({ organizaton: 'typo' })).toThrow()
  })
})
