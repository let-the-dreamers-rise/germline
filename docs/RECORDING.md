# Demo video: what to do, shot by shot

Three minutes maximum. Everything below is real and already works -- no step
asks you to fake anything.

## Before you hit record

1. **Terminal font up.** Windows Terminal: Ctrl and + about four times. Judges
   watch these in a small player; unreadable text is a wasted shot.
2. **Clear the terminal** and `cd` into the repo:
   `cd "C:\Users\ASHWIN GOYAL\germline"`
3. **Rehearse once** so nothing surprises you. PowerShell:
   `$env:PACE="fast"; npm run demo` -- Command Prompt: `set PACE=fast && npm run demo`
4. **Open two windows** and nothing else: the terminal, and a browser with two
   tabs -- `web/explainer.html` and the viewer at
   `https://germline-demo.netlify.app/`
5. **Recorder:** Win+G opens Xbox Game Bar. Record the window, not the whole
   desktop.

Total recording time is about four minutes including pauses. Trim to three.

---

## 0:00-0:20   The problem

**Screen:** `explainer.html`, fullscreen (F11). Press `replay`, let it run.

**Say:** nothing, or one line over the top:

> "If you ship an AI agent, this is your situation."

The scenes carry it: twenty settings, you tuned three, three and a half
billion combinations you never looked at.

---

## 0:20-0:50   What the integration actually is

**Screen:** cut to the terminal. Run:

    npm run demo

It prints the problem, then the integration snippet. Let it scroll.

**Say:**

> "The whole integration is one function. You declare which settings may move,
> and you hand it the eval you already have. Your metric, your test set.
> Nothing leaves your machine and nothing sits in your request path."

---

## 0:50-1:40   The search, and the moment that matters

**Screen:** same terminal. `npm run demo` reaches RUNNING IT, WITH A CONTROL
and actually runs the search -- these numbers are computed live.

It will print a verdict. It usually says **RANDOM**.

**Say, and do not skip this:**

> "Watch the verdict. It's telling me random sampling beat my own search.
> That control ships in the box and runs on every call, because a search
> result without a control isn't a result. We're not selling an optimiser --
> optimisation is a commodity. We're selling the record."

This is the strongest thirty seconds in the video. A tool that argues against
itself is the most credible thing a judge will see all day.

---

## 1:40-2:20   Live on 0G mainnet

**Screen:** terminal. Run:

    npx hardhat run scripts/status.js --network zerog

Ten organisms, two generations, fitness climbing from 3148.

**Say:**

> "This is a real lineage on 0G mainnet. Ten configurations, each one earned
> its children by measured fitness."

Then run:

    npx hardhat run scripts/verify.js --network zerog

**Say while it runs:**

> "Breeding is two transactions. The first commits at a block whose hash
> doesn't exist yet, so nobody can grind for a flattering mutation. This
> re-derives the child from its parent and the seed the chain fixed."

**Let `VERDICT: GENUINE` sit on screen for three full seconds. Say:**

> "A forged lineage fails arithmetic, not trust."

---

## 2:20-2:45   The viewer

**Screen:** browser tab with the live viewer.

Pan slowly down the lineage tree, then stop on the fitness chart.

**Say:**

> "Just under ten thousand real recorded transitions behind this, from an
> agent's world model. It climbs from 3148 to 4765 -- and the configuration it
> found is not the most complex one. Reading every feature costs you ever
> seeing the same situation twice. Nobody would guess that by looking."

---

## 2:45-3:00   Close

**Screen:** hold on the viewer, or cut back to the verification stamp.

**Say:**

> "Every improvement carries a lineage anyone can verify, without trusting the
> team that produced it. That's what turns tuning into something you can own."

Stop recording.

---

## After

- Upload to YouTube as **Unlisted**. The form wants a public URL; unlisted
  qualifies and keeps it off your channel.
- Title: `Germline -- tune your AI's settings automatically, prove how you got there`
- Paste the URL into the AKINDO video field.

## If something goes wrong on camera

- **verify.js errors:** with no CHILD_ID it picks the newest bred organism
  automatically, so this should not happen. If you set one by hand, run
  `status.js` first and pick any id with a parent.
- **RPC hangs:** re-run. 0G mainnet occasionally takes a few seconds.
- **The verdict says the search won:** even better. Say so, and mention it
  loses on smoother spaces and the tool tells you when.
