# shark-tank — AI-twin Shark Tank panel (standalone + the focus-group investor seat)

Pitch ANY business idea, app, product, or service to 5 AI twins of the well-known Shark Tank
investors and get a real Shark-Tank-style round: each shark reacts in their own voice and deal
style, rates it, decides in/out, and (if in) makes a concrete offer (equity, royalty, loan), then
a deal summary + valuation range. The SAME 5 sharks are also the investor seat inside the
20-person `focus-group-loop`, so the focus group and the solo Shark Round use one roster.

## Use it two ways
- **Solo Shark Round** (pitch any idea, no full focus group):
  `node shark-round.mjs pitch --idea <pitch.txt> --app <name> [--panel cuban,oleary,...] [--catalog]`
  or `echo "<one-paragraph pitch>" | node shark-round.mjs pitch --app <name>`
- **Inside the focus group:** `focus-group-loop` auto-loads these sharks as its 5-investor group.

## The panel (roster: sharks.json)
Default 5: **Mark Cuban, Kevin O'Leary, Lori Greiner, Barbara Corcoran, Daymond John** (AI twins of
their public investing personalities). **Robert Herjavec** is an alternate 6th seat. Swap with
`--panel`. Each has a rich persona so you get authentic dynamics, O'Leary's royalty deals, Cuban
out fast on bad numbers, Greiner's hero-or-zero retail read, Corcoran backing the person, John's
brand lens.

## ⚠️ INTERNAL USE ONLY (legal rail)
These are **AI simulations** emulating publicly-known investing styles for **private decision-support
and pitch practice**. They are NOT the real people, NOT affiliated, and produce NO real offers.
**Never publish these outputs or present them to anyone (especially real investors) as if the real
shark evaluated, valued, or endorsed the company**, that is a right-of-publicity / false-endorsement
risk. The CLO is aware this tool exists and is fenced to internal use. Keep it that way.

## Output
Per shark: reaction (their voice), rating /10, in/out, offer {amount, equity %, valuation, structure,
terms}, concerns. Plus a deal summary (how many in, best valuation, valuation range). `--catalog`
writes the sharks' top concerns to the shared brain so the fleet learns what makes a venture
investable. Saved to `rounds/`.

## Cost / model
Azure OpenAI gpt-4o (credit-funded), 5 calls/round. `SHARK_MODEL` to override; point at Claude when
an anthropic key is added for higher fidelity.
