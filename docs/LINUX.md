# Linux amd64 deployment

## 中文快速开始

1. 从本仓库 Release 下载 `pi-sessions-viewer-版本-linux-amd64.tar.gz` 和 `SHA256SUMS`，复制到内网机器。
2. 校验下载的压缩包：`sha256sum --ignore-missing -c SHA256SUMS`。
3. 解压后运行 `./pi-sessions-viewer`，打开 `http://127.0.0.1:27183`。
4. 默认读取当前用户的 `~/.pi/agent/sessions`。自定义目录：`./pi-sessions-viewer -sessions-dir /data/pi/sessions`。
5. 服务器没有桌面时，在自己的电脑执行 `ssh -L 27183:127.0.0.1:27183 user@服务器地址`，再用本机浏览器访问上述网址。

不需要 Go、Node.js、npm 或外网。可执行文件已静态编译，并内置网页资源。普通浏览和“Export HTML”不会上传会话。默认仅监听本机，GitHub 分享默认关闭。

确实需要局域网直连时使用 `-host 0.0.0.0`，并自己配置访问控制。这个程序没有登录认证，所有能连接到端口的人都能读取完整会话；不要直接暴露到公网。GitHub 的 secret Gist 不是私有存储，拿到链接的人都能查看。

## Verification

Download the archive (or the raw `pi-sessions-viewer-linux-amd64` executable) plus `SHA256SUMS` from the same release. Check before running:

```sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf pi-sessions-viewer-*-linux-amd64.tar.gz
./pi-sessions-viewer -version
./pi-sessions-viewer -h
```

The archive includes `BUILD-INFO.txt` with source revision and toolchain. The raw executable may need `chmod +x pi-sessions-viewer-linux-amd64` after download. The archive preserves the executable bit. Linux x86-64 (amd64, GOAMD64=v1) is required; there is no glibc or musl dependency. A reasonably current Linux kernel is required by Go; statically linked does not mean compatibility with every historical kernel.

## Configuration

| Flag | Purpose |
| --- | --- |
| `-host 127.0.0.1` | Bind address, localhost by default |
| `-p 27183` | TCP port |
| `-sessions-dir PATH` | Session root containing project directories and JSONL files |
| `-o` | Try opening the system browser (not needed on servers) |
| `-enable-sharing` | Explicitly allow uploads to secret GitHub Gists |
| `-version` | Print version, source commit and build date |

Run as the user who owns the session files. Do not run as root. Session files are read, never rewritten by the viewer. HTML exports may contain sensitive code, paths and tool output; handle them like the original transcript.

## Optional systemd user service

Install the binary at `~/.local/bin/pi-sessions-viewer`, then save this as `~/.config/systemd/user/pi-sessions-viewer.service` (create the directories first):

```ini
[Unit]
Description=Pi Sessions Viewer

[Service]
ExecStart=%h/.local/bin/pi-sessions-viewer -host 127.0.0.1 -p 27183
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Activate with `systemctl --user daemon-reload` and `systemctl --user enable --now pi-sessions-viewer`. Inspect logs with `journalctl --user -u pi-sessions-viewer`. A user service normally runs while that user's login session is active; unattended boot operation depends on your administrator's user-service policy. Do not enable GitHub sharing in this service unless intentionally needed.

## Troubleshooting

- Empty dashboard: verify the session directory belongs to the correct user and contains pi project subdirectories with `.jsonl` files.
- Port occupied: select another port with `-p 8080`; adjust the browser URL and tunnel consistently.
- Wrong architecture / `Exec format error`: this release is amd64, not arm64.
- Missing `xdg-open`: omit `-o` and open the displayed URL manually.
- Browser cannot connect remotely: localhost-only is intentional; use the SSH tunnel or explicitly opt in to a trusted LAN binding.
- Offline GitHub Share fails: use local HTML export instead. Ordinary viewing never needs `gh`.
