import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const outputDir = join(process.cwd(), 'release-v25');
const files = readdirSync(outputDir)
  .map((name) => join(outputDir, name))
  .filter((file) => statSync(file).isFile())
  .filter((file) => !file.endsWith('checksums.txt') && !file.endsWith('provenance.json'));

const checksumLines = files.map((file) => {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${digest}  ${relative(outputDir, file)}`;
});
writeFileSync(join(outputDir, 'checksums.txt'), `${checksumLines.join('\n')}\n`, 'utf8');

writeFileSync(join(outputDir, 'provenance.json'), JSON.stringify({
  schema: 'https://slsa.dev/provenance/v1',
  repository: process.env.GITHUB_REPOSITORY ?? null,
  commit: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
  runner: process.env.RUNNER_OS ?? process.platform,
  generatedAt: new Date().toISOString(),
  artifacts: checksumLines,
}, null, 2), 'utf8');
