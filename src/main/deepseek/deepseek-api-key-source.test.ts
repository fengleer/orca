import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readDeepSeekEnvApiKey,
  readDshCredentialApiKey,
  resolveDeepSeekFallbackApiKey
} from './deepseek-api-key-source'

const dirs: string[] = []

function writeCredentials(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-dsh-credentials-'))
  dirs.push(dir)
  const file = path.join(dir, '.credentials.yaml')
  writeFileSync(file, contents)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('readDeepSeekEnvApiKey', () => {
  it('trims the environment value', () => {
    expect(readDeepSeekEnvApiKey({ DEEPSEEK_API_KEY: '  sk-env  ' })).toBe('sk-env')
  })

  it('treats a blank or missing value as absent', () => {
    expect(readDeepSeekEnvApiKey({ DEEPSEEK_API_KEY: '   ' })).toBeNull()
    expect(readDeepSeekEnvApiKey({})).toBeNull()
  })
})

describe('readDshCredentialApiKey', () => {
  it('reads the key out of the DSH credentials file', () => {
    const file = writeCredentials('version: 1\nrefs:\n  - deepseek\nDEEPSEEK_API_KEY: sk-dsh\n')
    expect(readDshCredentialApiKey(file)).toBe('sk-dsh')
  })

  it('accepts quoted values', () => {
    expect(readDshCredentialApiKey(writeCredentials('DEEPSEEK_API_KEY: "sk-quoted"\n'))).toBe(
      'sk-quoted'
    )
  })

  it('returns null for a missing file or a file without the key', () => {
    expect(readDshCredentialApiKey(path.join(tmpdir(), 'orca-does-not-exist.yaml'))).toBeNull()
    expect(readDshCredentialApiKey(writeCredentials('version: 1\n'))).toBeNull()
  })
})

describe('resolveDeepSeekFallbackApiKey', () => {
  it('prefers the environment over the DSH credentials file', () => {
    const file = writeCredentials('DEEPSEEK_API_KEY: sk-dsh\n')
    expect(
      resolveDeepSeekFallbackApiKey(
        { DEEPSEEK_API_KEY: 'sk-env', ORCA_DEEPSEEK_DSH_CREDENTIALS: '1' },
        { dshCredentialsPath: file }
      )
    ).toEqual({ apiKey: 'sk-env', source: 'env' })
  })

  it('reads the DSH credentials file only when the opt-in is set', () => {
    const file = writeCredentials('DEEPSEEK_API_KEY: sk-dsh\n')
    expect(
      resolveDeepSeekFallbackApiKey({ ORCA_DEEPSEEK_DSH_CREDENTIALS: '1' }, { dshCredentialsPath: file })
    ).toEqual({ apiKey: 'sk-dsh', source: 'dsh-credentials' })
  })

  it('does not treat ambient machine state as Orca configuration', () => {
    // A developer machine with a DSH key must not make the provider look configured.
    expect(resolveDeepSeekFallbackApiKey({})).toEqual({ apiKey: null, source: null })
  })

  it('reports no source when neither source holds a key', () => {
    const file = writeCredentials('version: 1\n')
    expect(
      resolveDeepSeekFallbackApiKey({ ORCA_DEEPSEEK_DSH_CREDENTIALS: '1' }, { dshCredentialsPath: file })
    ).toEqual({ apiKey: null, source: null })
  })
})
