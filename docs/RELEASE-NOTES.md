## Linux amd64 · offline-first edition

无需安装 Go、Node.js 或 npm，下载后即可在 Linux x86-64 内网机器运行。

- 全新响应式会话列表、搜索/项目筛选/排序和明暗主题。
- 更清晰的会话阅读界面，保留会话树、工具输出及实时更新。
- 本地 HTML 导出，默认不联网加载图片，不上传会话。
- 默认仅监听 127.0.0.1；外部 GitHub 分享需显式启用并确认。
- 静态编译，内置全部前端资源；CI 包含测试、竞态检查和二进制冒烟测试。

### 下载

推荐下载 `pi-sessions-viewer-版本-linux-amd64.tar.gz`；也提供裸二进制 `pi-sessions-viewer-linux-amd64`。下载同版本 `SHA256SUMS` 后使用 `sha256sum --ignore-missing -c SHA256SUMS` 校验。

解压并运行 `./pi-sessions-viewer`，访问 http://127.0.0.1:27183 。默认读取 `~/.pi/agent/sessions`，可通过 `-sessions-dir /path/to/sessions` 自定义。

远程服务器推荐 SSH 端口转发：`ssh -L 27183:127.0.0.1:27183 user@server`。程序没有内置身份认证，不要直接暴露公网。具体使用与部署说明在压缩包的 `LINUX.md`、`README.md` 中。

基于 ygncode/pi-sessions-viewer，保留上游核心实现。普通浏览与导出不需要 GitHub CLI；可选 secret Gist 分享是对外上传，secret 不等于私有。
