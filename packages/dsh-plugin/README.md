# dsh-multigameassistant

MultiGameAssistant（多游戏助手）的 dsh 插件：这里是它发布时的 `package.json`（声明 `dsh.bundle`）和 `cordis.patch.yml`，和 npm 上的 [`dsh-multigameassistant`](https://www.npmjs.com/package/dsh-multigameassistant)、每个 [Release](https://github.com/haaahhhis/MultiGameAssistant/releases) 里的 `dsh-multigameassistant.tgz` 一致，只是版本号在打包时才填。

插件的代码在本仓库的 `packages/*` 里，由 `scripts/package-plugin.mjs` 打包成一个 npm 包（esbuild 把各插件打成 `lib/<插件>.js`，加上内置脚本包、核心技能和界面），所以不能从这个文件夹直接安装源码。安装：

- dsh 桌面版：「Plugins」→「Add plugin」，填 `dsh-multigameassistant`。
- 命令行的 dsh：`dsh plugin add dsh-multigameassistant`。
- npm 连不上时：`https://github.com/haaahhhis/MultiGameAssistant/releases/latest/download/dsh-multigameassistant.tgz`。

这两个文件由 `pnpm package:plugin --sync` 生成（补丁来自 `packages/bundle/cordis.patch.yml`），不要手改；打包时它们和要发布的不一致会报错。

`screenshots.json` 和 `screenshots/` 是插件市场（awesome-dsh-plugin、dsh-market）详情页展示的截图，路径相对于这个文件夹；换截图直接改这里，不用去列表仓库提 PR。它们不进 npm 包。
