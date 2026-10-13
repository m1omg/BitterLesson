#!/usr/bin/env python3
"""Turn the Rulebook's development diary (tests/rulebook-log.md) into JSON for the page.

usage: build_diary.py tests/rulebook-log.md assets/data/rulebook-diary.json
"""
import json
import re
import sys


def main():
    src, out = sys.argv[1], sys.argv[2]
    entries = []
    test = None
    for line in open(src, encoding='utf-8'):
        m = re.match(r'\|\s*(\d\d):(\d\d):(\d\d)\s*\|\s*(v\d+)\s*\|\s*([\d.]+)%\s*\|\s*(.*?)\s*\|\s*$', line)
        if m:
            h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            entries.append({
                'v': m.group(4),
                'time': '%02d:%02d:%02d' % (h, mi, s),
                'minutes': round(h * 60 + mi + s / 60, 3),
                'acc': float(m.group(5)),
                'note': m.group(6),
            })
            continue
        t = re.search(r'\*\*([\d.]+)%\*\*\s*\((\d+)/(\d+)\)', line)
        if t:
            test = {'acc': float(t.group(1)), 'right': int(t.group(2)), 'of': int(t.group(3))}
    payload = {
        'source': 'tests/rulebook-log.md',
        'note': 'Development set: the first 6,000 training digits. Test digits were not used.',
        'test': test,
        'entries': entries,
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(len(entries), 'entries; test', test)


if __name__ == '__main__':
    main()
