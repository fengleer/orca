import type { DeepSeekCredentials } from '../../deepseek/deepseek-credentials'
import { resolveDeepSeekFallbackApiKey } from '../../deepseek/deepseek-api-key-source'
import { DeepSeekDailySpendReader } from '../../deepseek/deepseek-daily-spend'
import { unsupportedDeepSeekAccount } from '../../../shared/deepseek-balance'
import type { DeepSeekDailySpend } from '../../../shared/deepseek-balance'
import { deepSeekBalanceFailure, fetchDeepSeekBalance } from '../deepseek-fetcher'
import { RateLimitServiceFetchPolicy } from './service-fetch-policy'
import type { ProviderRateLimits, RateLimitState } from './service-types'

export abstract class RateLimitServiceDeepSeekBalance extends RateLimitServiceFetchPolicy {
  protected deepseekCredentials: DeepSeekCredentials | null = null
  private deepseekGeneration = 0
  private deepseekFetch: Promise<RateLimitState> | null = null
  private deepseekRevision: string | null | undefined
  private deepseekDailySpendReader: DeepSeekDailySpendReader | null = null

  /** Overridable so tests can point the spend ledger at a fixture sessions root. */
  protected createDeepSeekDailySpendReader(): DeepSeekDailySpendReader {
    return new DeepSeekDailySpendReader()
  }

  /**
   * Why it never rejects: today's spend is local bookkeeping that must survive a balance
   * fetch failure — the segment shows the cost even while the prepaid balance is stale.
   */
  private async readDeepSeekDailySpend(): Promise<DeepSeekDailySpend | null> {
    this.deepseekDailySpendReader ??= this.createDeepSeekDailySpendReader()
    try {
      return await this.deepseekDailySpendReader.read()
    } catch {
      return null
    }
  }

  setDeepSeekCredentials(credentials: DeepSeekCredentials): void {
    if (this.deepseekCredentials) {
      throw new Error('DeepSeek credential owner is immutable')
    }
    this.deepseekCredentials = credentials
    this.pushToRenderer()
  }

  getDeepSeekAccountStatus(probeProtection = true): ReturnType<DeepSeekCredentials['getStatus']> {
    const status =
      this.deepseekCredentials?.getStatus(probeProtection) ?? unsupportedDeepSeekAccount()
    if (probeProtection) {
      this.pushToRenderer()
    }
    return status
  }

  saveDeepSeekApiKey(
    ownerId: string,
    apiKey: string
  ): ReturnType<DeepSeekCredentials['getStatus']> {
    if (!this.deepseekCredentials) {
      throw new Error('DeepSeek accounts are unsupported on this host')
    }
    const revision = this.deepseekCredentials.revision()
    let saved = false
    try {
      const status = this.deepseekCredentials.save(ownerId, apiKey)
      saved = true
      return status
    } finally {
      // A failed permission restriction can still publish the replacement ciphertext.
      if (saved || revision !== this.deepseekCredentials.revision()) {
        this.invalidateDeepSeekBalance(saved)
      }
    }
  }

  removeDeepSeekApiKey(ownerId: string): ReturnType<DeepSeekCredentials['getStatus']> {
    if (!this.deepseekCredentials) {
      throw new Error('DeepSeek accounts are unsupported on this host')
    }
    const status = this.deepseekCredentials.remove(ownerId)
    this.invalidateDeepSeekBalance()
    return status
  }

  refreshDeepSeekBalance(signal?: AbortSignal): Promise<RateLimitState> {
    if (!this.deepseekFetch) {
      const controller = this.beginFetchCycle()
      const cycleSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      this.deepseekFetch = this.runDeepSeekBalanceCycle(cycleSignal).finally(() => {
        this.finishFetchCycle(controller)
        this.deepseekFetch = null
      })
    }
    return this.deepseekFetch
  }

  private invalidateDeepSeekBalance(refresh = true): void {
    this.deepseekGeneration += 1
    this.updateState({ ...this.state, deepseek: null })
    if (!refresh) {
      return
    }
    const generation = this.deepseekGeneration
    const abortGeneration = this.fetchAbortGeneration
    // A superseded request must finish before the new credential is polled.
    const pending = this.deepseekFetch ?? Promise.resolve()
    void pending
      .then(() => {
        if (
          generation === this.deepseekGeneration &&
          abortGeneration === this.fetchAbortGeneration
        ) {
          return this.refreshDeepSeekBalance()
        }
        return undefined
      })
      .catch(() => undefined)
  }

  private async runDeepSeekBalanceCycle(signal?: AbortSignal): Promise<RateLimitState> {
    if (signal?.aborted) {
      return this.getState()
    }
    const credentials = this.deepseekCredentials
    const generation = this.deepseekGeneration
    const abortGeneration = this.fetchAbortGeneration
    const revision = credentials?.revision()
    const previous = revision === this.deepseekRevision ? this.state.deepseek : null
    if (revision !== this.deepseekRevision) {
      this.deepseekRevision = revision
      this.updateState({ ...this.state, deepseek: null })
    }
    // Why the sealed store wins: when it holds a key, that is the key the user configured
    // in Orca. The env/DSH fallbacks exist for hosts where OS encryption is unavailable.
    const sealedUsable =
      credentials?.getStatus(false).configured === true && credentials.getStatus().supported
    let apiKey: string | null = null
    let credentialError: string | null = null
    if (sealedUsable) {
      try {
        apiKey = credentials.read()
      } catch {
        credentialError = 'DeepSeek API key could not be read from protected storage'
      }
    } else {
      apiKey = resolveDeepSeekFallbackApiKey().apiKey
    }
    // Why the scan waits for a key: with no DeepSeek account on this host there is nothing to
    // account for, and walking the whole harness ledger per cycle is real work — the suite also
    // drives this cycle under fake timers, where an unawaited filesystem walk never settles.
    const dailySpend = apiKey ? await this.readDeepSeekDailySpend() : null
    let fresh: ProviderRateLimits = credentialError
      ? {
          ...deepSeekBalanceFailure(credentialError, 'keychain-unavailable'),
          dailySpend
        }
      : { ...(await fetchDeepSeekBalance(apiKey, signal)), dailySpend }
    if (
      signal?.aborted ||
      generation !== this.deepseekGeneration ||
      abortGeneration !== this.fetchAbortGeneration
    ) {
      return this.getState()
    }
    if (revision !== credentials?.revision()) {
      this.updateState({ ...this.state, deepseek: null })
    } else {
      this.trackActiveFailureStreak('deepseek', fresh)
      const settled = this.applyStalePolicy(fresh, previous)
      // Why: the stale policy keeps a recent balance through transient failures, but today's
      // spend is local bookkeeping and must not ride that cache across a day boundary.
      this.updateState({
        ...this.state,
        deepseek: { ...settled, dailySpend: fresh.dailySpend ?? settled.dailySpend ?? null }
      })
    }
    return this.getState()
  }
}
