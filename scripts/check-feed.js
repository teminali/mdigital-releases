#!/usr/bin/env node
// After a release is public, ask it the way an installed app would: run the app's own
// update check (desktop/updater.js from the source) against the real feed, once for
// every system we ship, as if an old version 0.0.0 were installed. Each one must be
// offered THIS release, with an installer for its system and the checksum file.
//
// usage: node check-feed.js --repo owner/name --tag desktop-vX.Y.Z --source <source dir>
//        [--attempts 6] [--wait-seconds 20]
// A freshly published release can take a moment to show in the API, so it retries.
// Set GITHUB_TOKEN to avoid the anonymous rate limit (a read-only token is enough).

const path = require('path');

const SYSTEMS = [
  { platform: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon' },
  { platform: 'darwin', arch: 'x64', label: 'macOS Intel' },
  { platform: 'win32', arch: 'x64', label: 'Windows' },
  { platform: 'linux', arch: 'x64', label: 'Linux' }
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

// Pure: turns one update-check answer into a list of problems (empty means good).
function problemsWith(answer, tag) {
  if (answer.error) return [answer.error];
  const problems = [];
  if (!answer.latest || answer.latest.tag !== tag) {
    problems.push(`the feed offers ${answer.latest ? answer.latest.tag : 'nothing'}, not ${tag}`);
  }
  if (!answer.updateAvailable) problems.push('it does not count as an update for version 0.0.0');
  if (!answer.asset) problems.push('no installer for this system');
  if (!answer.checksumAsset) problems.push('no SHA256SUMS.txt');
  return problems;
}

async function checkOnce({ repo, tag, source }) {
  const { checkForUpdate } = require(path.join(path.resolve(source), 'desktop', 'updater.js'));
  const token = process.env.GITHUB_TOKEN;
  const fetchImpl = (url, init = {}) => globalThis.fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  });
  const failures = [];
  for (const system of SYSTEMS) {
    const answer = await checkForUpdate({ currentVersion: '0.0.0', repo, platform: system.platform, arch: system.arch, fetchImpl });
    const problems = problemsWith(answer, tag);
    const line = problems.length
      ? `FAIL ${system.label}: ${problems.join('; ')}`
      : `ok   ${system.label}: ${answer.asset.name}`;
    console.log(line);
    if (problems.length) failures.push(line);
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.tag || !args.source) {
    console.error('usage: node check-feed.js --repo owner/name --tag desktop-vX.Y.Z --source <source dir>');
    return 2;
  }
  const attempts = Number(args.attempts || 6);
  const waitMs = Number(args['wait-seconds'] || 20) * 1000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`Feed check ${attempt} of ${attempts} for ${args.tag}`);
    const failures = await checkOnce({ repo: args.repo, tag: args.tag, source: args.source });
    if (!failures.length) return 0;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  console.error(`The feed still does not offer ${args.tag} correctly.`);
  return 1;
}

module.exports = { problemsWith, SYSTEMS };

if (require.main === module) main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
