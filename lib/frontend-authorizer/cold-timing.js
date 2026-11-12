// ---------------------------------------------------------------------------
// COLD-START STEP TIMER.
//
// The first invocation of a sandbox is much slower than its module load
// explains, and the REPORT line only gives the total. This writes ONE line —
// `cold_start_steps` — at the end of that first invocation, saying how long
// each step of it took, so the time can be attributed instead of guessed.
//
// What it must never do, and how each is held:
//   * change an answer — it reads the clock and nothing else; every entry
//     point swallows its own errors, so a broken timer is a missing line;
//   * add a round-trip — no I/O but the one console line;
//   * cost a warm invocation anything — after the first `end()` every call
//     returns on its first test, and nothing is ever logged again;
//   * say whose request it was — the line carries step names and durations
//     only: no org, no app, no path, no address.
//
// A step's duration is the time since the PREVIOUS mark, so the steps of one
// line add up to (almost) `total_ms`. Marks sit on the handler's sequential
// line only; work that overlaps it (the request counter) is attributed to the
// step that awaits it.
// ---------------------------------------------------------------------------
"use strict";

function makeColdTimer(opts) {
  const now = (opts && opts.now) || Date.now;
  const log = (opts && opts.log) || ((line) => console.log(line));
  let done = false; // true once the sandbox's first invocation has ended
  let started = 0;
  let last = 0;
  const steps = {};

  return {
    /** Start of an invocation. Only the first one of a sandbox counts. */
    begin() {
      if (done || started) return;
      try {
        started = last = now();
      } catch {
        done = true;
      }
    },
    /** `name` took the time elapsed since the previous mark (accumulated). */
    mark(name) {
      if (done || !started) return;
      try {
        const t = now();
        steps[name] = (steps[name] || 0) + (t - last);
        last = t;
      } catch {
        // a missing step, never a failed request
      }
    },
    /** End of the invocation: write the line, then go silent for good. */
    end(kind) {
      if (done) return;
      done = true;
      if (!started) return;
      try {
        log(JSON.stringify({ type: "cold_start_steps", kind, total_ms: now() - started, steps }));
      } catch {
        // a missing line, never a failed request
      }
    },
  };
}

module.exports = { makeColdTimer };
