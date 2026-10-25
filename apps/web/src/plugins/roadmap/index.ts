/**
 * Product areas whose host plugins land in later milestones.
 *
 * Each declares the capability its host plugin will serve, so it stays hidden
 * until that plugin is mounted; the plugin status page lists it meanwhile.
 * When a milestone lands, its entry here is replaced by the real UI plugin.
 * (Empty since M6: every planned area has its page.)
 */
import type { UiPlugin } from '../../plugins.ts'

export const roadmapPlugins: readonly UiPlugin[] = []
