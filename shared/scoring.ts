import type { ScoreCalculation, ScoreInput } from './score-contracts.ts';

// All quantities and weights are integers. Rational arithmetic avoids both floating
// point boundary errors and rounding each task before adding its contribution.
type Fraction = [bigint, bigint];
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }
function fraction(n: bigint, d: bigint): Fraction { const g = gcd(n, d); return [n / g, d / g]; }
function add(a: Fraction, b: Fraction): Fraction { return fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
function rounded(value: Fraction, scale: bigint): number { return Number((2n * value[0] * scale + value[1]) / (2n * value[1])); }
function display(value: Fraction): string { const tenths = rounded(value, 10n); return tenths % 10 ? (tenths / 10).toFixed(1) : String(tenths / 10); }

export function calculateScore(input: ScoreInput): ScoreCalculation {
  const plan = input.plan;
  const tasks = plan?.tasks.filter(task => plan.dimensions[task.scoring_dimension].applicable && task.raw_points > 0) ?? [];
  const denominator = tasks.reduce((sum, task) => sum + task.raw_points, 0);
  const reason = !plan ? 'unplanned' : plan.day_mode === 'rest' ? 'rest' : !denominator ? 'no_eligible_tasks' : null;
  if (reason) return { status: 'not_applicable', reason, final_score: null, lower_bound: null, upper_bound: null, coverage_basis_points: null, display: { lower: '—', upper: '—', coverage: '—', final: '—' }, denominator: 0, missing_task_ids: [], tasks: [] };
  let earned: Fraction = [0n, 1n];
  let knownWeight = 0;
  const missing: string[] = [];
  const breakdown = tasks.map(task => {
    const result = input.results.find(item => item.task_id === task.task_id)?.result ?? null;
    const target = task.result_type === 'binary' ? 1 : task.target_value!;
    if (!Number.isSafeInteger(target) || target <= 0) throw new Error('Invalid frozen scoring target');
    const actual = result?.actual_value ?? null;
    const ratio: Fraction = actual === null ? [0n, 1n] : fraction(BigInt(Math.min(target, Math.max(0, actual))), BigInt(target));
    const contribution: Fraction = fraction(100n * BigInt(task.raw_points) * ratio[0], BigInt(denominator) * ratio[1]);
    if (result) { knownWeight += task.raw_points; earned = add(earned, contribution); }
    else missing.push(task.task_id);
    return { task_id: task.task_id, title: task.title, project_name: task.project_name, dimension: task.scoring_dimension, weight: task.raw_points, actual, target, contribution: actual === null ? '未知' : display(contribution), completion: actual === null ? '未知' : `${display([100n * ratio[0], ratio[1]])}%`, evidence_event_ids: result?.evidence_event_ids ?? [] };
  });
  const upper = add(earned, [100n * BigInt(denominator - knownWeight), BigInt(denominator)]);
  const coverage: Fraction = [100n * BigInt(knownWeight), BigInt(denominator)];
  const finalized = !missing.length && input.record_state === 'complete';
  return { status: finalized ? 'finalized' : 'provisional', reason: null, final_score: finalized ? rounded(earned, 100n) : null, lower_bound: rounded(earned, 100n), upper_bound: rounded(upper, 100n), coverage_basis_points: rounded(coverage, 100n), display: { lower: display(earned), upper: display(upper), coverage: display(coverage), final: finalized ? display(earned) : '—' }, denominator, missing_task_ids: missing, tasks: breakdown };
}
