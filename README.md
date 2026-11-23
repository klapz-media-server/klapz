# Klapz

Klapz is an open-source, cross-platform media server inspired by Plex and Jellyfin.

The project exposes media APIs compatible with multiple ecosystems, starting with
Plex and Jellyfin compatibility.

## Releases

The release pipeline packages binaries from these projects:

- [klapz-server](https://github.com/klapz-media-server/klapz-server)
- [klapz-ffmpeg](https://github.com/klapz-media-server/klapz-ffmpeg)
- [klapz-web](https://github.com/klapz-media-server/klapz-web)

The server binary is downloaded from a matching release and packaged with the web
application and FFmpeg, which the server also reads media files with for its library
scans:

```text
klapz/
├── web/
│   └── ...web application...
├── klapz-server[.exe]
└── klapz-ffmpeg[.exe]
```

Windows packages use `.exe`; macOS and Linux packages use executable binaries
without an extension.

## Run worktrees locally

`scripts/run-worktrees.mjs` starts a `klapz-server` worktree and/or a `klapz-web` worktree
on their own ports, beside the main checkout's server (32500) and web app (5180), to test a
branch for real (Node.js 20 or newer):

```bash
node scripts/run-worktrees.mjs start --server ../klapz-server-wt --web ../klapz-web-wt --name my-branch
node scripts/run-worktrees.mjs status
node scripts/run-worktrees.mjs stop --name my-branch
```

Each instance name keeps its ports in `~/.klapz-dev/instances.json` (servers from 32510, web
apps from 5181) and never takes a port in use. The server inherits the main checkout's `.env`
and runs on a copy of its database by default (`--db fresh` or `--db shared` otherwise).
`--help` lists every option.

## Build a release package

Packages are assembled by the cross-platform script in `scripts/package-release.js`.
Use Node.js 20 or newer:

```bash
node scripts/package-release.js \
  --version 1.0.0 \
  --platform linux \
  --arch arm64 \
  --output dist/klapz-linux-arm64
```

Supported platform/architecture combinations are:

| Package | Platform | Architecture |
| --- | --- | --- |
| `klapz-linux-arm64` | `linux` | `arm64` |
| `klapz-linux-x64` | `linux` | `x64` |
| `klapz-darwin-arm64` | `darwin` | `arm64` |
| `klapz-darwin-x64` | `darwin` | `x64` |
| `klapz-windows-x64` | `win32` | `x64` |
