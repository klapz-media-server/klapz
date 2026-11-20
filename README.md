# Klapz

Klapz is an open-source, cross-platform media server inspired by Plex and Jellyfin.

The project exposes media APIs compatible with multiple ecosystems, starting with
Plex and Jellyfin compatibility.

## Releases

The release pipeline packages binaries from these projects:

- [klapz-server](https://github.com/klapz-media-server/klapz-server)
- [klapz-ffmpeg](https://github.com/klapz-media-server/klapz-ffmpeg)
- [klapz-web](https://github.com/klapz-media-server/klapz-web)

The main server and scanner binaries are downloaded from matching releases and
packaged with the web application and FFmpeg:

```text
klapz/
├── web/
│   └── ...web application...
├── klapz-server[.exe]
├── klapz-scanner[.exe]
└── klapz-ffmpeg[.exe]
```

Windows packages use `.exe`; macOS and Linux packages use executable binaries
without an extension.

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
