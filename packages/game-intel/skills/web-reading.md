---
name: web-reading
description: 从网上查游戏资讯（版本、活动、卡池、维护公告、兑换码等）的方法：先用公开 API，再用 Wiki 的查询接口，最后才读网页；少请求、少花模型。用户要查游戏相关的网上信息、或游戏包里没有能自动读的数据站时使用。
---

# 从网上查游戏资讯

目标：用最少的请求拿到**准确、有出处**的信息。能用结构化数据（JSON）就不要读整页 HTML；能让插件自己读的就不要每次让模型读。

## 先后顺序

1. **日历里已经有的**：`game_activities` 先看。数据站一天会刷新（`game_sites_refresh`），不用自己再去网上查同样的东西。
2. **公开 API（JSON，免费、不用登录）**——优先：
   - **SRA 公共 API**（StarRailAssistant 社区维护，取自官方公告并人工核对）：
     `GET https://starrailassistant.top/api/v1/activity/{game}.json`
     返回当前版本号 `version`、版本名 `versionName`、版本起止 `startTime` / `endTime`、活动列表 `activities[]`（`name`、`kind`、`description`、`startTime`、`endTime`），有的还有卡池 `pools[]`（`name`、`type`、`upCharacters`、起止时间）。时间是服务器时间（不带时区，国服按北京时间）。
     游戏标识：`sr` 崩坏：星穹铁道、`ys` 原神、`zzz` 绝区零、`ww` 鸣潮、`nte` 异环、`ak` 明日方舟、`end` 明日方舟：终末地、`xtlr` 星塔旅人、`ba-cn` / `ba-jp` / `ba-global` 蔚蓝档案。英文数据加语言后缀：`{game}-en-US.json`。说明页：https://starrailassistant.top/reference/public-api/
   - 游戏包里已经写了 `sra` 来源的游戏（明日方舟、终末地、星穹铁道），插件每天自己读，不用你再读；别的游戏直接用 `web_fetch` 读这个 JSON。
3. **Wiki 的查询接口**：PRTS、B 站游戏 WIKI 都是 MediaWiki，用 `api.php` 拿结构化结果，比读页面省得多：
   - 按属性查（Semantic MediaWiki）：`https://prts.wiki/api.php?action=ask&format=json&query=[[分类:有活动信息的页面]]|?活动开始时间|?活动结束时间|limit=50`
   - 读一个页面的正文：`api.php?action=parse&page=页面名&prop=wikitext&format=json`
   - 搜页面：`api.php?action=opensearch&search=关键词&limit=10`
4. **官方公告页**：官网新闻（游戏包 `sources` 里的 `homepage`）。先读**列表页**找到目标公告的链接，再只读那一篇；不要一页一页往下翻。
5. **搜索**：前面都没有时才用 `web_search`，关键词带上游戏名、版本号、「公告」等，优先点官方域名和 Wiki。

## 读网页时

- 一次只读需要的那一页；`web_fetch` 返回的内容很长时，只提取要的字段（活动名、起止时间、奖励），不要把整页复述给用户。
- 时间写清楚是哪个时区；网页上的「10月25日 03:59」按游戏服务器时间理解（`game_list` 里的 `timezone`）。
- 没有确切出处的时间不要写；不同来源对不上时说明以哪个为准（数据站 > 官方公告 > 其他网站）。
- 不登录、不填表、不点广告和下载；遇到验证码、需要登录的页面就停下告诉用户。
- 请求要少：同一个地址一次对话里只读一次，出错重试最多一次。

## 记下来

- 查到的活动用 `game_record`（`source: site`，带上 `url`）写进日历，以后看板、日报都能用，不用再查一遍。
- 某个游戏有好用的固定接口，但游戏包里还没有：告诉用户可以在游戏包的 `game.yaml` 里加一个来源（`sra: { game: … }` 或 `smw: …`），以后插件每天自己读，不花模型。
