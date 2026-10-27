#!/usr/bin/env node
/**
 * h1b-gate.mjs — screen the pending pipeline by employer H-1B sponsorship history
 *
 * The h1b-sponsor plugin answers one employer at a time, inside an evaluation,
 * after the tokens are already spent. This runs it over every pending entry in
 * data/pipeline.md first, so employers with no sponsorship record never reach
 * evaluation. Lookups go through plugins/h1b-sponsor/check.mjs, so the local
 * index and the per-company cache apply; nothing leaves the machine unless
 * H1B_API_BASE is set.
 *
 * Verdicts, per employer tier:
 *   keep    — in --keep (default: strong,moderate,staffing-shop)
 *   drop    — any other resolved tier (weak, none)
 *   unknown — name did not resolve to a filer, or the lookup failed. Kept:
 *             DOL names are messy and a brand rarely equals its legal entity,
 *             so an unresolved name is not evidence of no sponsorship.
 *
 * Read-only unless --apply. With --apply a dropped entry is struck through in
 * place (`- [x] ~~…~~ — h1b gate: tier none`, the shape the liveness sweep
 * uses), stays in pipeline.md so the scanner keeps deduping it, and is logged
 * to data/discard.log.
 *
 * Run: node h1b-gate.mjs [--apply] [--keep strong,moderate] [--json]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'plugins/h1b-sponsor/check.mjs');
const URL_RE = /^https?:\/\/\S+$/;
const PENDING_RE = /^- \[ \] (.*)$/;

export const DEFAULT_KEEP = ['strong', 'moderate', 'staffing-shop'];

/**
 * Parse a pending pipeline line into its URL and company.
 * Company is the cell after the URL cell, as in `- [ ] {url} | {company} | {role}`.
 * @returns {{url: string, company: string, body: string}|null}
 */
export function parsePending(line) {
  const m = line.match(PENDING_RE);
  if (!m) return null;
  const cells = m[1].split('|').map(c => c.trim());
  const urlIndex = cells.findIndex(c => URL_RE.test(c));
  if (urlIndex === -1) return null;
  const company = cells[urlIndex + 1] ?? '';
  return { url: cells[urlIndex], company, body: m[1].trim() };
}

/** Decide what to do with one employer given its lookup result. */
export function verdictFor(result, keep = DEFAULT_KEEP) {
  const tier = result?.friendlinessTier;
  if (!result || !tier || tier === 'unknown') return { verdict: 'unknown', tier: 'unknown' };
  return { verdict: keep.includes(tier) ? 'keep' : 'drop', tier };
}

/** Look one employer up through the plugin CLI. Never throws: failure is `unknown`. */
export function lookupViaPlugin(company) {
  try {
    const out = execFileSync(process.execPath, [CHECK, company, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch (err) {
    // check.mjs exits non-zero with the JSON on stdout when it has no index.
    try { return JSON.parse(err.stdout ?? ''); } catch { return null; }
  }
}

/**
 * Screen pipeline text. Pure: takes the text and a lookup, returns the rewritten
 * text plus one row per distinct employer.
 */
export function screenPipeline(text, lookup, { keep = DEFAULT_KEEP } = {}) {
  const lines = text.split('\n');
  const byCompany = new Map();
  const dropped = [];

  for (const line of lines) {
    const entry = parsePending(line);
    if (!entry || !entry.company) continue;
    const key = entry.company.toLowerCase();
    if (!byCompany.has(key)) {
      const result = lookup(entry.company);
      byCompany.set(key, {
        company: entry.company,
        displayName: result?.displayName ?? null,
        ...verdictFor(result, keep),
        postings: 0,
      });
    }
    byCompany.get(key).postings += 1;
  }

  const out = lines.map(line => {
    const entry = parsePending(line);
    if (!entry || !entry.company) return line;
    const row = byCompany.get(entry.company.toLowerCase());
    if (row.verdict !== 'drop') return line;
    dropped.push({ url: entry.url, company: entry.company, tier: row.tier });
    return `- [x] ~~${entry.body}~~ — h1b gate: tier ${row.tier}`;
  });

  return { text: out.join('\n'), employers: [...byCompany.values()], dropped };
}

function parseArgs(argv) {
  const args = { apply: false, json: false, keep: DEFAULT_KEEP };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--keep') args.keep = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = getCareerOpsRoot();
  const pipelinePath = process.env.CAREER_OPS_PIPELINE || join(root, 'data/pipeline.md');
  if (!existsSync(pipelinePath)) {
    console.error(`No pipeline at ${pipelinePath}. Run a scan first.`);
    process.exit(1);
  }

  const run = () => screenPipeline(readFileSync(pipelinePath, 'utf8'), lookupViaPlugin, { keep: args.keep });
  let result;
  if (args.apply) {
    await withPipelineLock(pipelinePath, () => {
      result = run();
      if (result.dropped.length) {
        writeFileSync(pipelinePath, result.text);
        const log = join(root, 'data/discard.log');
        mkdirSync(dirname(log), { recursive: true });
        const now = new Date().toISOString();
        appendFileSync(log, result.dropped.map(d => `${now}\t${d.url}\th1b_gate: tier ${d.tier} (${d.company})\n`).join(''));
      }
    });
  } else {
    result = run();
  }

  if (args.json) {
    console.log(JSON.stringify({ applied: args.apply, employers: result.employers, dropped: result.dropped }, null, 2));
    return;
  }
  const count = v => result.employers.filter(e => e.verdict === v).length;
  console.log(`H-1B gate: ${result.employers.length} employers — keep ${count('keep')}, unknown ${count('unknown')} (kept), drop ${count('drop')}`);
  for (const e of result.employers.filter(e => e.verdict === 'drop')) {
    console.log(`  drop  ${e.company} (${e.postings}) tier ${e.tier}`);
  }
  for (const e of result.employers.filter(e => e.verdict === 'unknown')) {
    console.log(`  check ${e.company} (${e.postings}) unresolved — verify by hand`);
  }
  console.log(args.apply ? `Struck ${result.dropped.length} entries; logged to data/discard.log.` : 'Dry run. Re-run with --apply to strike dropped entries.');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
