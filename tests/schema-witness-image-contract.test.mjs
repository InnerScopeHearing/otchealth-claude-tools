import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('diagnostic image pins the public RDS trust bundle and loads it before Node starts', () => {
  const source = readFileSync(new URL('../skills/doc-indexer/job/Dockerfile', import.meta.url), 'utf8');
  const instructions = source.replace(/\\\n\s*/g, ' ').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const bundle = instructions.filter(x => /^ADD\b/.test(x) && x.includes('rds-global-bundle.pem'));
  assert.deepEqual(bundle, ['ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem']);
  const trustEnv = instructions.filter(x => /^ENV\b/.test(x) && x.includes('NODE_EXTRA_CA_CERTS'));
  assert.deepEqual(trustEnv, ['ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem']);
  assert.ok(instructions.indexOf(bundle[0]) < instructions.indexOf(trustEnv[0]));
  assert.ok(instructions.indexOf(trustEnv[0]) < instructions.findIndex(x => /^ENTRYPOINT\b/.test(x)));
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/);
});
