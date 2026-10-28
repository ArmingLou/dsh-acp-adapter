import { readFileSync } from 'node:fs'

/**
 * package.json 把两件事分开声明：
 *
 * - `engines.dsh` 面向宿主与消费者，声明兼容范围（可以写成 `>=0.2.1-rc.3` 这样的比较链）。
 * - `devDependencies["@deepseek-ai/dsh"]` 是唯一精确开发目标，源码标签、生成物版本和安装门禁都派生自它。
 *
 * 范围无法派生标签或精确版本比对，所以精确目标只能来自固定依赖；两者的关系由下面的校验保证不漂移。
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines?: { dsh?: string }
  devDependencies?: Record<string, string>
}

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

interface ParsedVersion {
  parts: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = EXACT_VERSION.exec(value)
  if (match === null) return undefined
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** SemVer 2.0.0 优先级：核心版本逐段比较，预发布低于同核心的正式版，标识段缺省者更小。 */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const index of [0, 1, 2] as const) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] < right.parts[index] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  for (const index of left.prerelease.keys()) {
    const a = left.prerelease[index] as string | undefined
    const b = right.prerelease[index] as string | undefined
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

/**
 * 判断宿主兼容声明是否接纳给定版本。只接受精确版本或空格分隔的比较链
 * （`>=`/`>`/`<=`/`<`/`=`）；`^`、`~`、`||`、`*` 一律视为不支持并直接判否，
 * 避免用范围语法把固定目标悄悄排除在外。
 *
 * 预发布目标沿用 SemVer 的「预发布只在同核心版本比较器出现时才匹配」规则，
 * 与宿主 `dsh-app-boot` 的 `satisfies(runtimeVersion, engines.dsh)` 判定一致：
 * `>=0.2.1-rc.3` 接纳 `0.2.1-rc.4`，但不接纳 `0.2.2-rc.1`。
 */
export function engineRangeAdmits(range: string, version: string): boolean {
  const target = parseVersion(version)
  if (target === undefined) return false
  const tokens = range.trim().split(/\s+/)
  if (range.trim() === '' || tokens.length === 0) return false
  const comparators: { operator: string; bound: ParsedVersion }[] = []
  for (const token of tokens) {
    const match = COMPARATOR.exec(token)
    if (match === null) return false
    const bound = parseVersion(match[2] as string)
    if (bound === undefined) return false
    comparators.push({ operator: match[1] ?? '=', bound })
  }
  const satisfied = comparators.every(({ operator, bound }) => {
    const order = compareVersions(target, bound)
    switch (operator) {
      case '>=':
        return order >= 0
      case '>':
        return order > 0
      case '<=':
        return order <= 0
      case '<':
        return order < 0
      default:
        return order === 0
    }
  })
  if (!satisfied) return false
  if (target.prerelease.length === 0) return true
  return comparators.some(
    ({ bound }) =>
      bound.prerelease.length > 0 &&
      bound.parts[0] === target.parts[0] &&
      bound.parts[1] === target.parts[1] &&
      bound.parts[2] === target.parts[2],
  )
}

/** 固定的精确宿主开发目标：所有标签、版本与安装门禁的唯一来源。 */
const pinnedHostVersion = manifest.devDependencies?.['@deepseek-ai/dsh'] ?? ''
if (!EXACT_VERSION.test(pinnedHostVersion)) {
  throw new Error('package.json devDependencies["@deepseek-ai/dsh"] must pin one exact published host version')
}
const engineRange = manifest.engines?.dsh
if (typeof engineRange !== 'string' || !engineRangeAdmits(engineRange, pinnedHostVersion)) {
  throw new Error(
    `package.json engines.dsh must be an exact version or a space-separated comparator chain admitting ${pinnedHostVersion}; found ${String(engineRange)}`,
  )
}

/** package.json engines.dsh 声明的宿主兼容范围。 */
export const DSH_ENGINE_RANGE = engineRange
/** 固定的精确宿主开发目标。 */
export const DSH_SOURCE_VERSION = pinnedHostVersion
export const DSH_SOURCE_TAG = `dsh-v${pinnedHostVersion}`
export const DSH_COMPAT_RANGE = pinnedHostVersion
