#!/usr/bin/env python3
"""Turn index.html into the page fragment the Claude Artifact host expects.

The host wraps the page in its own <!doctype>/<html>/<head>/<body>, so the
fragment keeps only the <title>, stylesheet links and <style> from our head,
followed by everything inside <body>. Asset paths stay relative; the
supporting files are published alongside under the same paths.

usage: build_artifact.py index.html OUT.html
"""
import base64
import os
import re
import sys


def main():
    src, out = sys.argv[1], sys.argv[2]
    s = open(src, encoding='utf-8').read()
    head = s[s.index('<head>') + 6:s.index('</head>')]
    body = s[s.index('<body>') + 6:s.rindex('</body>')]
    # Inline our own scripts, so the page needs no script files beside it.
    # Workers are then built from the inlined sources (see makeWorker).
    def inline(m):
        path = m.group(1)
        name = path.rsplit('/', 1)[-1][:-3]
        code = open(path, encoding='utf-8').read()
        assert '</script' not in code, path
        return '<script id="src-%s">\n%s\n</script>' % (name, code)
    body = re.sub(r'<script src="(assets/js/[a-z-]+\.js)"></script>', inline, body)
    # The host serves only standard web types, so binary data travels as
    # base64 text next to the page.
    outdir = os.path.join(os.path.dirname(out), 'assets', 'data')
    os.makedirs(outdir, exist_ok=True)
    for name in ('digits-train', 'digits-test'):
        raw = open('assets/data/%s.bin.gz' % name, 'rb').read()
        with open(os.path.join(outdir, name + '.b64.txt'), 'w') as f:
            f.write(base64.b64encode(raw).decode('ascii'))
        body = body.replace('assets/data/%s.bin.gz' % name, 'assets/data/%s.b64.txt' % name)
    keep = []
    keep += re.findall(r'<title>.*?</title>', head, flags=re.S)
    keep += re.findall(r'<link [^>]*>', head)
    keep += re.findall(r'<style>.*?</style>', head, flags=re.S)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(keep) + '\n' + body.strip() + '\n')
    print('wrote', out, len(keep), 'head elements')


if __name__ == '__main__':
    main()
