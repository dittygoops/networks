# What this system actually does, and why every gate is there

Written 2026-08-07 for review. The question being answered: is this over-engineered,
and would a better model remove the need for the gates?

Short answers, both surprising:

1. **You have never run a good model.** `MODEL_FRONTIER` and `MODEL_CHEAP` are both
   unset in `.env`, so all 61 emails were written by `deepseek/deepseek-chat`, the
   hardcoded fallback in `src/cli.ts:450`. The frontier slot exists and has always
   been empty.
2. **Most gates are not model problems.** Of the 20 real incidents this project has
   had, 4 are things a better model would likely have prevented. The other 16 are
   regex bugs, infrastructure failures, and API misunderstandings that no model
   quality would touch.

So the honest answer is: yes, use a better model, it is free and overdue. No, it
will not let you delete most of this.

---

## 1. What the system is

A daily job that finds researchers worth emailing, drafts a cold email, texts it to
Aditya for approval, and sends it from his ASU address on a thumbs up.

```
09:00 batch (com.aditya.outreach)          one-shot, fresh process
listener   (com.aditya.outreach-listen)    always on, holds an iMessage connection
```

Current state: 61 sent, 39 skipped, 9 awaiting. 14 of the 61 have replies nobody
has read yet.

---

## 2. The pipeline, end to end

What happens to one arXiv paper:

```
1  DISCOVER    arXiv search over config/watchlist.yaml, skip anything already seen
2  RELEVANCE   cheap LLM scores it against the watchlist terms      [free]
3  IDENTITY    resolve the target author via OpenAlex               [free]
4  FACTS       OpenAlex facts + facts extracted from the paper      [free, one LLM call]
5  HOOK GATE   intersect their facts against Aditya's ontology      [free, one LLM call]
                  no hook -> STOP. This is where most candidates die.
6  ENRICH      Tavily search + fetch of their personal pages        [PAID]
7  CONTACT     address from the PDF, else Tavily search             [PAID]
8  DRAFT       write the email                                      [one LLM call]
9  MESSAGE     text it to Aditya
10 APPROVE     he replies "d70 y" or taps a thumbs up
11 SEND        Gmail API, once, never retried automatically
```

Steps 6 and 7 are the only ones that cost money. Everything expensive sits behind
step 5, which is why a batch costs ~70 credits instead of ~1000.

---

## 3. Every gate, and the incident that put it there

| # | Gate | Incident that caused it | Better model prevents? |
|---|---|---|---|
| 1 | arXiv id parsing | `/abs\/([^v]+)/` turned `solv-int/9701004v1` into `sol` | no, regex |
| 2 | Hook reason must name a real matched term | A wireless-sensor paper got `reason: "matches gap term: olfactory embedding space"` because the match list was empty and the code fell back to `terms[0]` | no, code bug |
| 3 | Timer bound | A 1-year timeout in ms overflowed a 32-bit field, became 1ms, caused 4 reconnects in 45s | no, arithmetic |
| 4 | Push not batch delivery | An approved `d8 y` sat unprocessed behind a 24-day window | no, design bug |
| 5 | launchd absolute node path | Job exited 127 because launchd's PATH excludes Homebrew | no, environment |
| 6 | Page-identity gate | A `dr-jan-delcker` page was scraped as facts about Nicolai Plintz; 57 facts purged from 4 people | no, missing check |
| 7 | `personNameInText` | `nameMatches('publications', 'Wei Li')` returned true, making gate 6 a no-op | no, logic bug |
| 8 | Email label stripping | `emaila.sajan@vu.nl` from a glued "Email" label | no, regex |
| 9 | `nameMatches` first-name rule | Sent to `daniel.lee@dlapiper.com`, a lawyer, meaning researcher Daniel Kepple | no, regex |
| 10 | `nameMatches` residue rule | 6 wrong-person sends: `xuhuaping@` for Ziheng Xu, `huangbo@` for Xianliang Huang, etc | no, regex |
| 11 | `nameMatches` token boundary | `l.zhang.16@` matched "Zhisheng Han" because `han` sits inside `zhang` | no, regex |
| 12 | Semantic Scholar fixture | The source returned zero for its entire life; the test fixture wrote the same wrong key the code read | no, test bug |
| 13 | Uncapped flush | 18 drafts were created and never texted, because the per-run cap silently dropped them | no, design |
| 14 | Daemon freshness check | The listener ran code from hours earlier; a live probe failed while 606 tests passed | no, deployment |
| 15 | No `dN:` in notifications | A tapback on a refusal message decoded to `dN y`, a live send path | no, format |
| 16 | Persona cascade | A rebuild deleted every stored hook via `ON DELETE CASCADE` | no, schema |
| 17 | Sign-off stripping | d68 went out with two sign-offs; the stripper needed a newline and the model wrote inline | **partly** |
| 18 | Stance honesty | d76 said "I'm an undergrad" above a signature reading MS Student | **yes** |
| 19 | Attribution (not yet built) | d108 claimed "I've worked with Jetson Orin NX Edge GPUs", which is the *recipient's* hardware fused with Aditya's unrelated project | **yes** |
| 20 | Hook groundedness | Hooks must trace to a stored fact with a real `source_url` | **partly** |

**Tally: 4 of 20 are model-quality problems.** The rest are regexes, schemas,
launchd, and API semantics.

---

## 4. Is it over-engineered?

Honestly, in three places. Not in the rest.

**Genuinely warranted.** Gates 1 through 16 each exist because something specific
went wrong, usually visibly and usually to a real stranger's inbox. Six wrong-person
emails is not a hypothetical. Neither is a daemon that silently ran stale code for
hours while every test passed.

**Over-engineered, and I would cut these:**

- **The `unique symbol` compile-time brand** in the deferred identity spec. It
  enforces call ordering through the type system, a review proved it is defeatable
  with a plain import and no cast, and a single ordering test does the same job.
- **The three-way address-correction refusal set.** The typo blocker is real. The
  other two refusals came from reasoning about hypotheticals, not from an incident.
- **The reply poller's lease and two-scope failure taxonomy.** Standard for a
  poller, but this poller runs 4 times a day against one mailbox for one user.
  A simpler "if anything fails, log and try again in 4 hours" would probably do.

**The real problem is not the number of gates.** It is that the gates are all at the
end. The system spends effort producing a candidate and then rejects it, instead of
not producing it. Gap-framed asks would fix more than any individual gate, because
it removes the weak hooks that make the model fabricate in the first place. d108
fused two facts because it was asked to find common ground between Playwright and a
Jetson, and there is none.

---

## 5. The model finding

```
src/cli.ts:450   model: process.env.MODEL_FRONTIER ?? process.env.MODEL_CHEAP ?? 'deepseek/deepseek-chat'
.env             contains ZERO MODEL_ variables
```

Every email you have sent was written by a cheap model. The three defects most
likely to be model quality (the undergrad claim, the double sign-off, the Jetson
fusion) all came from it.

Setting `MODEL_FRONTIER` is a one-line change and should be done before any further
drafting work. It will not fix the regex bugs, the daemon staleness, or the
attribution problem in general, but it is the cheapest quality improvement
available and it has never been tried.

---

## 6. What I would do next, in order

1. **Set `MODEL_FRONTIER`.** One line. Never tried.
2. **Build the attribution gate.** No first-person claim may contain a value from
   the recipient's side of a hook. Mechanically checkable, catches d108's class.
3. **Ship gap-framed asks.** Removes weak hooks, which is where fabrication starts.
4. **Read the 14 replies.** The system's entire purpose already produced results
   nobody has looked at.
5. **Cut the three over-engineered items above** when their code is next touched.

---

## 7. Where the numbers come from

- 734 tests across 59 files, all passing. 8,900 lines of source, 10,178 of test.
- 128 explicit refusal or guard sites across the pipeline, sender and approval code.
- Incident list reconstructed from git history and the comments in the code, each of
  which records the failure it exists to prevent.
