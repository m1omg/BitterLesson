#!/bin/sh
# Fast checks of the engines behind the page. Takes about a minute.
set -e
cd "$(dirname "$0")/.."
echo "== CNN backprop (finite differences)"; node tests/digits-gradcheck.js
echo "== WebAssembly CNN agrees with JavaScript"; node tests/wasm-check.js
echo "== Rulebook on the test digits"; node tests/rulebook-eval.js --test | head -3
echo "== Expert vs Searcher, 40 games at 1,024 imagined games per move"
node tests/tourney-par.js '{"sims":[1024],"games":40,"c":0.5,"openingPlies":2}'
