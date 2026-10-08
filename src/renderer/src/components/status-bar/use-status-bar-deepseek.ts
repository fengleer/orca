import { useCallback } from 'react'
import { useDeepSeekAccount } from '@/hooks/useDeepSeekAccount'
import { getDeepSeekAccountScope } from '@/runtime/deepseek-account-scope'
import { refreshDeepSeekAccount } from '@/runtime/deepseek-account-client'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '../../store'
import type { DeepSeekAccountStatus } from '../../../../shared/deepseek-balance'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

/**
 * Why this is its own hook: it owns one provider's account plumbing (scope → host → credentials),
 * and the status-bar controller is already at the repo's file-size budget.
 */
export function useStatusBarDeepSeekAccount(): {
  account: DeepSeekAccountStatus | null
  limits: ProviderRateLimits | null
  refresh: () => Promise<void>
} {
  const settings = useAppStore((s) => s.settings)
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const scope = getDeepSeekAccountScope(settings, activeWorkspaceHostId, getRendererAppPlatform())
  const { account, limits } = useDeepSeekAccount(scope.environmentId, scope.unsupported)
  const refresh = useCallback(async () => {
    if (account?.supported && account.ownerId && scope.environmentId) {
      await refreshDeepSeekAccount(
        { kind: 'environment', environmentId: scope.environmentId },
        account.ownerId
      )
    }
  }, [account, scope.environmentId])
  return { account, limits, refresh }
}
