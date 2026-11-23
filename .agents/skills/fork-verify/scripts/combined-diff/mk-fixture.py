"""u4-mix: 300 changed working-tree files (varied sizes, 8 large 3-5k-line files with every other line changed),
one partially staged file (m150.txt), a submodule with a moved commit. Synthetic, seed 42, ~5 s.
Usage: mk-fixture.py <parent-dir>   (recreates <parent-dir>/u4-mix and <parent-dir>/u4-sub-origin)"""
import os, random, shutil, subprocess, sys
if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
R = random.Random(42)
PARENT = os.path.realpath(os.path.expanduser(sys.argv[1]))  # real path: the IDE opens /private/tmp, not /tmp
D = os.path.join(PARENT, "u4-mix")
SUB = os.path.join(PARENT, "u4-sub-origin")
def g(*a, cwd=D): subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
for p in (D, SUB): shutil.rmtree(p, ignore_errors=True)
os.makedirs(SUB); g("init", "-q", "-b", "main", cwd=SUB)
open(f"{SUB}/s.txt", "w").write("sub 1\n"); g("add", ".", cwd=SUB); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "s1", cwd=SUB)
os.makedirs(D); g("init", "-q", "-b", "main")
g("config", "user.name", "t"); g("config", "user.email", "t@t"); g("config", "protocol.file.allow", "always")
open(f"{D}/.git/info/exclude", "a").write(".openidea/\n")
LARGE = {20, 75, 120, 180, 210, 240, 270, 295}
def name(i): return f"d{i // 50:02d}/m{i:03d}.txt"
def words(i, n): return [f"line {k:05d} of file {i:03d} alpha beta gamma {R.randint(0, 9999)}" for k in range(n)]
orig = {}
for i in range(300):
    n = R.choice([3000, 4000, 5000]) if i in LARGE else R.randint(20, 400)
    orig[i] = words(i, n)
    os.makedirs(os.path.dirname(f"{D}/{name(i)}"), exist_ok=True)
    open(f"{D}/{name(i)}", "w").write("\n".join(orig[i]) + "\n")
subprocess.run(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", SUB, "sub"], cwd=D, check=True, capture_output=True)
g("add", "-A"); g("commit", "-qm", "base")
for i in range(300):
    L = list(orig[i])
    if i in LARGE:
        L = [l + " CHANGED" if k % 2 == 0 else l for k, l in enumerate(L)]  # every other line -> 2.5k-line hunks
    else:
        for _ in range(R.randint(1, 6)):
            k = R.randrange(len(L)); L[k] = L[k] + " edited"
        if R.random() < 0.3: L.insert(R.randrange(len(L)), f"inserted line in {i:03d}")
    open(f"{D}/{name(i)}", "w").write("\n".join(L) + "\n")
# partially staged: stage the current edit of m150, then edit again in the worktree
g("add", name(150))
with open(f"{D}/{name(150)}", "a") as f: f.write("UNSTAGED tail line of m150\n")
# submodule: new commit inside
open(f"{D}/sub/s.txt", "a").write("sub 2\n"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "s2", cwd=f"{D}/sub")
print(subprocess.run(["git", "status", "--porcelain"], cwd=D, capture_output=True, text=True).stdout.count("\n"), "status lines")
