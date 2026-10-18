import { createRoot } from 'react-dom/client'
import { AdgClient } from '@adg/client-core'
import { App, TokenPrompt } from './App.tsx'
import { gatewayUrl, readToken, saveToken } from './config.ts'
import { registerPlugin } from './plugins.ts'
import { chatPlugin } from './plugins/chat/index.ts'
import { roadmapPlugins } from './plugins/roadmap/index.ts'
import { settingsPlugin } from './plugins/settings/index.ts'
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
registerPlugin(statusPlugin)
for (const plugin of roadmapPlugins) registerPlugin(plugin)

const root = createRoot(document.getElementById('root')!)

function boot(token: string) {
  const client = new AdgClient({ url: gatewayUrl(token), clientInfo: { name: 'adg-web', version: '0.1.0' } })
  client.start()
  root.render(<App client={client} />)
}

const token = readToken()
if (token === null) {
  root.render(<TokenPrompt onSubmit={value => { saveToken(value); boot(value) }} />)
} else {
  boot(token)
}
