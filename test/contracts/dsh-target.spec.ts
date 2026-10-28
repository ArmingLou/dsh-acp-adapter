import { describe, expect, it } from 'vitest'
import {
  DSH_COMPAT_RANGE,
  DSH_ENGINE_RANGE,
  DSH_SOURCE_TAG,
  DSH_SOURCE_VERSION,
  engineRangeAdmits,
} from '../../scripts/dsh-target.ts'

describe('宿主目标与兼容声明', () => {
  it('精确开发目标来自固定的 @deepseek-ai/dsh 开发依赖，并派生源码标签', () => {
    expect(DSH_SOURCE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(DSH_SOURCE_TAG).toBe(`dsh-v${DSH_SOURCE_VERSION}`)
    expect(DSH_COMPAT_RANGE).toBe(DSH_SOURCE_VERSION)
  })

  it('engines.dsh 的兼容声明必须接纳精确开发目标', () => {
    expect(engineRangeAdmits(DSH_ENGINE_RANGE, DSH_SOURCE_VERSION)).toBe(true)
  })

  it('比较链按 SemVer 优先级判定，无法解释的范围语法一律不接纳', () => {
    expect(engineRangeAdmits('0.2.1-rc.4', '0.2.1-rc.4')).toBe(true)
    expect(engineRangeAdmits('=0.2.1-rc.4', '0.2.1-rc.4')).toBe(true)
    expect(engineRangeAdmits('>=0.2.1-rc.3', '0.2.1-rc.4')).toBe(true)
    expect(engineRangeAdmits('>=0.2.1-rc.5', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('>0.2.1-rc.4', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('>=0.2.1-rc.3 <0.3.0', '0.2.1-rc.4')).toBe(true)
    expect(engineRangeAdmits('>=0.2.1-rc.3 <0.2.1', '0.2.1-rc.4')).toBe(true)
    expect(engineRangeAdmits('>=0.2.1', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('^0.2.1', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('~0.2.1', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('*', '0.2.1-rc.4')).toBe(false)
    expect(engineRangeAdmits('>=0.2.1-rc.3 || >=0.3.0', '0.2.1-rc.4')).toBe(false)
  })

  it('正式版高于同核心的预发布，预发布标识按序号比较', () => {
    expect(engineRangeAdmits('>=0.2.1-rc.10', '0.2.1-rc.9')).toBe(false)
    expect(engineRangeAdmits('>=0.2.1-rc.9', '0.2.1-rc.10')).toBe(true)
    expect(engineRangeAdmits('>0.2.1-rc.4', '0.2.1')).toBe(true)
  })

  it('预发布目标只在同核心比较器带预发布时匹配，与宿主 satisfies 判定一致', () => {
    expect(engineRangeAdmits('>=0.2.1-rc.3', '0.2.2-rc.1')).toBe(false)
    expect(engineRangeAdmits('>=0.2.1-rc.3', '0.2.2')).toBe(true)
    expect(engineRangeAdmits('>=0.2.1-rc.3', '0.3.0')).toBe(true)
  })
})
