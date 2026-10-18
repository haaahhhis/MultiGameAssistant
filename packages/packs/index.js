import { fileURLToPath } from 'node:url'

/** Directory holding the built-in Script Packs, one subdirectory per pack id. */
export const PACKS_DIR = fileURLToPath(new URL('./packs/', import.meta.url))
