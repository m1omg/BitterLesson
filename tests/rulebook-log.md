# The Rulebook: development diary

A hand-written, rule-based digit reader (assets/js/rulebook.js), developed the way a
1970s-80s structural pattern recognition researcher would: look at digits, write down
rules, test, look at the mistakes, adjust by hand. Nothing is learned or fitted.
Accuracy is measured on the development set (the first 6000 images of the training
subset); the test subset was not used during development. Times are UTC, wall clock.

| time | version | dev accuracy | what changed |
|---|---|---|---|
| 06:17:29 | v1 | 56.8% | first rulebook: binarize, holes, Zhang-Suen skeleton, stroke ends; 11 rules (2 loops 8, tall loop 0, loop high 9 / low 6, narrow 1, end positions for 2/3/5/7/4) |
| 06:18:59 | v2 | 75.5% | elongation (ink moments) for 1; open-top and closed 4 rules; 2 with a curl at the foot; 3 = three crossings + ends on the left; 7 = leg end pointing down |
| 06:20:56 | v3 | 79.1% | hidden loops: re-check thick blobs at a stricter grey level and cut out dim enclosed pixels (heavy pens fill loops); 8 = low loop with two stroke ends above it |
| 06:22:36 | v4 | 79.8% | mend broken loops: join two stroke ends that are within 5 px on the page but far apart along the skeleton (open 0s, 8s, 9s fixed; but some 3s and 5s now closed into false loops) |
| 06:23:21 | v5 | 80.0% | only join ends that do not point the same way (the arms of a 3 point the same way; a broken loop's ends meet or overlap) |
| 06:23:35 | v6 | 81.5% | 7 = a long bar in the top quarter, no bar at the bottom, a leg reaching the bottom, ink mostly high (catches 7s whose bar starts with a hook) |
| 06:24:18 | v7 | 82.2% | a top bar that ends in a free stroke end at the top right is a 5, never a 7 (in a 7 the bar turns into the leg) |
| 06:24:45 | v8 | 81.8% | 3 = crossed 3 times by some vertical line (not just the centre one), an end top left, an end bottom left pointing left. 3s jump from 71% to 86%, but 2s with a curl at the foot now read as 3 (net loss) |
| 06:25:04 | v9 | 83.1% | 3 rule: drop the bottom-bar test (a 3's bottom arc is wide too); exclude shapes with a stroke end at the bottom right instead (that is a 2's foot) |
| 06:25:28 | v10 | 83.8% | new feature: where the ink sits between 1/4 and 1/2 height. A low loop with the neck on the right and a start pointing left is a 2 with a curled foot, not a 6 (a 6's stem runs down the left) |
| 06:26:15 | v11 | 82.7% | tried: distance transform to find loops inked solid (blob low = 6, blob high = 9) plus a 6 with an open bowl. Blob rules misfire on thick pens (179 wrong vs 46 right): net loss |
| 06:26:38 | v12 | 84.0% | removed the solid-blob rules, kept the open-bowl 6 (stem down the left, bowl open to the right) |
| 06:27:35 | v13 | 84.1% | also join two ends when one heads straight for the other (9s whose loop is left open at the top right); but this closes some 3s and 5s |
| 06:28:24 | v14 | 84.4% | never close a gap in the left 40% of the digit just because an end heads for it: 3 and 5 are open on the left by design (21 fixed, 1 broken) |
| 06:29:44 | v15 | 85.5% | removed four early catch-all rules that were mostly wrong (e.g. 'top right to bottom left: 5' was wrong 74 of 84 times); added last-chance rules: almost-closed ring 0, open loop over a straight stem 9, inked-in bowl 6 |
| 06:30:22 | v16 | 86.2% | closed 4: the crossbar sticks out to the right of the loop as a free end (a 9 never has that); open 4: two ends pointing up, side by side, one leg down; the open-loop 9 must have exactly two ends (47 fixed, 6 broken) |
| 06:31:40 | v17 | 86.1% | tried: 2 = ink upper right at 1/4-1/2 height, lower left at 55-80%, a base. 3s with a curled-up tail match too (4 fixed, 13 broken): reverted |
| 06:31:52 | v18 | 86.7% | a 0's loop fills the box: it must reach into the bottom quarter. A 9's big loop stops higher, leaving room for the tail (31 nines fixed, 2 zeros broken) |
| 06:37:59 | v19 | 86.7% | engineering only, same answers: every pass now runs inside the ink's bounding box, unused blob code removed, fixed an off-grid flood bug |
| 06:38:22 | v20 | 86.8% | 8 whose lower loop is open at the bottom: a high loop standing on two legs whose ends point down (first try, any two low ends, also took closed 4s: no gain) |
| 06:39:07 | v21 | 87.1% | 5 = a bay open to the right under the top bar plus a bay open to the left lower down (the belly). Needed each bay's average height: a 2 also opens right, but above its base (first try broke 38 twos) |
| 06:40:12 | v22 | 88.2% | five last-chance rules before the default: hook pointing left on a wide base (2), hook pointing up over a bowl open left (3), full-width bar with ink high (7), flag at the top right (5), heavy bottom under a stem (6). 70 fixed, 5 broken |
| 06:40:42 | v23 | 88.5% | a 3's tail at the bottom left points sideways or up; a stroke end pointing down-left there is a 7's leg (24 fixed, 8 broken) |
| 06:41:49 | v24 | 88.9% | the 2 rule now checks end directions (a 2 starts with a hook, not an arm pointing up, and its base ends pointing right, not a stem pointing down): 4s stop reading as 2. New 1 rule: an upright stem standing on a base serif (first try took 2s whose base pokes out left; fixed by measuring how far the ink drifts left down the middle) |
| 06:42:21 | v25 | 89.0% | dropped the stem-on-a-base 1 rule: a 2 whose base pokes out left looks the same to these features (6 right, 13 wrong) |
| 06:43:30 | v26 | 89.3% | measured how much the last 10 px of a stroke bend: a 5 sits on a curled belly, a 7 or a 9 hangs on a straight tail. Rejecting every straight tail lost 5s (33 fixed, 37 broken); rejecting only when the ink also sits high works (28 fixed, 8 broken) |
| 06:44:12 | v27 | 89.6% | 9 whose loop is open at the top right: both loop ends up and to the right, a tail below (19 fixed, 5 broken). Also tried 'a 7 has no stroke end on its right side', but crossbarred 7s do: reverted |
| 06:44:42 | v28 | 89.7% | 3 whose lower bowl closes into a loop: big centred low loop, neck on the right, upper arm open to the left, no base end at the bottom right (12 fixed, 4 broken) |
| 06:45:15 | v29 | 89.9% | a 6's stem top never hooks to the left (a 2's start does); a small loop at the far bottom left under a start hooking left is a 2's curl (14 fixed, 0 broken) |
| 06:45:49 | v30 | 90.1% | 8 whose lower loop is inked solid: the bottom 40% of the box is over 42% ink, where a 9's thin tail stays near 20% (16 fixed, 6 broken) |
| 06:46:05 | v31 | 89.9% | tried the textbook ink threshold of 128 instead of 100: slightly worse, back to 100 |
| 06:46:43 | v32 | 90.4% | a thick 0 whose hole sits mid-height but doesn't reach the bottom quarter: a closed ring with no stroke ends at all is a 0 (a 6 always keeps its stem end). Also tried 'flag on top of a closed belly: 5', but it took 44 sixes whose stem curls right: dropped |
| 06:49:53 | v33 | 90.3% | robustness for drawing-pad input, checked on shrunk / thickened / thinned copies of dev digits: rescale digits drawn much smaller or bigger than standard; re-binarize at a stricter level for a very thick pen and a gentler one for a very fine pen. Dev -0.1, but shrunk 84.3->87.7%, thick 80.3->82.7%, thin 86.1->90.5% |
| 06:56:31 | v34 | 90.3% | finishing, same answers on dev: readable trace and display features, rules laid out one per entry, a little faster (thinning over a pixel list, no string keys in hot loops), dark-on-light input turned round, faint lines kept after rescaling |

Held-out test subset (2000 images), evaluated once, after development stopped at v34:
**91.5%** (1829/2000), 34 rules. Hardest digits: 5 (86.2%), 7 (86.8%), 4 (87.0%);
most common mistakes: 4 read as 9, 5 read as 3, 7 read as 1.

Development stopped because the curve had flattened: from v23 to v32 no change
gained more than 0.4 points, and most new rules fixed a dozen digits while
breaking several others.
