// cli.mjs -- tiny argument parser + shared spend flags for ad-studio commands.
export function parseFlags(argv, { bool = [] } = {}) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.includes('=')) { const [k, ...v] = key.split('='); const val = v.join('='); flags[k] = bool.includes(k) ? /^(true|yes|1)$/i.test(val) : val; continue; }
      const next = argv[i + 1];
      if (bool.includes(key)) {
        // boolean flags: `--commit`, `--commit=false`, `--commit false` must all mean what they say
        if (next !== undefined && /^(true|false|yes|no|1|0)$/i.test(next)) { flags[key] = /^(true|yes|1)$/i.test(next); i++; }
        else flags[key] = true;
      } else if (next === undefined || next.startsWith('--')) flags[key] = true;
      else flags[key] = argv[++i];
    } else flags._.push(a);
  }
  return flags;
}

export const SPEND_BOOLS = ['commit', 'allow-unknown-rate', 'offline', 'audio', 'json', 'preview'];

/** Normalise spend-related flags. maxCredits is NaN unless a finite positive number was given. */
export function spendOptions(f) {
  const maxCredits = f['max-credits'] === undefined ? undefined : Number(String(f['max-credits']).replace(/[,_]/g, ''));
  return { commit: f.commit === true, maxCredits, allowUnknownRate: f['allow-unknown-rate'] === true, offline: f.offline === true };
}
