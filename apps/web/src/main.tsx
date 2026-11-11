import { createRoot } from 'react-dom/client'
import { AdgClient } from '@adg/client-core'
import { App, TokenPrompt } from './App.tsx'
import { BootScreen } from './components/BootScreen.tsx'
import { CrashScreen } from './components/CrashScreen.tsx'
import { gatewayUrl, MOUNTED, readToken, saveToken } from './config.ts'
import { registerPlugin } from './plugins.ts'
import { chatPlugin } from './plugins/chat/index.ts'
import { roadmapPlugins } from './plugins/roadmap/index.ts'
import { feishuPlugin, monitorPlugin } from './plugins/monitor/index.ts'
import { pipelinesPlugin, schedulePlugin } from './plugins/pipelines/index.ts'
import { gamesPlugin } from './plugins/games/index.ts'
import { skillsPlugin } from './plugins/skills/index.ts'
import { emulatorsPlugin, scriptsPlugin } from './plugins/scripts/index.ts'
import { aboutPlugin, compactionPlugin, memoryPlugin, permissionsPlugin, personaPlugin, settingsPlugin } from './plugins/settings/index.ts'
import { statusPlugin } from './plugins/status/index.ts'
import { trajectoryPlugin } from './plugins/trajectory/index.ts'
import { applyTheme } from './theme.ts'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource/noto-serif-sc/600.css'
import './styles.css'
import './plugins/trajectory/trajectory.css'

applyTheme()

// Built-in UI plugins. Each one only appears when its capabilities are served.
registerPlugin(chatPlugin)
registerPlugin(trajectoryPlugin)
registerPlugin(settingsPlugin)
registerPlugin(permissionsPlugin)
registerPlugin(personaPlugin)
registerPlugin(memoryPlugin)
registerPlugin(compactionPlugin)
registerPlugin(aboutPlugin)
registerPlugin(statusPlugin)
registerPlugin(scriptsPlugin)
registerPlugin(emulatorsPlugin)
registerPlugin(monitorPlugin)
registerPlugin(feishuPlugin)
registerPlugin(pipelinesPlugin)
registerPlugin(schedulePlugin)
registerPlugin(gamesPlugin)
registerPlugin(skillsPlugin)
for (const plugin of roadmapPlugins) registerPlugin(plugin)

const root = createRoot(document.getElementById('root')!)

function boot(token: string | null) {
  const client = new AdgClient({ url: gatewayUrl(token), clientInfo: { name: 'adg-web', version: '0.1.0' } })
  client.start()
  root.render(<CrashScreen><App client={client} /><BootScreen client={client} /></CrashScreen>)
}

// Under dsh's web server its login is the key (config.ts MOUNTED).
const token = MOUNTED ? null : readToken()
if (MOUNTED) {
  boot(null)
} else if (token === null) {
  root.render(<TokenPrompt onSubmit={value => { saveToken(value); boot(value) }} />)
} else {
  boot(token)
}
