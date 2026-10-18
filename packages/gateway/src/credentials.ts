/**
 * `credentials` capability over the upstream `credentialsController`.
 *
 * Persistence, precedence (launch environment > stored file > .env files) and
 * the reference grammar all stay upstream; values flow client → host only and
 * no method or notification ever carries one back.
 */
import type { CredentialsController } from '@deepseek-ai/dsh-api-settings-controller'
import type { RequestParams } from '@adg/protocol'
import type { CapabilityRegistration } from './registry.ts'

export type HostCredentials = Pick<CredentialsController, 'describe' | 'set' | 'unset'>

export function credentialsCapability(credentials: HostCredentials): CapabilityRegistration {
  return {
    id: 'credentials',
    version: 1,
    methods: {
      'credentials/describe': async params => {
        const { refs } = params as RequestParams<'credentials/describe'>
        const described = await credentials.describe([...refs])
        const items = Object.fromEntries(Object.entries(described).map(([ref, info]) => [ref, {
          configured: info.configured,
          writable: info.writable,
          ...(info.source === undefined ? {} : { source: info.source }),
        }]))
        return { items }
      },
      'credentials/set': async params => {
        const { ref, value } = params as RequestParams<'credentials/set'>
        await credentials.set(ref, value.trim())
        return {}
      },
      'credentials/unset': async params => {
        const { ref } = params as RequestParams<'credentials/unset'>
        await credentials.unset(ref)
        return {}
      },
    },
  }
}
