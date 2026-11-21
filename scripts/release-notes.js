#!/usr/bin/env node
// Two steps of the release workflow:
//
//   resolve  Picks the version of each component (the latest release of its repository unless
//            one is given) and writes them to $GITHUB_OUTPUT, so that every package job and the
//            notes use the same ones even if a component releases during the run.
//
//   notes    Writes the release body: the version of each component and, for each one, the
//            commits since the version the previous Klapz release shipped. The previous versions
//            are read back from a hidden comment this script leaves in every body.
//
// Usage:
//   node scripts/release-notes.js resolve [--version X] [--ffmpeg-version X] [--web-version X] [--server-version X]
//   node scripts/release-notes.js notes --tag vX --ffmpeg-version X --web-version X --server-version X
//        [--existing-body <file>] --output <file>

const fs = require("node:fs");
const {
  REPOSITORIES,
  normalizeVersion,
  githubJson,
  getRelease,
} = require("./package-release");

const COMPONENTS = [
  { key: "server", title: "Klapz Server" },
  { key: "web", title: "Klapz Web" },
  { key: "ffmpeg", title: "Klapz FFmpeg" },
];
const MARKER = "klapz-components";
const START = "<!-- klapz-notes:start -->";
const END = "<!-- klapz-notes:end -->";
const API = "https://api.github.com";

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function setOutput(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function resolve(args) {
  // Klapz versions are dates by default (v2026-11-21); give one to release twice in a day.
  const version = normalizeVersion(args.version || new Date().toISOString().slice(0, 10));
  setOutput("version", version);
  setOutput("tag", `v${version}`);
  for (const { key } of COMPONENTS) {
    const given = args[`${key}-version`];
    const release = given
      ? await getRelease(REPOSITORIES[key], given)
      : await githubJson(`${API}/repos/${REPOSITORIES[key]}/releases/latest`);
    setOutput(key, normalizeVersion(release.tag_name));
  }
}

// The component versions the last published Klapz release shipped, read from its body.
async function previousRelease(currentTag) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) return null;
  const releases = await githubJson(`${API}/repos/${repository}/releases?per_page=50`);
  const previous = releases.find((r) => !r.draft && r.tag_name !== currentTag);
  if (!previous) return null;
  const match = (previous.body || "").match(new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`));
  return { release: previous, components: match ? JSON.parse(match[1]) : {} };
}

async function changelog(component, release, previousTag) {
  const repository = REPOSITORIES[component.key];
  const lines = [`### ${component.title} [${release.tag_name}](${release.html_url})`, ""];

  if (!previousTag) {
    lines.push("First Klapz release shipping this component.");
    return lines.join("\n");
  }
  if (previousTag === release.tag_name) {
    lines.push(`Unchanged since the previous release.`);
    return lines.join("\n");
  }

  const compare = await githubJson(
    `${API}/repos/${repository}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(release.tag_name)}`
  );
  const commits = compare.commits
    .filter((c) => c.parents.length < 2) // merge commits only repeat what they merge
    .reverse(); // newest first
  if (compare.status === "behind") {
    lines.push(`⚠️ Older than the previous release (${previousTag}).`);
  } else if (!commits.length) {
    lines.push(`No changes since ${previousTag}.`);
  } else {
    lines.push(`Since ${previousTag}:`, "");
    for (const commit of commits) {
      const subject = commit.commit.message.split("\n")[0];
      lines.push(`- ${subject} ([${commit.sha.slice(0, 7)}](${commit.html_url}))`);
    }
    if (compare.total_commits > compare.commits.length) {
      lines.push(`- … and ${compare.total_commits - compare.commits.length} more`);
    }
  }
  lines.push("", `[Full changelog](${compare.html_url})`);
  return lines.join("\n");
}

async function notes(args) {
  if (!args.tag || !args.output) throw new Error("notes needs --tag and --output");

  const releases = {};
  for (const { key } of COMPONENTS) {
    const version = args[`${key}-version`];
    if (!version) throw new Error(`notes needs --${key}-version`);
    releases[key] = await getRelease(REPOSITORIES[key], version);
  }
  const previous = await previousRelease(args.tag);

  const sections = [
    START,
    "## Components",
    "",
    "| Component | Version | Previous release |",
    "| --- | --- | --- |",
    ...COMPONENTS.map(({ key, title }) => {
      const release = releases[key];
      const before = previous?.components[key] || "—";
      return `| ${title} | [${release.tag_name}](${release.html_url}) | ${before} |`;
    }),
    "",
    previous
      ? `## Changes since [${previous.release.name || previous.release.tag_name}](${previous.release.html_url})`
      : "## Changes",
    "",
  ];
  for (const component of COMPONENTS) {
    sections.push(
      await changelog(component, releases[component.key], previous?.components[component.key]),
      ""
    );
  }
  const shipped = Object.fromEntries(COMPONENTS.map(({ key }) => [key, releases[key].tag_name]));
  sections.push(`<!-- ${MARKER} ${JSON.stringify(shipped)} -->`, END);
  const generated = sections.join("\n");

  // Keep what was written by hand in the draft around the generated part.
  let body = generated;
  if (args["existing-body"] && fs.existsSync(args["existing-body"])) {
    const existing = fs.readFileSync(args["existing-body"], "utf8").replace(/\r\n/g, "\n").trim();
    const start = existing.indexOf(START);
    const end = existing.indexOf(END);
    if (start !== -1 && end > start) {
      body = existing.slice(0, start) + generated + existing.slice(end + END.length);
    } else if (existing) {
      body = `${existing}\n\n${generated}`;
    }
  }
  fs.writeFileSync(args.output, body.trim() + "\n");
  console.log(body);
}

const args = parseArgs(process.argv);
const commands = { resolve, notes };
if (!commands[args.command]) {
  console.error("Usage: release-notes.js <resolve|notes> [options]");
  process.exit(1);
}
commands[args.command](args).catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
