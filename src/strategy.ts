import type { DispatchStrategy } from './config'

export interface DispatchState {
  nextPollIndex: number
}

export function createDispatchState(): DispatchState {
  return {
    nextPollIndex: 0,
  }
}

function hashString(value: string): number {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

export function selectAgentproxyIndex(
  strategy: DispatchStrategy,
  poolLength: number,
  targetSite: string,
  authorization: string | undefined,
  state: DispatchState,
): number {
  if (poolLength <= 0) {
    throw new RangeError('poolLength 必须大于 0')
  }

  if (strategy === 'poll') {
    const index = state.nextPollIndex % poolLength

    state.nextPollIndex = (index + 1) % poolLength

    return index
  }

  const hashKey = `${targetSite}\n${authorization ?? ''}`

  return hashString(hashKey) % poolLength
}
