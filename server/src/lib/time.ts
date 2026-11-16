/** 统一 UTC ISO 时间；数据库里全部按这个格式存。 */
export const nowIso = (): string => new Date().toISOString()

/** 按天分桶用的 UTC 日期，形如 2026-11-16。 */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10)

/** 判断 ISO 时间串是否已过期。 */
export const isExpired = (iso: string | null | undefined): boolean =>
  typeof iso === 'string' && iso.length > 0 ? Date.parse(iso) <= Date.now() : false

/** 在给定时间上增加天数，返回 ISO。 */
export const addDays = (days: number, from: Date = new Date()): string =>
  new Date(from.getTime() + days * 86_400_000).toISOString()

/** 在给定时间上增加秒数，返回 ISO。 */
export const addSeconds = (seconds: number, from: Date = new Date()): string =>
  new Date(from.getTime() + seconds * 1000).toISOString()
