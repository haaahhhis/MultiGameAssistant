/**
 * How agents update scripts (the 脚本 and 干预 roles): official channels only.
 * Code pulled by hand (git, a source download, files copied over) has broken
 * scripts — their updater's own records no longer matched (ok-ww's pyappify).
 */
export const UPDATE_RULE = '更新脚本只走官方渠道：先用 script_update（Mirror酱 或官方发布包，配置会接上）；它没有更新来源或失败时，用脚本自己的更新功能（它的更新程序、启动器或设置里的「检查更新」）。不要用 git clone / pull / checkout 拉代码，不要自己下载源码或手动解压覆盖文件——除非没有任何官方渠道，并且用户同意。'
