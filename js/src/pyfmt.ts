/**
 * Number rounding/formatting with Python semantics, so reports and summaries match the
 * Python implementation (`round(x, n)`, `f"{x:.2f}"`, `f"{x:g}"`, `f"{x:.1%}"`).
 *
 * Python rounds the exact binary value half-to-even; JavaScript's `toFixed` rounds ties
 * away from zero. Ties only matter for exactly representable halves (0.125, 2.5, ...).
 */

/** Exact decimal expansion digits after the point (enough for |x| >= 1e-30). */
function isExactTie(x: number, digits: number): boolean {
  const s = Math.abs(x).toFixed(Math.min(100, digits + 60));
  const frac = s.split(".")[1] ?? "";
  const rest = frac.slice(digits);
  return rest.length > 0 && rest[0] === "5" && /^50*$/.test(rest);
}

/** Python's `round(x, digits)` (half to even on the exact value). */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (isExactTie(x, digits)) {
    const factor = 10 ** digits;
    const down = Math.trunc(Math.abs(x) * factor);
    const even = down % 2 === 0 ? down : down + 1;
    const out = (Math.sign(x) * even) / factor;
    return Object.is(out, -0) ? 0 : out;
  }
  const out = Number(x.toFixed(digits));
  return Object.is(out, -0) ? 0 : out;
}

/** Python's `f"{x:.{digits}f}"`. */
export function fixed(x: number, digits: number): string {
  return pyRound(x, digits).toFixed(digits);
}

/** Python's `f"{x:g}"` (6 significant digits, trailing zeros stripped). */
export function g(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const precision = 6;
  const [mantissa, expPart] = x.toExponential(precision - 1).split("e");
  const exp = Number(expPart);
  if (exp < -4 || exp >= precision) {
    const m = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
    const sign = exp < 0 ? "-" : "+";
    return `${m}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = fixed(x, Math.max(0, precision - 1 - exp));
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Python's `f"{x:.{digits}%}"`. */
export function pct(x: number, digits: number): string {
  return `${fixed(x * 100, digits)}%`;
}
