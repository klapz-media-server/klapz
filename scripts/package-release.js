#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPOSITORIES = {
  ffmpeg: "klapz-media-server/klapz-ffmpeg",
  web: "klapz-media-server/klapz-web",
  server: "klapz-media-server/klapz-server",
};

function usage() {
  console.log(`Usage:
  node scripts/package-release.js --version <version> --platform <linux|darwin|win32> --arch <x64|arm64> --output <directory>

Optional:
  --ffmpeg-version <version>
  --web-version <version>
  --server-version <version>`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help") args.help = true;
    else if (key.startsWith("--")) args[key.slice(2)] = argv[++i];
  }
  return args;
}

function normalizeVersion(version) {
  return String(version).replace(/^v/i, "");
}

function releaseTags(version) {
  const normalized = normalizeVersion(version);
  return [...new Set([`v${normalized}`, normalized])];
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "klapz-release-packager",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function getRelease(repository, version) {
  for (const tag of releaseTags(version)) {
    const url = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "klapz-release-packager",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });
    if (response.ok) return response.json();
  }

  const releases = await githubJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100`
  );
  const normalized = normalizeVersion(version);
  const match = releases.find((release) =>
    releaseTags(normalized).includes(release.tag_name)
  );
  if (!match) {
    throw new Error(`No ${repository} release found for version ${normalized}`);
  }
  return match;
}

async function downloadAsset(asset, destination) {
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "klapz-release-packager",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(asset.url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not download ${asset.name}: ${response.status}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  console.log(`Downloaded ${asset.name}`);
}

function normalizedName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function platformTokens(platform, arch) {
  const archTokens =
    arch === "arm64"
      ? ["arm64", "aarch64", "arm"]
      : ["x64", "x86_64", "amd64", "x86"];
  const platformTokens =
    platform === "win32"
      ? ["windows", "win32", "win"]
      : platform === "darwin"
        ? ["darwin", "macos", "osx", "mac"]
        : ["linux"];
  return { arch: archTokens, platform: platformTokens };
}

function scoreAsset(asset, platform, arch, component) {
  const name = normalizedName(asset.name);
  const tokens = platformTokens(platform, arch);
  let score = 0;
  if (component && name.includes(normalizedName(component))) score += 20;
  if (tokens.platform.some((token) => name.includes(token))) score += 40;
  if (tokens.arch.some((token) => name.includes(normalizedName(token)))) score += 40;
  if (asset.name.endsWith(".exe") && platform === "win32") score += 5;
  if (/(^|[.-])(zip|tar|tgz|gz|7z)$/.test(name)) score += 2;
  // The web release ships a -bundled (base /web/) and a -standalone (base /) build.
  if (component === "web" && name.includes("bundled")) score += 10;
  return score;
}

function pickAsset(release, platform, arch, component) {
  const assets = release.assets || [];
  if (!assets.length) throw new Error(`Release ${release.tag_name} has no assets`);
  const ranked = assets
    .map((asset) => ({ asset, score: scoreAsset(asset, platform, arch, component) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score === 0) {
    throw new Error(
      `Could not identify a ${component || "release"} asset for ${platform}/${arch}. ` +
        `Available assets: ${assets.map((asset) => asset.name).join(", ")}`
    );
  }
  return ranked[0].asset;
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === "win32") {
    // Windows' own bsdtar reads zip and tar.gz. Called by its full path: under a bash shell,
    // Git's GNU tar comes first on the PATH and takes `C:\...` for a remote `host:path`.
    const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFileSync(systemTar, ["-xf", archive, "-C", destination], { stdio: "inherit" });
  } else if (/\.zip$/i.test(archive)) {
    // GNU tar (Linux) cannot read zip files.
    execFileSync("unzip", ["-q", "-o", archive, "-d", destination], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: "inherit" });
  }
}

function findFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(fullPath));
    else found.push(fullPath);
  }
  return found;
}

function findExecutable(files, component, platform) {
  const suffix = platform === "win32" ? ".exe" : "";
  const candidates = files.filter((file) => {
    const name = path.basename(file).toLowerCase();
    return name === `${component}${suffix}` ||
      name.startsWith(`${component}-`) ||
      name.includes(component);
  });
  if (!candidates.length) {
    throw new Error(`Could not find ${component}${suffix} in downloaded release assets`);
  }
  return candidates[0];
}

function findWebRoot(directory) {
  const htmlFiles = findFiles(directory).filter((file) =>
    path.basename(file).toLowerCase() === "index.html"
  );
  if (htmlFiles.length) return path.dirname(htmlFiles[0]);

  const packageFiles = findFiles(directory).filter((file) =>
    path.basename(file).toLowerCase() === "package.json"
  );
  if (packageFiles.length) return path.dirname(packageFiles[0]);

  return directory;
}

async function prepareAsset(release, platform, arch, component, temporaryDir) {
  const asset = pickAsset(release, platform, arch, component);
  const assetPath = path.join(temporaryDir, asset.name);
  await downloadAsset(asset, assetPath);
  return { asset, assetPath };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  if (!args.version || !args.platform || !args.arch || !args.output) {
    usage();
    throw new Error("Missing required arguments");
  }

  const version = normalizeVersion(args.version);
  const versions = {
    ffmpeg: normalizeVersion(args["ffmpeg-version"] || version),
    web: normalizeVersion(args["web-version"] || version),
    server: normalizeVersion(args["server-version"] || version),
  };
  const output = path.resolve(args.output);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "klapz-release-"));
  try {
    const webRelease = await getRelease(REPOSITORIES.web, versions.web);
    const webAsset = await prepareAsset(webRelease, args.platform, args.arch, "web", temporaryDir);
    const webDir = path.join(output, "web");
    fs.mkdirSync(webDir, { recursive: true });
    if (/\.zip$/i.test(webAsset.asset.name) || /\.(tar\.gz|tgz)$/i.test(webAsset.asset.name)) {
      const extracted = path.join(temporaryDir, "web-extracted");
      extractArchive(webAsset.assetPath, extracted);
      const webRoot = findWebRoot(extracted);
      for (const entry of fs.readdirSync(webRoot, { withFileTypes: true })) {
        fs.cpSync(path.join(webRoot, entry.name), path.join(webDir, entry.name), {
          recursive: true,
        });
      }
    } else {
      throw new Error(`Unsupported web asset format: ${webAsset.asset.name}`);
    }

    const ffmpegRelease = await getRelease(REPOSITORIES.ffmpeg, versions.ffmpeg);
    const ffmpegAsset = await prepareAsset(ffmpegRelease, args.platform, args.arch, "ffmpeg", temporaryDir);
    let ffmpegExecutable = ffmpegAsset.assetPath;
    if (!/\.(exe|bin)$/i.test(ffmpegAsset.asset.name) &&
        !/(^|[.-])(linux|darwin|windows|win|arm64|x64|amd64|aarch64|x86)$/.test(normalizedName(ffmpegAsset.asset.name))) {
      const extracted = path.join(temporaryDir, "ffmpeg-extracted");
      extractArchive(ffmpegAsset.assetPath, extracted);
      ffmpegExecutable = findExecutable(findFiles(extracted), "ffmpeg", args.platform);
    } else if (/\.zip$|\.tar\.gz$|\.tgz$/i.test(ffmpegAsset.asset.name)) {
      const extracted = path.join(temporaryDir, "ffmpeg-extracted");
      extractArchive(ffmpegAsset.assetPath, extracted);
      ffmpegExecutable = findExecutable(findFiles(extracted), "ffmpeg", args.platform);
    }
    const ffmpegName = args.platform === "win32" ? "klapz-ffmpeg.exe" : "klapz-ffmpeg";
    fs.copyFileSync(ffmpegExecutable, path.join(output, ffmpegName));
    if (args.platform !== "win32") fs.chmodSync(path.join(output, ffmpegName), 0o755);

    const serverRelease = await getRelease(REPOSITORIES.server, versions.server);
    for (const component of ["server", "scanner"]) {
      const result = await prepareAsset(serverRelease, args.platform, args.arch, component, temporaryDir);
      let executable = result.assetPath;
      if (/\.zip$|\.tar\.gz$|\.tgz$/i.test(result.asset.name)) {
        const extracted = path.join(temporaryDir, `${component}-extracted`);
        extractArchive(result.assetPath, extracted);
        executable = findExecutable(findFiles(extracted), `klapz-${component}`, args.platform);
      }
      const name = args.platform === "win32"
        ? `klapz-${component}.exe`
        : `klapz-${component}`;
      fs.copyFileSync(executable, path.join(output, name));
      if (args.platform !== "win32") fs.chmodSync(path.join(output, name), 0o755);
    }

    console.log(`Package assembled at ${output}`);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

module.exports = { REPOSITORIES, normalizeVersion, githubJson, getRelease };

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
