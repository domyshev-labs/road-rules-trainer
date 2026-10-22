import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function nextVersion(versions) {
  const parsed = versions.map(value => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)).filter(Boolean)
    .map(match => match.slice(1).map(Number)).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  if (!parsed.length) throw new Error('No valid version baseline');
  return `${parsed[0][0]}.${parsed[0][1] + 1}.0`;
}
if (process.argv[1] === '-' || process.argv[1]?.endsWith('/next-release.mjs')) {
  const tags = (process.env.RELEASE_TAGS !== undefined ? process.env.RELEASE_TAGS : execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })).trim().split('\n');
  const baseline = process.env.BASE_VERSION || JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  console.log(nextVersion([baseline, ...tags]));
}
