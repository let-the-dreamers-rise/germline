# The reference trial is not a toy

Most optimisation demos tune a function the author invented that afternoon.
Germline's does too, in `examples/` -- those are illustrations and are labelled
as such. The reference trial is different, and it is the strongest evidence
this project has.

## What it actually is

`engine/trial/arc-transitions.json` holds 9,955 object transitions recorded
from a real agent playing ARC-AGI-3, a benchmark of interactive games where an
agent is given a 64x64 grid and a set of legal actions and told nothing else.
The agent runs on a GPU for hours per attempt and is scored on a public
leaderboard.

The genes are not a metaphor for that agent's configuration. They are its
configuration. From `arc_agent/lawbook.py`, the world model in the deployed
agent:

```python
RING = ((-1, 0), (1, 0), (0, -1), (0, 1))              # -> useRing, ringSides
ident = (obj.get("colour"), obj.get("size", ...))       # -> useColour, useSize
momentum = book["prior_momentum"].get(ident, "0")       # -> useMomentum
if not seen or len(seen) != 1: return None              # -> unanimousOnly
```

Every gene in `engine/genome.js` corresponds to a decision someone had to make
when writing that file, and got wrong at least once.

## What the search found, and why it counts

The world model was originally built by hand. Its author measured the feature
tiers one at a time and concluded that momentum was the single most valuable
context -- worth more than the neighbourhood ring, which was the intuitive
choice and the wrong one.

Germline's evolutionary search, given no knowledge of that analysis and
starting from a configuration that reads nothing at all, arrives at the same
place:

```
action only, the starting point      3148 bps
momentum alone                       4765 bps   <- the measured peak
colour + size + ring + momentum      4663 bps
```

Reading every feature scores *worse* than reading momentum alone, because
discrimination costs coverage: the everything-on configuration answers 41% of
the time at 0.801 accuracy, while momentum alone answers 74% of the time at
0.617 and beats it on the combined measure.

That is the result worth having. Not that the search is clever -- on this
landscape it beats random by 100 basis points, which is real but modest -- but
that **the fittest configuration is not the one a competent engineer would
reach for**, and the search found it without being told.

## What this is not

It is one system, and the same person built the agent and this tool. That is
dogfooding, not independent validation, and the two should not be confused:

- It shows the tool works on a real configuration space rather than a
  contrived one.
- It does not show that anyone else wants it.
- The convergence between hand analysis and search is evidence the search is
  sound. It is not evidence the search is necessary, since a human did reach
  the same answer, slower.

The honest summary: the reference trial proves the machinery is pointed at
something real. The missing evidence is a second person, with their own
system, whose `evaluate()` we have never seen.
