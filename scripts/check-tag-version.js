#!/usr/bin/env node
// A release tag must be exactly vX.Y.Z and must match the version in package.json at
// that tag. Without this a tag on the wrong commit builds, signs off and publishes
// an installer whose name and number disagree with the tag the app updates from.
//
// usage: node check-tag-version.js <tag> <path to package.json>
// Prints the version (X.Y.Z) on success. Exits 1 with a reason on failure.

const fs = require('fs');

const TAG_SHAPE = /^v(\d+)\.(\d+)\.(\d+)$/;

// Returns { ok: true, version } or { ok: false, error }.
function tagMatchesVersion(tag, packageVersion) {
  const m = TAG_SHAPE.exec(String(tag || ''));
  if (!m) return { ok: false, error: `"${tag}" is not a release tag like v0.0.4.` };
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  if (packageVersion !== version) {
    return {
      ok: false,
      error: `Tag ${tag} says ${version} but package.json at that tag says ${packageVersion || '(nothing)'}. ` +
        'Bump the version in the release commit, then tag that commit.'
    };
  }
  return { ok: true, version };
}

function main(argv) {
  const [tag, packageJsonPath] = argv;
  if (!tag || !packageJsonPath) {
    console.error('usage: node check-tag-version.js <tag> <path to package.json>');
    return 2;
  }
  let packageVersion = null;
  try {
    packageVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  } catch (error) {
    console.error(`Could not read ${packageJsonPath}: ${error.message}`);
    return 1;
  }
  const result = tagMatchesVersion(tag, packageVersion);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(result.version);
  return 0;
}

module.exports = { tagMatchesVersion };

if (require.main === module) process.exit(main(process.argv.slice(2)));
