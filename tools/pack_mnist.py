#!/usr/bin/env python3
"""Pack a random, seeded subset of MNIST into the compact binary the page loads.

Format of each .bin (little endian), then gzipped:
    4 bytes  magic b'BLD1'
    uint32   count
    uint32   rows (28)
    uint32   cols (28)
    count    labels, uint8
    count*rows*cols  pixels, uint8, row-major, 0 = background

usage: pack_mnist.py MNIST_DIR OUT_DIR [n_train] [n_test]
MNIST_DIR holds the four unzipped IDX files from the original distribution.
"""
import gzip
import os
import random
import struct
import sys


def read_idx_images(path):
    with open(path, 'rb') as f:
        magic, n, rows, cols = struct.unpack('>IIII', f.read(16))
        assert magic == 2051, magic
        data = f.read()
    assert len(data) == n * rows * cols
    return n, rows, cols, data


def read_idx_labels(path):
    with open(path, 'rb') as f:
        magic, n = struct.unpack('>II', f.read(8))
        assert magic == 2049, magic
        data = f.read()
    assert len(data) == n
    return data


def pack(images, labels, idx, rows, cols, out_path):
    size = rows * cols
    lab = bytes(labels[i] for i in idx)
    pix = b''.join(images[i * size:(i + 1) * size] for i in idx)
    raw = b'BLD1' + struct.pack('<III', len(idx), rows, cols) + lab + pix
    with open(out_path, 'wb') as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
    return len(raw), os.path.getsize(out_path)


def main():
    src, out = sys.argv[1], sys.argv[2]
    n_train = int(sys.argv[3]) if len(sys.argv) > 3 else 12000
    n_test = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
    os.makedirs(out, exist_ok=True)
    n, rows, cols, timg = read_idx_images(os.path.join(src, 'train-images-idx3-ubyte'))
    tlab = read_idx_labels(os.path.join(src, 'train-labels-idx1-ubyte'))
    m, _, _, simg = read_idx_images(os.path.join(src, 't10k-images-idx3-ubyte'))
    slab = read_idx_labels(os.path.join(src, 't10k-labels-idx1-ubyte'))
    rnd = random.Random(1957)  # the year of the Perceptron
    train_idx = rnd.sample(range(n), n_train)
    test_idx = rnd.sample(range(m), n_test)
    a = pack(timg, tlab, train_idx, rows, cols, os.path.join(out, 'digits-train.bin.gz'))
    b = pack(simg, slab, test_idx, rows, cols, os.path.join(out, 'digits-test.bin.gz'))
    print('train raw %d -> gz %d bytes' % a)
    print('test  raw %d -> gz %d bytes' % b)


if __name__ == '__main__':
    main()
