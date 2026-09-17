"""从 class 常量池提取「类.方法名 + 描述符」。
class 常量池 UTF8 连续存储；Methodref 顺序为 类名 / 方法名 / 描述符，
段间由非可见字节分隔。这里逐段切分后再配对，比正则更稳。
用法: python scan-calls.py <jar> [类名前缀]
"""
import sys, zipfile, re, collections

JAR = sys.argv[1]
FILTER = sys.argv[2] if len(sys.argv) > 2 else ''

z = zipfile.ZipFile(JAR)
calls = collections.defaultdict(set)

for n in z.namelist():
    if not n.endswith('.class'):
        continue
    d = z.read(n)
    # 切出所有可见字符串段（UTF8 常量）
    segs = re.findall(rb'[\x20-\x7e]{2,120}', d)
    for i in range(len(segs) - 2):
        a, b, c = segs[i], segs[i + 1], segs[i + 2]
        if not a.startswith(b'android/'):
            continue
        if not b'/' in a:
            continue
        if not c.startswith(b'('):
            continue
        cls = a.decode('latin1')
        if not re.fullmatch(r'android/[A-Za-z0-9_/$]+', cls):
            continue
        calls[cls].add((b.decode('latin1'), c.decode('latin1')))

total = 0
for cls in sorted(calls):
    if FILTER and not cls.startswith(FILTER):
        continue
    print(f'== {cls} ==')
    for nm, desc in sorted(calls[cls]):
        print(f'     {nm} {desc}')
        total += 1
print(f'\n(共 {total} 条, {len(calls)} 个类)')
