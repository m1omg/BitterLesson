# The Bitter Lesson, Rerun

Rich Sutton's 2019 essay [The Bitter Lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html) argues that, over the long run, general methods that use computation (search and learning) beat methods built from human knowledge, and by a large margin.

This is an interactive essay that does not ask you to take that on faith. It re-runs the argument as live experiments in your browser, on your own device: games are played, networks are trained, mistakes are counted. Nothing is pre-recorded.

## What happens on the page

| | Knowledge | Computation | What you watch |
|---|---|---|---|
| **I. Search** | **The Expert**: a page of hand-written Connect Four strategy (tactics, threat theory, Allis's odd/even rule), two moves of lookahead | **The Searcher**: plain Monte Carlo tree search with random playouts, knows only the rules | A 288-game tournament, 1 to 65,536 imagined games per move. The Expert wins everything at first; the Searcher overtakes it at about 500 imagined games per move and keeps climbing. |
| **You** | You | The Searcher | Play it yourself on an 8-level ladder; every win gives it 4× more compute. |
| **II. Learning** | **The Rulebook**: 34 hand-written rules about loops, stroke ends and junctions (91% on MNIST) · **The Feature Engineer**: hand-designed HOG edge features + a learned linear classifier | **The Learner**: a small CNN that starts from random numbers | A training race measured in FLOP, graded on all 10,000 MNIST test digits. On a 4-core laptop the Learner passes the Rulebook after about 3 seconds of training and the hand-designed features after about 35. |
| | | | The Rulebook's real development diary: 34 revisions, then a plateau. |
| | | | Draw a digit; all three read it, the Rulebook explains itself. |
| **III. Generality** | The same Expert, under rules it was not written for | The same Searcher, unchanged | Misère, cylinder, five-in-a-row, no gravity. Then invent your own game and play the Searcher at it. |
| **IV. Scale** | | | 540 notable AI systems from Epoch AI, 1950–2026, with this page's own training compute placed among them. |

## Run it

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk won't work in most browsers, because they block workers and data loading on `file://` pages.

No build step and no dependencies. Heavy work runs in Web Workers (one per core, minus one). The training race splits each minibatch's gradient across cores.

## How honest is it?

The experiments are real, and the page shows its working. In brief:

- The Searcher's playouts are uniformly random. It has no Connect Four knowledge, and the same code plays every variant.
- The Expert was made as strong as reasonably possible. At 65,536 imagined games per move it still wins a few games, through deep endgame theory.
- The Rulebook was written by an AI model, in the manner of 1970s structural pattern recognition, with no fitted parameters. It was tuned only on training digits; test digits were held out. Its diary is in `tests/rulebook-log.md`.
- On digits, hand-designed HOG features are a strong baseline (2.3% error). The CNN beats them (about 1.6%), but not by the margins seen on ImageNet; the page says so.
- On a bigger board (five in a row on 9×7) the Expert beats a Searcher limited to 1,024 imagined games per move. The page then gives the Searcher 4× more compute, and it wins.
- FLOP counts are analytic: a multiply-add counts as 2 operations, and forward pass, backward pass and feature extraction are all included.

The full method notes are at the bottom of the page.

## Files

```
index.html               the page (styles inline)
assets/js/connect.js     Connect-K rules, Monte Carlo tree search (with MCTS-Solver), the Expert
assets/js/digits.js      HOG features, logistic regression, a small CNN with hand-written backprop
assets/js/rulebook.js    the Rulebook: skeletons, loops, stroke ends, 34 rules
assets/js/tasks.js       jobs that run in workers (games, gradients, evaluation)
assets/js/worker.js      worker entry point
assets/js/app.js         charts, boards, drawing pad, orchestration
assets/data/             MNIST subset (12k train / 10k test), Epoch AI data, Rulebook diary
tests/                   Node calibration and checks (see below)
tools/                   data packing and the single-file artifact build
```

## Reproduce the numbers

```sh
node tests/tourney-par.js '{"sims":[16,256,1024,4096,16384],"games":80,"c":0.5,"openingPlies":2}'   # Expert vs Searcher
node tests/rulebook-eval.js --test       # Rulebook accuracy and confusion matrix
node tests/digits-gradcheck.js           # finite-difference check of the CNN's backprop
node tests/digits-train.js 3             # accuracy vs FLOP for HOG+linear and the CNN
```

Data preparation (needs the original MNIST IDX files and Epoch AI's CSV):

```sh
python3 tools/pack_mnist.py MNIST_DIR assets/data 12000 10000
python3 tools/build_epoch.py notable_ai_models.csv assets/data/epoch.json
python3 tools/build_diary.py tests/rulebook-log.md assets/data/rulebook-diary.json
python3 tools/build_artifact.py index.html out.html   # single-file build, scripts inlined
```

## Credits

- Essay: Rich Sutton, *The Bitter Lesson* (2019). Quotations are verbatim.
- Training compute data: [Epoch AI, Data on Notable AI Models](https://epoch.ai/data/notable-ai-models), CC BY 4.0.
- Handwritten digits: the MNIST database (Yann LeCun, Corinna Cortes, Christopher Burges), CC BY-SA 3.0.
- Typeface: IBM Plex (SIL Open Font License), via Google Fonts.
- Built by Claude, an AI model.

Code is GPL-3.0, see `LICENSE`.
