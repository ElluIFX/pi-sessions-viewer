# Pi Sessions Viewer

A private, offline-first browser for [pi](https://pi.dev) coding-agent sessions. This fork builds on [ygncode/pi-sessions-viewer](https://github.com/ygncode/pi-sessions-viewer), retaining its Go server, embedded export renderer, session tree and live updates.

## Download and run (Linux amd64)

**No Go, Node.js, GitHub CLI, package manager or internet connection is needed to view sessions.** Download the Linux amd64 archive from [Releases](https://github.com/ElluIFX/pi-sessions-viewer/releases), copy it to your Linux machine, then:

```sh
tar -xzf pi-sessions-viewer-*-linux-amd64.tar.gz
./pi-sessions-viewer
```

Open **http://127.0.0.1:27183**. The default session directory is `~/.pi/agent/sessions/`. For a custom location:

```sh
./pi-sessions-viewer -sessions-dir /path/to/sessions -p 8080
```

The release includes a statically linked Linux x86-64 binary, embedded CSS/JavaScript, build metadata and SHA-256 checksums. ARM machines need a separate build. See [Linux deployment and verification](docs/LINUX.md) for remote-server access, systemd and Chinese quick-start instructions.

## What is improved

- Responsive session dashboard with local search, project filtering, sorting and summary metrics.
- Consistent light/dark theme, readable conversation layout and keyboard-friendly controls.
- Existing session-tree navigation, message filters, thinking/tool output and live updates retained.
- Local standalone HTML export without uploading your conversation anywhere.
- Localhost by default; external sharing is explicitly disabled until enabled by the operator.
- Safer session-file handling, project-qualified identifiers and tested server behavior.
- Reusable GitHub Actions pipeline: test, race-test, portable build, smoke test and Release publication.

## Privacy and network access

Normal browsing and export work offline. All required frontend assets are embedded in the executable. Remote Markdown images are not automatically loaded. External links open only when you choose them.

The viewer exposes **complete session transcripts, including code and tool output**, and has no built-in user accounts or TLS. Do not expose it to the public internet. For a remote server, prefer an SSH tunnel:

```sh
ssh -L 27183:127.0.0.1:27183 user@server
```

For an intentionally trusted LAN, opt in with `-host 0.0.0.0`; use a firewall and an authenticated HTTPS reverse proxy where appropriate. Anyone who can reach the service can read its sessions. Keep external sharing disabled on a shared service.

### Optional GitHub Gist sharing

Local **Export HTML** does not require GitHub. External sharing requires `-enable-sharing`, the GitHub CLI and an already authenticated GitHub account. It uploads the full session to a **secret Gist**, which is unlisted, **not private**; anyone with the link can access it. Review the transcript for secrets before confirming. Shared snapshots do not auto-update. This feature requires external network access and is unnecessary for intranet use.

## Build and test

Requires Go **1.25.5 or newer** (the release workflow pins Go 1.27.3).

```sh
go test ./...
go test -race ./...
go vet ./...
go build -o pi-sessions-viewer .
# Linux release package, requires bash, git, tar, file, readelf and sha256sum:
bash scripts/build-release.sh
bash scripts/smoke-test.sh
```

CI runs on main-branch pushes and pull requests. To publish a tested release in this fork, update `VERSION` and push a commit whose message contains `[release]`, or run the **Linux amd64 build and release** workflow manually with `publish` selected. Existing release tags are never overwritten. Publishing permissions are restricted to the release job; no personal token is required.

## Pi integration

Install the optional `/view` extension and restart pi (or run `/reload`):

```sh
cp view-sessions.ts ~/.pi/agent/extensions/
```

Then `/view` opens the current session in the viewer. The legacy filename lookup remains available when the filename is unique across projects. An optional pi skill remains in `skill/`.

The upstream macOS LaunchAgent is retained in `com.pi-sessions-viewer.plist`; review its machine-specific paths before installing. This release's downloadable binary targets Linux amd64 only.

## Attribution and license

Original project: [ygncode/pi-sessions-viewer](https://github.com/ygncode/pi-sessions-viewer). The upstream README declares MIT; the imported revision does not include a standalone LICENSE file. Embedded renderer/vendor attribution remains in the source files. This fork does not invent or replace upstream copyright notices.
