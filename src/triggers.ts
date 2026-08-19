/**
 * Trigger parsing and run-frequency estimation.
 *
 * Cost per run is only half of a cost estimate; the other half is how often a
 * workflow runs. Applying a flat "pushes per day" to every workflow bills a
 * weekly cron as if it fired ten times a day, which on a real repository
 * reported ninety-eight dollars a month against a true figure of about two.
 *
 * The trigger is already in the YAML being parsed, so it is read here.
 */

export interface WorkflowTriggers {
  /** Cron expressions from the schedule: trigger. */
  crons: string[];
  /** Any of push, pull_request, pull_request_target. */
  hasPushLike: boolean;
  /** Only manual or unpredictable triggers such as workflow_dispatch. */
  manualOnly: boolean;
  /** Trigger names as written, for reporting. */
  names: string[];
}

const PUSH_LIKE = new Set(["push", "pull_request", "pull_request_target"]);

/** Triggers that fire on a cadence nobody can predict from the YAML alone. */
const UNPREDICTABLE = new Set([
  "workflow_dispatch",
  "workflow_call",
  "repository_dispatch",
]);

/**
 * Parse the top-level `on:` block.
 *
 * Handles the three forms GitHub accepts: a scalar (`on: push`), a flow
 * sequence (`on: [push, pull_request]`), and a block mapping with nested keys.
 */
export function parseTriggers(content: string): WorkflowTriggers {
  const lines = content.split("\n");
  const names: string[] = [];
  const crons: string[] = [];

  let inOnBlock = false;
  let onIndent = 0;
  // Indent of the first trigger key inside the on: block. Local, so parsing one
  // workflow cannot affect the next.
  let triggerIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inOnBlock) {
      // `on:` at column 0. Quoted forms appear because YAML 1.1 reads a bare
      // `on` as boolean true, so some workflows write "on" or 'on'.
      const m = /^(?:on|"on"|'on'|true):\s*(.*)$/.exec(trimmed);
      if (!m || indent !== 0) continue;

      inOnBlock = true;
      onIndent = indent;
      const inline = m[1].trim();

      if (inline.startsWith("[")) {
        for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
          const name = part.trim().replace(/^['"]|['"]$/g, "");
          if (name) names.push(name);
        }
        inOnBlock = false;
      } else if (inline) {
        names.push(inline.replace(/^['"]|['"]$/g, ""));
        inOnBlock = false;
      }
      continue;
    }

    // Inside the on: block until a line returns to its indent level or less.
    if (indent <= onIndent) break;

    const cron = /^-\s*cron:\s*(.+)$/.exec(trimmed);
    if (cron) {
      crons.push(cron[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }

    // A trigger name is a key at the first level inside on:. Nested keys such
    // as branches: or paths: sit deeper and must not be read as triggers.
    const key = /^([a-z_]+):/.exec(trimmed);
    if (key) {
      if (triggerIndent === null) triggerIndent = indent;
      if (indent === triggerIndent && !names.includes(key[1])) {
        names.push(key[1]);
      }
    }
  }

  const hasPushLike = names.some((n) => PUSH_LIKE.has(n));
  const scheduled = crons.length > 0;
  const manualOnly =
    !hasPushLike &&
    !scheduled &&
    names.length > 0 &&
    names.every((n) => UNPREDICTABLE.has(n));

  return { crons, hasPushLike, manualOnly, names };
}

/** Expand one cron field into the set of values it matches. */
function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const step = /^(.+)\/(\d+)$/.exec(part);
    const body = step ? step[1] : part;
    const stride = step ? parseInt(step[2], 10) : 1;
    if (stride <= 0) continue;

    let lo = min;
    let hi = max;
    if (body !== "*") {
      const range = /^(\d+)-(\d+)$/.exec(body);
      if (range) {
        lo = parseInt(range[1], 10);
        hi = parseInt(range[2], 10);
      } else if (/^\d+$/.test(body)) {
        lo = hi = parseInt(body, 10);
      } else {
        continue;
      }
    }
    for (let v = lo; v <= hi; v += stride) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return [...out];
}

const DAYS_PER_MONTH = 30.44;

/**
 * Approximate how many times a cron expression fires per day.
 *
 * Exact for the common shapes: hourly, daily, weekly, monthly and every-N
 * minutes. Day-of-month and day-of-week are ORed by cron when both are
 * restricted, which is approximated by taking the more frequent of the two.
 */
export function cronRunsPerDay(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return 0;

  const [minute, hour, dom, month, dow] = fields;

  const minutes = expandField(minute, 0, 59).length;
  const hours = expandField(hour, 0, 23).length;
  if (minutes === 0 || hours === 0) return 0;

  const domRestricted = dom.trim() !== "*";
  const dowRestricted = dow.trim() !== "*";

  let dayFactor: number;
  if (!domRestricted && !dowRestricted) {
    dayFactor = 1;
  } else if (domRestricted && !dowRestricted) {
    dayFactor = expandField(dom, 1, 31).length / DAYS_PER_MONTH;
  } else if (!domRestricted && dowRestricted) {
    dayFactor = expandField(dow, 0, 6).length / 7;
  } else {
    // Cron ORs the two, so the schedule fires at least as often as the looser.
    dayFactor = Math.max(
      expandField(dom, 1, 31).length / DAYS_PER_MONTH,
      expandField(dow, 0, 6).length / 7
    );
  }

  const monthFactor =
    month.trim() === "*" ? 1 : expandField(month, 1, 12).length / 12;

  return minutes * hours * dayFactor * monthFactor;
}

export interface FrequencyEstimate {
  runsPerDay: number;
  /** Short description of where the number came from, for the report. */
  basis: string;
}

/**
 * Runs per day for a whole workflow, combining every trigger it declares.
 *
 * `pushesPerDay` is only applied to push-like triggers, which is what the flag
 * was always meant to describe.
 */
export function estimateRunsPerDay(
  triggers: WorkflowTriggers,
  pushesPerDay: number
): FrequencyEstimate {
  const parts: string[] = [];
  let total = 0;

  if (triggers.hasPushLike) {
    total += pushesPerDay;
    parts.push(`${pushesPerDay}/day from push`);
  }

  if (triggers.crons.length > 0) {
    const scheduled = triggers.crons.reduce(
      (sum, c) => sum + cronRunsPerDay(c),
      0
    );
    total += scheduled;
    parts.push(`${formatRate(scheduled)} from schedule`);
  }

  if (total === 0) {
    // Manual or unpredictable triggers only. Reporting a per-run cost is
    // honest here; inventing a frequency is not.
    return {
      runsPerDay: 0,
      basis: triggers.manualOnly ? "manual trigger only" : "no known cadence",
    };
  }

  return { runsPerDay: total, basis: parts.join(" + ") };
}

function formatRate(perDay: number): string {
  if (perDay >= 1) return `${Math.round(perDay * 10) / 10}/day`;
  const perWeek = perDay * 7;
  if (perWeek >= 1) return `${Math.round(perWeek * 10) / 10}/week`;
  return `${Math.round(perDay * DAYS_PER_MONTH * 10) / 10}/month`;
}
