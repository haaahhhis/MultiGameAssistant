---
name: web-reading
description: 从网上查游戏资讯（版本、活动、卡池、维护公告、版本更新和补丁说明、兑换码等），连配图地址和完整正文一起拿到：先找数据的源头（公开 API、RSS、Wiki 接口），读不到再读网页、开内置浏览器；少请求、少花模型。用户要查游戏相关的网上信息、要公告配图，或游戏包里没有能自动读的数据站时使用。
---

# 从网上查游戏资讯

目标：用最少的请求拿到**准确、完整、有出处**的信息——标题原文、发布时间、正文要点、网址，还有**配图地址**。

## 为什么要找源头

网页上看到的公告，几乎都是从一个 JSON 接口或 RSS 读出来再画到页面上的。直接读这个源头，拿到的是完整正文、准确时间和图片的真实地址；读渲染后的网页文字，图片就只剩说明文字，截短的摘要还会把段落挤在一起、把图丢掉。所以：

- **先找源头，别先读网页**：游戏数据站、Steam 接口、RSS、Wiki 的 `api.php`。
- **正文不要截短**：要看全文时不加 `maxlength` 这类截短参数（截短后是去掉图片的纯文本）。先用短的列表挑出要看的那几篇，再只读那几篇的全文。
- **列表上的都记，全文只读几篇**：记公告时，列表上最近的每一篇都记下（标题、日期、网址、缩略图，列表上就有）；只读全文的那几篇才写正文要点。不要因为只点开了两三篇就只记两三篇。
- **图片地址照原样取，补成完整地址**：占位符换成真地址（Steam 公告里的 `{STEAM_CLAN_IMAGE}` 换成 `https://clan.akamai.steamstatic.com/images`）；`/images/a.png` 这样的相对地址前面补上网页的域名（`https://站点域名/images/a.png`），`//` 开头的补 `https:`。

## 你的工具能拿到什么

- `web_fetch`：JSON、XML（RSS）**原样返回**，字段和图片地址都在；HTML 转成 Markdown，图片是 `![说明](地址)`、链接是 `[文字](地址)`，可以直接从里面取图片和文章链接。但 `<head>` 里的分享图（og:image）和页面脚本里的数据会被去掉；懒加载的图片地址可能是占位图（`data:`、`loading`、`blank`、1×1 小图），这时去找源头接口。前端渲染的官网只拿到标题或空壳。
- 内置浏览器 `browser_*`：能读前端渲染的页面。页面内容里**图片只有说明文字、链接只有文字，都没有地址**；点进一个链接后，返回的页面内容第一行就是它的网址。要看图片里的字（海报上的活动时间、奖励表）用 `browser_screenshot`（模型要能看图）；浏览器截图只给你看，不能当配图存下来。
- 在 `run_code` 程序里调用 `web_fetch` 时：在程序里解析 JSON / XML，用代码取出标题、日期、网址、图片地址和要的那几段正文，只把这些返回，不要把整页返回到对话里。

## 先后顺序

1. **日历里已经有的**：`game_activities` 先看（带着最近的 `notices` 公告）。数据站一天会刷新（`game_sites_refresh`），不用自己再去网上查同样的东西。
2. **公开 API（JSON，免费、不用登录）**——优先：
   - **SRA 公共 API**（StarRailAssistant 社区维护，取自官方公告并人工核对）：
     `GET https://starrailassistant.top/api/v1/activity/{game}.json`
     返回当前版本号 `version`、版本名 `versionName`、版本起止 `startTime` / `endTime`、版本配图 `cover`、活动列表 `activities[]`（`name`、`description`、`startTime`、`endTime`、配图 `cover`，空字符串就是没有），有的还有卡池 `pools[]`（`name`、`type`、`upCharacters`、起止时间）。时间是服务器时间（不带时区，国服按北京时间）。
     游戏标识：`sr` 崩坏：星穹铁道、`ys` 原神、`zzz` 绝区零、`ww` 鸣潮、`nte` 异环、`ak` 明日方舟、`end` 明日方舟：终末地、`xtlr` 星塔旅人、`ba-cn` / `ba-jp` / `ba-global` 蔚蓝档案。英文数据加语言后缀：`{game}-en-US.json`。说明页：https://starrailassistant.top/reference/public-api/
     游戏包里已经写了 `sra` 来源的游戏，插件每天自己读，不用你再读；别的游戏直接用 `web_fetch` 读这个 JSON。
   - **Steam**（Steam 上的游戏，单机游戏首选；免费、不用 key）。`appid` 是商店页 `store.steampowered.com/app/<数字>` 里的数字。
     - 公告列表（很短，用来挑）：`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={appid}&count=20&maxlength=1&feeds=steam_community_announcements&format=json`
       `appnews.newsitems[]`：`title`、`url`、`date`（Unix 秒）、`tags`（含 `patchnotes` 的是补丁说明）。`feeds=steam_community_announcements` 只要官方公告。
     - 某一篇的全文：`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={appid}&count=1&enddate={那一篇的 date}&feeds=steam_community_announcements&format=json`（不加 `maxlength`）。`contents` 是完整的 BBCode：`[h2]`/`[b]` 是小标题，`[list][*]` 是条目；图片是 `[img]{STEAM_CLAN_IMAGE}/…[/img]`（把占位符换成 `https://clan.akamai.steamstatic.com/images`）或 `[img src="https://…"]`，视频是 `[previewyoutube=…]`。
     - 官方中文版：`https://store.steampowered.com/feeds/news/app/{appid}/?l=schinese`（RSS，最近 10 篇的全文，常有十万字，要中文或在 `run_code` 程序里处理时再用）。开发者写了中文的公告这里是中文：`<item>` 里 `title`、`link`（商店新闻页的正式网址）、`pubDate`、`description`（完整正文 HTML，`<img src="https://clan.fastly.steamstatic.com/images/…">` 是真地址），`<enclosure url="…">` 是这篇的封面图。
     - 游戏本身的资料和图：`https://store.steampowered.com/api/appdetails?appids={appid}&l=schinese&cc=cn&filters=basic` → 中文名 `name`、简介 `short_description`、横幅图 `header_image`、官网 `website`；`filters=screenshots` 是截图（`path_full`），`filters=release_date` 是发售日期。
     - 公告网址用接口给的 `url` 或 RSS 的 `link`。不要用 `gid` 自己拼 `store.steampowered.com/news/app/{appid}/view/…`：商店新闻页的编号和 `gid` 不一样，拼出来的页面一直显示 LOADING。
     游戏包里写了 `steam: { appid: … }` 来源的，插件每天自己读最近 20 篇公告（`game_add` 时马上读一次），不用你再读列表、也不用再记。
3. **Wiki 的查询接口**：PRTS、B 站游戏 WIKI 都是 MediaWiki，用 `api.php` 拿结构化结果，比读页面省得多：
   - 按属性查（Semantic MediaWiki）：`https://prts.wiki/api.php?action=ask&format=json&query=[[分类:有活动信息的页面]]|?活动开始时间|?活动结束时间|limit=50`
   - 读一个页面的正文：`api.php?action=parse&page=页面名&prop=wikitext&format=json`
   - 一个页面用到的图片，一次拿到真地址：`api.php?action=query&generator=images&titles=页面名&gimlimit=20&prop=imageinfo&iiprop=url&format=json`（每张图的 `imageinfo[0].url`；名字带 icon、图标、头像的一般不是配图）
   - 已知文件名的图片地址：`api.php?action=query&titles=文件:文件名&prop=imageinfo&iiprop=url&format=json`
   - 最近上传的图片（新活动的横幅常在这里）：`api.php?action=query&list=allimages&aisort=timestamp&aidir=descending&ailimit=10&aiprop=url|timestamp&format=json`
   - 搜页面：`api.php?action=opensearch&search=关键词&limit=10`
4. **官方公告页**：官网新闻（游戏包 `sources` 里的 `homepage`）。先读**列表页**找到目标公告的链接，再只读那几篇；不要一页一页往下翻。
   - `web_fetch` 列表页：Markdown 里的 `[标题](链接)` 就是文章地址，列表上的缩略图 `![](…)` 常常就是封面。列表页没有图时，文章页一般有：正文里第一张不是图标的 `![](…)` 就是配图。
   - 列表页只拿到空壳、或找不到文章链接时，先花一两个请求找源头，再开浏览器：页面上写着的 RSS / 订阅地址，或常见的 `/feed.xml`、`/feed`、`/rss.xml`、`/atom.xml`（RSS 里每篇的 `title`、`link`、`pubDate` 就是文章列表）；WordPress 站点 `/wp-json/wp/v2/posts?per_page=5&_embed`（正文 `content.rendered`，封面 `_embedded["wp:featuredmedia"][0].source_url`）。试不出来就算了，不要一个个猜下去。
   - 再用**内置浏览器**：`browser_navigate` 打开列表页，`browser_text` 读渲染后的全文，`browser_click` 点进那篇公告（返回的第一行是它的网址）再 `browser_text`。要配图时用 `web_fetch` 读这篇文章的网址（文章页常常不是空壳），从 `![](…)` 里取；还是没有就不写配图。用户能在浏览器面板里看到你打开的页面。
   - 你的对话里没有 `browser_*`（主 agent 的对话不直接操作）：开子 agent 去读，任务里写明「用内置浏览器（browser_navigate 打开，browser_text 读渲染后的文字）」，并写明要它带回什么：标题、发布时间、网址、正文要点、配图地址。
5. **搜索**：前面都没有时才用 `web_search`，关键词带上游戏名、版本号、「公告」「更新」等，优先点官方域名、Steam 和 Wiki。

## 读全、读准

- 每篇公告要的：标题原文、发布时间（哪个时区）、版本号、正文要点、网址、配图地址。网址和图片地址只写读到的，不要自己拼。
- 补丁说明和版本公告很长：按它的小标题（新内容、平衡调整、修复、活动、奖励、兑换码、维护时间）归纳，每类写最要紧的几条，不要只看第一段。
- 挑配图：优先公告的封面（RSS 的 `enclosure`、列表页缩略图、正文第一张大图），游戏本身用 `header_image`。不要图标、表情、头像、二维码、分享按钮、`.svg` 和 1×1 小图；地址必须是 `https://` 开头的完整地址。
- 时间写清楚是哪个时区；网页上的「10月25日 03:59」按游戏服务器时间理解（`game_list` 里的 `timezone`），Steam 的 `date` 是 Unix 秒。
- 没有确切出处的时间不要写；不同来源对不上时说明以哪个为准（数据站 > 官方公告 > 其他网站）。

## 读网页时

- 一次只读需要的那一页；返回的内容很长时，只提取要的字段，不要把整页复述给用户。
- 不登录、不填表、不点广告和下载；遇到验证码、需要登录的页面就停下告诉用户。
- 请求要少：同一个地址一次对话里只读一次，出错重试最多一次。网站拦了你（403、429、567、「Access Restricted」「访问受限」）就不要再请求这个网站，换别的来源（另一个 Wiki、官网、Steam），并告诉用户哪里没读到。

## 记下来

- 查到的活动用 `game_record`（`source: site`，带上 `url`，有配图写进 `cover`）写进日历，以后看板、日报都能用，不用再查一遍。
- 版本更新、补丁说明、长期有效的公告这些没有起止时间的，用 `game_notice` 记到游戏的「公告」里（kind=update / notice / news，长期的 lasting=true；`summary` 写一两句中文要点，配图写进 `cover`）。单机游戏主要记这个。
  列表上最近的每一篇都记（单机游戏最近三个月、网游最近一个月，最多 20 篇，一次 `game_notice` 可以记 30 篇）；没点开的那些不写 `summary`，标题、日期、网址照列表写。综合新闻站（一个厂商的多款游戏）只记这个游戏的。
- 回答用户时把要点讲全，附上网址；用户要看图就给图片地址。
- 某个游戏有好用的固定接口，但游戏包里还没有：告诉用户可以在游戏包的 `game.yaml` 里加一个来源（`sra: { game: … }`、`smw: …` 或 `steam: { appid: … }`），以后插件每天自己读，不花模型。
