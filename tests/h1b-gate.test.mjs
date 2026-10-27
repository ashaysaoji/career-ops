// tests/h1b-gate.test.mjs — H-1B sponsorship gate over the pending pipeline.
//
// Exercises the pure functions with an injected lookup, so no index, network or
// plugin install is needed.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nh1b-gate — screen pending pipeline by sponsorship tier');

try {
  const { parsePending, verdictFor, screenPipeline, DEFAULT_KEEP } =
    await import(pathToFileURL(join(ROOT, 'h1b-gate.mjs')).href);
  const check = (label, cond) => (cond ? pass(label) : fail(label));

  const p = parsePending('- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme Corp | Java Developer | Seattle, WA');
  check('parses url and company from a pending line', p?.url.endsWith('/jobs/1') && p.company === 'Acme Corp');
  check('ignores processed lines', parsePending('- [x] #012 | https://x.test/1 | Acme | Role | 4.1/5 | PDF ✅') === null);
  check('ignores lines with no url', parsePending('- [ ] just a note') === null);

  check('strong is kept', verdictFor({ friendlinessTier: 'strong' }).verdict === 'keep');
  check('staffing-shop is kept by default', verdictFor({ friendlinessTier: 'staffing-shop' }).verdict === 'keep');
  check('none is dropped', verdictFor({ friendlinessTier: 'none' }).verdict === 'drop');
  check('weak is dropped', verdictFor({ friendlinessTier: 'weak' }).verdict === 'drop');
  check('unknown is kept, never dropped', verdictFor({ friendlinessTier: 'unknown' }).verdict === 'unknown');
  check('failed lookup (null) is unknown', verdictFor(null).verdict === 'unknown');
  check('--keep narrows the set', verdictFor({ friendlinessTier: 'staffing-shop' }, ['strong']).verdict === 'drop');
  check('default keep set', DEFAULT_KEEP.join() === 'strong,moderate,staffing-shop');

  const tiers = { 'Acme Corp': 'strong', 'Nobody Inc': 'none', 'Mystery Co': 'unknown' };
  const calls = [];
  const lookup = c => { calls.push(c); return { friendlinessTier: tiers[c], displayName: c }; };
  const input = [
    '# Pipeline', '## Pending',
    '- [ ] https://a.test/1 | Acme Corp | Java Developer',
    '- [ ] https://a.test/2 | Acme Corp | Backend Engineer',
    '- [ ] https://n.test/1 | Nobody Inc | Software Engineer',
    '- [ ] https://m.test/1 | Mystery Co | SDE',
    '## Processed',
    '- [x] #001 | https://p.test/1 | Nobody Inc | Role | 3.0/5 | PDF ❌',
  ].join('\n');
  const r = screenPipeline(input, lookup);
  const lines = r.text.split('\n');
  check('one lookup per distinct employer', calls.length === 3);
  check('kept entries are untouched', lines[2] === input.split('\n')[2] && lines[3] === input.split('\n')[3]);
  check('dropped entry is struck through with its tier', lines[4] === '- [x] ~~https://n.test/1 | Nobody Inc | Software Engineer~~ — h1b gate: tier none');
  check('unknown employer entry is untouched', lines[5] === input.split('\n')[5]);
  check('processed section is untouched', lines[7] === input.split('\n')[7]);
  check('exactly one entry dropped', r.dropped.length === 1 && r.dropped[0].company === 'Nobody Inc');
  check('re-running on its own output drops nothing more', screenPipeline(r.text, lookup).dropped.length === 0);
} catch (err) {
  fail(`h1b-gate test crashed: ${err.message}`);
}
