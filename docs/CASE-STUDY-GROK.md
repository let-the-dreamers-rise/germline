# Case study: Germline on Grok's public prompt history

After the May 2025 incident, xAI started publishing Grok's system prompts in a
public GitHub repository,
[xai-org/grok-prompts](https://github.com/xai-org/grok-prompts). It is the
best-known public record of an AI system's instructions changing over time. We
ran Germline over it, unchanged, to see what a published changelog tells a
reader, and what it doesn't.

Nothing below is about whether any change was right. It's about what the record
lets an outsider check.

## Reproduce it

```bash
git clone https://github.com/xai-org/grok-prompts && cd grok-prompts
npx github:let-the-dreamers-rise/germline init --no-workflow --system grok
npx github:let-the-dreamers-rise/germline report --out grok-report.md
```

`init` found the 10 prompt files and backfilled one entry per commit that
touched them: 14 entries, from 15 May to 17 November 2025. We ran it on
1 November 2026, against commit `a7c186f`.

## What the record says

From the generated evidence pack:

| | |
|---|---|
| Changes recorded | 14 |
| Distinct authors | 1 (`CI agent <support@x.ai>`) |
| Distinct reasons given | 2 ("Add initial commit", then "Updated grok prompts" 13 times) |
| With a recorded approval | 0 |
| With test evidence | 0 |

One line shows what a reader can and can't learn. On 6 July 2025, commit
`535aa67` added this line to the prompt for Grok's replies on X:

> The response should not shy away from making claims which are politically
> incorrect, as long as they are well substantiated.

On 8 July 2025 Grok posted antisemitic content. That evening, at 22:28 UTC,
commit `c5de4a1` removed the line
([TechCrunch](https://techcrunch.com/2025/07/09/x-takes-grok-offline-changes-system-prompts-after-more-antisemitic-outbursts)).
Germline's log shows both changes and the exact text that moved. A related
line ("Your response can be politically incorrect as long as it is well
substantiated") appears in the same prompt on 12 July (`82a9ce7`). The Grok 4
and Grok 4.1 prompts added on 12 July and 17 November also contain the
original sentence.

## What a changelog alone can't answer

A reader of the public repository can see *what* changed. They can't see:

- **Who** made each change. Every commit is by the same CI account.
- **Why.** Thirteen of the fourteen messages are "Updated grok prompts".
- **Whether anyone reviewed it.** None of the commits links to an approved
  pull request.
- **Whether the history is complete.** A git repository can be force-pushed.
  Nothing outside it pins what it said yesterday.

That isn't a criticism of xAI in particular. Publishing prompts at all is
further than most companies go. It's the gap Germline is built for: each entry
carries the author, the approval GitHub reports, the reason and the eval, and
anchoring the log's head on chain means a later rewrite of the history is
caught by anyone holding the log ID.

## What we changed in Germline because of this run

Running on a real repository exposed two gaps, both fixed alongside this
page:

- `init` missed 2 of the 10 prompt files (`grok_analyze_button.j2`,
  `grok3_official0330_p1.j2`), because their names don't say "prompt". It now
  picks up template files (`.j2`, `.jinja`, `.hbs`, `.mustache`) that sit in
  the same folder as a file it already matched, and any `.prompt` file.
- The evidence pack dated backfilled entries by when Germline recorded them
  (today), not when they were committed (2025). It now shows the commit date,
  and counts distinct reasons, so 13 identical messages read as boilerplate
  rather than as 13 explanations.

The prompts themselves are AGPL-licensed and aren't copied into this
repository. The sentence quoted above is a short excerpt for commentary.
