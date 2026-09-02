import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { executableLines } from './workflow-lines';

/**
 * The published image has no `USER` directive by design: docker-entrypoint.sh starts as root to fix
 * named-volume ownership and then drops via `exec gosu openwa`. That drop is the only thing keeping
 * an internet-facing Node process (and its Chromium subprocess) off uid 0, and
 * `scripts/smoke-test-non-root.sh` is the only check of it.
 *
 * The script existed but no workflow ran it — its sole appearance in ci.yml was inside a comment
 * explaining why shellcheck names it. A change that left the process as root therefore passed lint,
 * every test job, the multi-arch build, the boot smoke and the image scan, and was promoted to
 * `latest`. These pin that the script is INVOKED, because a mention is not a gate.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Step = { name?: string; run?: string; uses?: string; with?: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflowOf(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
}

function runCommandsOf(file: string): string[] {
  return Object.values(workflowOf(file).jobs ?? {}).flatMap(job =>
    (job.steps ?? []).map(step => executableLines(step.run ?? '')),
  );
}

/**
 * Jobs that execute a repo-relative path, paired with whether the job ever checks the repo out.
 *
 * Both spellings count: `./scripts/x.sh` and the bare `scripts/x.sh` an interpreter is handed
 * (`bash scripts/x.sh`). Matching only the dotted form would leave the gate blind to the other way
 * of writing the very call it exists to protect.
 */
function jobsRunningRepoScripts(file: string): Array<{ job: string; scripts: string[]; hasCheckout: boolean }> {
  const REPO_PATH = /(?:^|[\s'"])(\.\/[\w./-]+|(?:scripts|bin|tools)\/[\w./-]+)/g;
  return Object.entries(workflowOf(file).jobs ?? {})
    .map(([job, def]) => {
      const steps = def.steps ?? [];
      const scripts = steps.flatMap(step => [...(step.run ?? '').matchAll(REPO_PATH)].map(m => m[1]));
      return { job, scripts, hasCheckout: steps.some(step => (step.uses ?? '').startsWith('actions/checkout')) };
    })
    .filter(entry => entry.scripts.length > 0);
}

describe('the non-root drop is enforced, not merely documented', () => {
  // A `run:` extractor that silently matched nothing would make every assertion below vacuously
  // pass. Anchor it on a script the workflows have always invoked.
  it('extracts run commands from the workflows', () => {
    expect(runCommandsOf('ci.yml').join('\n')).toContain('smoke-test-backup-restore.sh');
  });

  // The extractor's own defect, pinned: a mention is not an invocation. Disabling a step by commenting
  // it out is the exact shape that let the script go unrun while this file reported it enforced.
  it('does not count a commented-out invocation as running the script', () => {
    expect(executableLines('# ./scripts/smoke-test-non-root.sh\necho skipped')).not.toContain('smoke-test-non-root.sh');
    expect(executableLines('  OPENWA_SMOKE_IMAGE="$IMAGE" ./scripts/smoke-test-non-root.sh # run it')).toContain(
      'smoke-test-non-root.sh',
    );
    // A '#' inside a quoted string is data; truncating there would drop a real command.
    expect(executableLines('echo "tag #1" && ./scripts/smoke-test-non-root.sh')).toContain('smoke-test-non-root.sh');
  });

  // BOTH paths. The tag path is the one that promotes to `latest`, so a check present only on the PR
  // path leaves the publishing route unguarded — the asymmetry this workflow's own audit step forbids.
  it.each(['ci.yml', 'release.yml'])('invokes the non-root smoke test from %s', file => {
    const invocations = runCommandsOf(file).filter(run => run.includes('smoke-test-non-root.sh'));
    expect(invocations.length).toBeGreaterThan(0);
  });

  // The Dockerfile relies on the entrypoint's gosu drop rather than a USER directive. If that ever
  // changes to a real USER line the smoke test still passes, but this records WHY the directive is
  // absent, so its absence is never read as an oversight and "fixed" by deleting the drop.
  it('keeps the entrypoint gosu drop the image depends on', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    expect(entrypoint).toMatch(/exec\s+gosu\s+openwa/);
  });
});

/**
 * Invoking the script is not the same as being able to run it. `boot-smoke` in release.yml called
 * `./scripts/smoke-test-non-root.sh` from a job that never checks the repo out — the file is simply
 * absent from the workspace, so the step exits 127 and the ONLY path that publishes `latest` fails
 * at every tag. Fail-closed, but the release path was broken rather than guarded.
 *
 * The gate above could not see it: it binds the text of `run:`, and the text was correct. This binds
 * the precondition instead, for every job in every workflow — a repo-relative command needs the repo.
 */
describe('a job that runs a repo script checks the repo out', () => {
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  // Non-vacuity control: the finder must actually see jobs, or every assertion below passes on an
  // empty set. Anchor on a workflow known to run repo scripts.
  it('finds jobs that run repo-relative scripts', () => {
    expect(workflows.length).toBeGreaterThan(0);
    const all = workflows.flatMap(f => jobsRunningRepoScripts(f));
    expect(all.length).toBeGreaterThan(0);
    expect(all.some(e => e.scripts.some(s => s.includes('scripts/')))).toBe(true);
  });

  it.each(workflows)('%s: every job running ./… also runs actions/checkout', file => {
    const offenders = jobsRunningRepoScripts(file)
      .filter(entry => !entry.hasCheckout)
      .map(entry => `${entry.job} runs ${entry.scripts.join(', ')} without actions/checkout`);
    expect(offenders).toEqual([]);
  });
});
