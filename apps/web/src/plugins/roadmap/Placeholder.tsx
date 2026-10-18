import type { PageProps } from '../../plugins.ts'

/** Shown only if a host serves the capability before the real page exists. */
export function Placeholder(_props: PageProps) {
  return <section className="main empty">后端已提供该能力，但这个版本的界面还没有对应页面。</section>
}
