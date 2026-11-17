import type { TranslationKey } from './i18n/index.js'

/**
 * 关于页的静态信息。
 *
 * `REPO_URL` 是 AGPL-3.0 第 13 条的履约入口：本项目通过网络提供服务，
 * 必须让使用者能找到完整源码。部署到别处时请把这里改成你自己的公开仓库地址，
 * 否则不满足许可要求。
 */
export const PRODUCT_NAME = 'ZH DeepSeek'

/** 源码仓库：AGPL 要求的「corresponding source」入口 */
export const REPO_URL = 'https://github.com/lzh173/deepseek-site'

/** 上游项目（MIT），保留归属 */
export const UPSTREAM_NAME = 'deepseek-ai/chat-demo'
export const UPSTREAM_URL = 'https://github.com/deepseek-ai/chat-demo'

export const LICENSE_ID = 'AGPL-3.0-only'
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html'

/** 构建时由 HtmlRspackPlugin 从 package.json 注入到 meta 里 */
export const appVersion = (): string => {
  if (typeof document === 'undefined') {
    return '—'
  }
  const meta = document.querySelector('meta[name="application-version"]')
  return meta?.getAttribute('content') ?? '—'
}

/** 关于页里的链接行 */
export type AboutLink = {
  key: string
  labelKey: TranslationKey
  href: string
  hintKey: TranslationKey
}

export const ABOUT_LINKS: AboutLink[] = [
  {
    key: 'repo',
    labelKey: 'aboutRepoLabel',
    href: REPO_URL,
    hintKey: 'aboutRepoHint',
  },
  {
    key: 'license',
    labelKey: 'aboutLicenseLabel',
    href: LICENSE_URL,
    hintKey: 'aboutLicenseHint',
  },
  {
    key: 'upstream',
    labelKey: 'aboutUpstreamLabel',
    href: UPSTREAM_URL,
    hintKey: 'aboutUpstreamHint',
  },
]
