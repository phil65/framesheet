/** Duration detection and sample-time planning (port of timing.py). */

import type { AnimationTiming, DurationInfo } from "./models.js";
import { g, pyRound } from "./pyfmt.js";

export const FALLBACK_SECONDS = 3.0;
export const MAX_SECONDS = 60.0;
/** Use the LCM of loop periods only if it is at most this many times the longest period. */
export const LCM_FACTOR = 4;
/** One 60 fps frame: the last tile and the loop probe sit this far before the cycle end. */
export const EPSILON = 1 / 60;

/** Normalise raw runtime output (`window.__framesheet.timings()`) to full records. */
export function parseTimings(raw: unknown[]): AnimationTiming[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      kind: r.kind as AnimationTiming["kind"],
      target: (r.target as string | null | undefined) ?? null,
      name: (r.name as string | null | undefined) ?? null,
      start: Number(r.start),
      duration: Number(r.duration),
      iterations: r.iterations == null ? null : Number(r.iterations),
      direction: (r.direction as string | undefined) ?? "normal",
      period: Number(r.period),
      end: r.end == null ? null : Number(r.end),
      transform_box: (r.transform_box as string | null | undefined) ?? null,
    };
  });
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(periods: number[]): number {
  const ticks = periods.map((p) => Math.max(1, pyRound(p * 100))); // 10 ms resolution
  return ticks.reduce((a, b) => (a / gcd(a, b)) * b) / 100;
}

/**
 * Pick the time span to sample.
 *
 * - Infinite animations contribute their loop period (`duration`, doubled for
 *   `alternate`). Several periods are combined with their least common multiple if that
 *   stays reasonable, otherwise the longest period wins.
 * - A positive start (`begin`/`delay`) of a looping animation is added, so the warm-up
 *   before the first iteration is visible.
 * - Finite animations contribute their end time (delay + duration x iterations).
 */
export function detectDuration(animations: AnimationTiming[], override?: number | null): DurationInfo {
  const infinite = animations.filter((a) => a.iterations === null);
  const finite = animations.filter((a) => a.iterations !== null && a.end !== null);
  const looping = infinite.length > 0;
  if (override != null) {
    return {
      seconds: override,
      method: "override",
      looping,
      detail: `--duration ${g(override)}s`,
      animations,
    };
  }
  if (animations.length === 0) {
    return {
      seconds: FALLBACK_SECONDS,
      method: "fallback",
      looping: false,
      detail:
        `no SMIL/CSS/Web Animations found; sampled the ${g(FALLBACK_SECONDS)}s ` +
        "fallback (pass --duration for JS-driven animation)",
      animations: [],
    };
  }
  const parts: string[] = [];
  let seconds = 0;
  if (infinite.length) {
    const periods = [...new Set(infinite.map((a) => pyRound(a.period, 3)))].sort((a, b) => a - b);
    let cycle = lcm(periods);
    const longest = periods[periods.length - 1];
    const list = periods.map((p) => `${g(p)}s`).join(", ");
    if (periods.length === 1) {
      parts.push(`loop period ${g(periods[0])}s`);
    } else if (cycle <= LCM_FACTOR * longest && cycle <= MAX_SECONDS) {
      parts.push(`LCM of loop periods ${list}`);
    } else {
      cycle = longest;
      parts.push(`longest of loop periods ${list} (no short common multiple)`);
    }
    seconds = cycle;
    const warmup = Math.max(Math.max(...infinite.map((a) => a.start)), 0);
    if (warmup > 0) {
      seconds = Math.max(seconds, warmup + cycle);
      parts.push(`+ ${g(warmup)}s positive begin/delay before the first loop`);
    }
  }
  if (finite.length) {
    const lastEnd = Math.max(...finite.map((a) => a.end ?? 0));
    if (lastEnd > seconds) {
      seconds = lastEnd;
      parts.push(`finite animations end at ${g(lastEnd)}s`);
    }
  }
  const kinds = [...new Set(animations.map((a) => a.kind))].sort();
  let detail = `${parts.join("; ")} (${animations.length} animation(s): ${kinds.join(", ")})`;
  if (seconds > MAX_SECONDS) {
    detail += `; capped at ${g(MAX_SECONDS)}s`;
    seconds = MAX_SECONDS;
  }
  if (seconds <= 0) {
    seconds = FALLBACK_SECONDS;
    detail += `; zero-length, using ${g(FALLBACK_SECONDS)}s`;
  }
  return { seconds: pyRound(seconds, 3), method: "detected", looping, detail, animations };
}

/** The probe offset for loop checks: one 60 fps frame, or 1% of very short cycles. */
export function epsilon(duration: number): number {
  return Math.min(EPSILON, duration / 100);
}

/**
 * Evenly spaced times over `[0, duration]`. The last sample is one 60 fps frame *before*
 * the end: at exactly `t=end` an infinite animation has already wrapped to its first
 * frame, which would make every loop look seamless.
 */
export function sampleTimes(duration: number, frames: number): number[] {
  if (frames < 2) return [0];
  const times = Array.from({ length: frames }, (_, i) => pyRound((duration * i) / (frames - 1), 4));
  times[times.length - 1] = pyRound(duration - epsilon(duration), 4);
  return times;
}
