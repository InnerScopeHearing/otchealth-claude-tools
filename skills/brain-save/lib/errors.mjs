// errors.mjs -- brain-save's exit-code contract, in one place.
//   0 saved and verified (or unchanged)   1 error (bad input, generic title, oversize, dependency down)
//   2 refused (secret or ring), nothing written   3 stored but NOT searchable
//   4 saved and verified, supersede incomplete
// A workflow must treat every non-zero code as "not done".
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, REFUSED: 2, NOT_SEARCHABLE: 3, SUPERSEDE_PENDING: 4 });

export class BrainSaveError extends Error {
  constructor(exit, message, extra = {}) {
    super(message);
    this.name = "BrainSaveError";
    this.exit = exit;
    Object.assign(this, extra);
  }
}

/** Multi-file precedence: any 2, else any 3, else any 1, else any 4, else 0. */
export function combineExitCodes(codes) {
  const set = new Set((codes || []).map((c) => Number(c) || 0));
  for (const c of [EXIT.REFUSED, EXIT.NOT_SEARCHABLE, EXIT.ERROR, EXIT.SUPERSEDE_PENDING]) if (set.has(c)) return c;
  return EXIT.OK;
}
