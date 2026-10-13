#!/usr/bin/env python3
"""Turn Epoch AI's 'Notable AI Models' CSV into the compact JSON the page plots.

Source: Epoch AI, "Data on Notable AI Models", https://epoch.ai/data/notable-ai-models
(CC BY 4.0). Only rows with a training-compute estimate are kept.

Each model becomes [name, organisation, decimal year, domain, log10 FLOP, confidence]
  domain:     G games, V vision, S speech, L language, M multimodal, O other
  confidence: C confident, L likely, S speculative

usage: build_epoch.py notable_ai_models.csv out.json
"""
import csv
import datetime
import json
import math
import sys

DOMAIN_ORDER = [('Games', 'G'), ('Language', 'L'), ('Speech', 'S'), ('Vision', 'V'), ('Multimodal', 'M')]

# Systems the page labels, with the label it uses.
MILESTONES = {
    'Theseus': "Theseus, Shannon's maze-solving mouse",
    'Perceptron Mark I': 'Perceptron Mark I',
    'Samuel Neural Checkers': "Samuel's checkers player",
    'NetTalk (dictionary)': 'NETtalk',
    'Zip CNN': "LeCun's zip-code reader",
    'TD-Gammon': 'TD-Gammon',
    'AlexNet': 'AlexNet',
    'AlphaGo Lee': 'AlphaGo',
    'GPT-3 175B (davinci)': 'GPT-3',
    'GPT-4 (Mar 2023)': 'GPT-4',
}


def domain_code(s):
    parts = [p.strip() for p in s.split(',') if p.strip()]
    for name, code in DOMAIN_ORDER:
        if name in parts:
            return code
    return 'O'


def decimal_year(s):
    d = datetime.date.fromisoformat(s)
    start = datetime.date(d.year, 1, 1)
    end = datetime.date(d.year + 1, 1, 1)
    return round(d.year + (d - start).days / (end - start).days, 3)


def main():
    src, out = sys.argv[1], sys.argv[2]
    rows = list(csv.DictReader(open(src, encoding='utf-8')))
    models = []
    for r in rows:
        c = r['Training compute (FLOP)'].strip()
        if not c or not r['Publication date'].strip():
            continue
        flop = float(c)
        if flop <= 0:
            continue
        models.append([
            r['Model'].strip(),
            r['Organization'].strip(),
            decimal_year(r['Publication date'].strip()),
            domain_code(r['Domain']),
            round(math.log10(flop), 3),
            (r['Confidence'].strip() or 'S')[0],
        ])
    models.sort(key=lambda m: m[2])
    names = {m[0] for m in models}
    missing = [k for k in MILESTONES if k not in names]
    if missing:
        print('warning: milestones not found:', missing)
    payload = {
        'source': 'Epoch AI, "Data on Notable AI Models" (CC BY 4.0), https://epoch.ai/data/notable-ai-models',
        'retrieved': datetime.date.today().isoformat(),
        'fields': ['name', 'organization', 'year', 'domain', 'log10_flop', 'confidence'],
        'milestones': MILESTONES,
        'models': models,
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(len(models), 'models,', min(m[2] for m in models), '-', max(m[2] for m in models))


if __name__ == '__main__':
    main()
