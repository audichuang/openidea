#!/bin/sh
# The repositories of snip-sync's real-UI acceptance round (docs/real-ui-operator-fixture.sh
# at 81654b1), used by tests/clip_snip_cases.rs.
# Usage: clip-fixture.sh <empty-directory> [workspace|<repository-name> ...]
set -eu

ROOT=${1:?usage: clip-fixture.sh <empty-directory> [parts ...]}
if [ -e "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null || true)" ]; then
	echo "refusing non-empty directory: $ROOT" >&2
	exit 2
fi
mkdir -p "$ROOT"
FIX="$ROOT/fixtures"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='QA Operator'
export GIT_AUTHOR_EMAIL='qa@example.com'
export GIT_COMMITTER_NAME='QA Operator'
export GIT_COMMITTER_EMAIL='qa@example.com'

g() {
	dir=$1
	shift
	git -C "$dir" "$@"
}

init_repo() {
	dir=$1
	mkdir -p "$dir"
	git init -b main "$dir" >/dev/null
	cat >> "$dir/.git/config" << EOF
[user]
	name = QA Operator
	email = qa@example.com
[commit]
	gpgsign = false
EOF
}

at() {
	export GIT_AUTHOR_DATE=$1
	export GIT_COMMITTER_DATE=$2
}

commit() {
	dir=$1
	at "$2" "$3"
	shift 3
	g "$dir" add -A
	g "$dir" commit -m "$*" >/dev/null
}

workspace_repo() {
	side=$1
	n=$2
	repo="$FIX/$side/$n"
	init_repo "$repo"
	printf 'base %s\n' "$n" > "$repo/README.md"
	commit "$repo" '2026-01-01T00:00:00+08:00' '2026-01-01T00:01:00+08:00' "base $n"
	case "$side/$n" in
		ws-src/repo01|ws-src/repo03)
			printf 'from-%s\n' "$n" > "$repo/unrelated.txt"
			g "$repo" add unrelated.txt ;;
		ws-dst/repo01|ws-dst/repo03)
			printf 'dest-old-%s\n' "${n#repo}" > "$repo/unrelated.txt"
			commit "$repo" '2026-01-02T00:00:00+08:00' '2026-01-02T00:01:00+08:00' 'dest unrelated' ;;
		ws-dst/repo04)
			printf 'not-a-directory\n' > "$repo/newdir"
			commit "$repo" '2026-01-02T00:00:00+08:00' '2026-01-02T00:01:00+08:00' 'newdir is a file' ;;
		ws-src/repo02|ws-src/repo05)
			case "$n" in repo02) body=create-a ;; repo05) body=create-b ;; esac
			printf '%s\n' "$body" > "$repo/only-src.txt"
			g "$repo" add only-src.txt ;;
		ws-src/repo06|ws-src/repo07)
			case "$n" in repo06) body=src-over ;; repo07) body=src-over-2 ;; esac
			printf '%s\n' "$body" > "$repo/shared.txt"
			g "$repo" add shared.txt ;;
		ws-dst/repo06|ws-dst/repo07)
			case "$n" in repo06) body=dst-over ;; repo07) body=dst-over-2 ;; esac
			printf '%s\n' "$body" > "$repo/shared.txt"
			commit "$repo" '2026-01-03T00:00:00+08:00' '2026-01-03T00:01:00+08:00' 'shared exists' ;;
	esac
}

workspace() {
	i=1
	while [ "$i" -le 15 ]; do
		n=$(printf 'repo%02d' "$i")
		workspace_repo ws-src "$n"
		workspace_repo ws-dst "$n"
		i=$((i + 1))
	done
}

files_src() {
	init_repo "$FIX/files-src"
	mkdir -p "$FIX/files-src/folder"
	printf 'keep\n' > "$FIX/files-src/README.md"
	printf 'old\n' > "$FIX/files-src/old-name.txt"
	printf 'gone\n' > "$FIX/files-src/gone.txt"
	printf 'both-base\n' > "$FIX/files-src/both.txt"
	printf 'a\0b\n' > "$FIX/files-src/binary.dat"
	commit "$FIX/files-src" '2026-02-01T00:00:00+08:00' '2026-02-01T00:01:00+08:00' 'file base'

	printf 'staged-new\n' > "$FIX/files-src/staged-new.txt"
	g "$FIX/files-src" add staged-new.txt
	printf 'index-body\n' > "$FIX/files-src/both.txt"
	g "$FIX/files-src" add both.txt
	printf 'worktree-body\n' > "$FIX/files-src/both.txt"
	g "$FIX/files-src" rm gone.txt >/dev/null
	g "$FIX/files-src" mv old-name.txt new-name.txt

	printf 'folder-a\n' > "$FIX/files-src/folder/a.txt"
	printf 'folder-b\n' > "$FIX/files-src/folder/b.txt"
	printf 'folder-c\n' > "$FIX/files-src/folder/c.txt"
	printf 'folder-d\n' > "$FIX/files-src/folder/d.txt"
	printf 'folder-e\n' > "$FIX/files-src/folder/e.txt"
	printf 'bin\0\n' > "$FIX/files-src/folder/bin.dat"
	python3 -c 'open("'"$FIX"'/files-src/folder/utf16.txt","wb").write("文字".encode("utf-16"))'
	python3 -c 'open("'"$FIX"'/files-src/large.txt","wb").write(b"x"*1360000)'
	printf '' > "$FIX/files-src/empty.txt"
	mkdir -p "$FIX/files-src/路徑 有空白"
	printf '中文\n' > "$FIX/files-src/路徑 有空白/檔案.txt"
	printf 'line\r\n\r\n' > "$FIX/files-src/crlf.txt"

	printf 'will-overwrite\n' > "$FIX/files-src/overwrite.txt"
}

files_dst() {
	init_repo "$FIX/files-dst"
	printf 'dest-base\n' > "$FIX/files-dst/README.md"
	printf 'do-not-touch\n' > "$FIX/files-dst/overwrite.txt"
	printf 'dest-both\n' > "$FIX/files-dst/both.txt"
	printf 'gone-dest\n' > "$FIX/files-dst/gone.txt"
	printf 'old-dest\n' > "$FIX/files-dst/old-name.txt"
	printf 'keep-bin\n' > "$FIX/files-dst/binary.dat"
	mkdir -p "$FIX/files-dst/folder"
	printf 'keep-utf16\n' > "$FIX/files-dst/folder/utf16.txt"
	commit "$FIX/files-dst" '2026-02-01T00:00:00+08:00' '2026-02-01T00:01:00+08:00' 'dest base'
}

commits_src() {
	init_repo "$FIX/commits-src"
	printf 'base\n' > "$FIX/commits-src/common.txt"
	printf 'old\n' > "$FIX/commits-src/old.txt"
	printf 'gone\n' > "$FIX/commits-src/gone.txt"
	printf 'a\0b\n' > "$FIX/commits-src/binary.dat"
	printf 'readme\n' > "$FIX/commits-src/README.md"
	commit "$FIX/commits-src" '2026-03-01T09:00:00+08:00' '2026-03-01T09:01:00+08:00' 'commit base'
	g "$FIX/commits-src" branch side

	printf 'c1\n' > "$FIX/commits-src/common.txt"
	at '2026-03-02T09:00:00+08:00' '2026-03-02T09:01:00+08:00'
	g "$FIX/commits-src" add common.txt
	g "$FIX/commits-src" commit -m "$(printf '多行中文\n\n第二段\n')" >/dev/null

	printf 'c2\n' > "$FIX/commits-src/common.txt"
	g "$FIX/commits-src" mv old.txt new.txt
	g "$FIX/commits-src" rm gone.txt binary.dat >/dev/null
	printf '你好 ✨\n' > "$FIX/commits-src/emoji.txt"
	at '2026-03-03T09:00:00+08:00' '2026-03-03T09:01:00+08:00'
	g "$FIX/commits-src" add -A
	g "$FIX/commits-src" commit -m 'C2 rename delete emoji' >/dev/null

	g "$FIX/commits-src" checkout side >/dev/null
	printf 'from-side\n' > "$FIX/commits-src/side.txt"
	commit "$FIX/commits-src" '2026-03-04T09:00:00+08:00' '2026-03-04T09:01:00+08:00' 'SIDE'
	g "$FIX/commits-src" checkout main >/dev/null
	at '2026-03-05T09:00:00+08:00' '2026-03-05T09:01:00+08:00'
	g "$FIX/commits-src" merge --no-ff side -m 'C3 merge' >/dev/null

	mkdir -p "$FIX/commits-src/newdir"
	printf 'text\n' > "$FIX/commits-src/newdir/content.txt"
	printf 'a\0b\n' > "$FIX/commits-src/new-binary.bin"
	at '2026-03-06T09:00:00+08:00' '2026-03-06T09:01:00+08:00'
	g "$FIX/commits-src" add newdir/content.txt new-binary.bin
	g "$FIX/commits-src" commit -m 'C4 text and binary' >/dev/null

	at '2026-03-07T09:00:00+08:00' '2026-03-07T09:01:00+08:00'
	g "$FIX/commits-src" commit --allow-empty -m 'empty replay' >/dev/null
}

commits_dst_overwrite() {
	init_repo "$FIX/commits-dst-overwrite"
	printf 'already\n' > "$FIX/commits-dst-overwrite/common.txt"
	printf 'readme\n' > "$FIX/commits-dst-overwrite/README.md"
	commit "$FIX/commits-dst-overwrite" '2026-03-01T00:00:00+08:00' '2026-03-01T00:01:00+08:00' 'dst base'
	g "$FIX/commits-dst-overwrite" checkout -b qa-replay >/dev/null
	printf 'staged-keep\n' > "$FIX/commits-dst-overwrite/staged-keep.txt"
	g "$FIX/commits-dst-overwrite" add staged-keep.txt
	printf 'local-only\n' > "$FIX/commits-dst-overwrite/local-only.txt"
}

commits_dst_clean() {
	init_repo "$FIX/commits-dst-clean"
	printf 'readme\n' > "$FIX/commits-dst-clean/README.md"
	commit "$FIX/commits-dst-clean" '2026-03-01T00:00:00+08:00' '2026-03-01T00:01:00+08:00' 'dst clean'
	g "$FIX/commits-dst-clean" checkout -b qa-replay >/dev/null
}

commits_dst_present() {
	init_repo "$FIX/commits-dst-present"
	printf 'readme\n' > "$FIX/commits-dst-present/README.md"
	printf 'a\0b\n' > "$FIX/commits-dst-present/binary.dat"
	printf 'gone\n' > "$FIX/commits-dst-present/gone.txt"
	printf 'old\n' > "$FIX/commits-dst-present/old.txt"
	mkdir -p "$FIX/commits-dst-present/dir"
	printf 'folder-gone\n' > "$FIX/commits-dst-present/dir/gone.txt"
	commit "$FIX/commits-dst-present" '2026-03-01T00:00:00+08:00' '2026-03-01T00:01:00+08:00' 'dst present'
	g "$FIX/commits-dst-present" checkout -b qa-replay >/dev/null
}

basket_src() {
	init_repo "$FIX/basket-src"
	mkdir -p "$FIX/basket-src/dir"
	printf 'keep\n' > "$FIX/basket-src/dir/keep.txt"
	printf 'folder-gone\n' > "$FIX/basket-src/dir/gone.txt"
	commit "$FIX/basket-src" '2026-04-01T09:00:00+08:00' '2026-04-01T09:01:00+08:00' 'basket base'
	printf 'keep-2\n' > "$FIX/basket-src/dir/keep.txt"
	rm "$FIX/basket-src/dir/gone.txt"
	commit "$FIX/basket-src" '2026-04-02T09:00:00+08:00' '2026-04-02T09:01:00+08:00' 'basket folder and delete'
}

nonutf8_src() {
	init_repo "$FIX/nonutf8-src"
	printf 'readme\n' > "$FIX/nonutf8-src/README.md"
	printf 'caf\351\n' > "$FIX/nonutf8-src/latin1.txt"
	commit "$FIX/nonutf8-src" '2026-05-01T09:00:00+08:00' '2026-05-01T09:01:00+08:00' 'nonutf8 base'
	printf 'caf\351!\n' > "$FIX/nonutf8-src/latin1.txt"
	printf 'ok\n' > "$FIX/nonutf8-src/ok.txt"
	commit "$FIX/nonutf8-src" '2026-05-02T09:00:00+08:00' '2026-05-02T09:01:00+08:00' 'N1 modify latin1 add ok'
	g "$FIX/nonutf8-src" rm latin1.txt >/dev/null
	commit "$FIX/nonutf8-src" '2026-05-03T09:00:00+08:00' '2026-05-03T09:01:00+08:00' 'N2 delete latin1'
}

nonutf8_dst() {
	init_repo "$FIX/nonutf8-dst"
	printf 'readme\n' > "$FIX/nonutf8-dst/README.md"
	printf 'caf\351\n' > "$FIX/nonutf8-dst/latin1.txt"
	printf 'caf\351\n' > "$FIX/nonutf8-dst/common.txt"
	commit "$FIX/nonutf8-dst" '2026-05-01T00:00:00+08:00' '2026-05-01T00:01:00+08:00' 'nonutf8 dst'
	g "$FIX/nonutf8-dst" checkout -b qa-replay >/dev/null
}

blocked_src() {
	init_repo "$FIX/blocked-src"
	printf 'readme\n' > "$FIX/blocked-src/README.md"
	commit "$FIX/blocked-src" '2026-06-01T09:00:00+08:00' '2026-06-01T09:01:00+08:00' 'blocked base'
	mkdir -p "$FIX/blocked-src/newdir"
	printf 'x\n' > "$FIX/blocked-src/newdir/x.txt"
	printf 'fresh\n' > "$FIX/blocked-src/fresh.txt"
	commit "$FIX/blocked-src" '2026-06-02T09:00:00+08:00' '2026-06-02T09:01:00+08:00' 'B1 blocked dir and fresh'
}

commits_dst_hooks() {
	init_repo "$FIX/commits-dst-hooks"
	printf 'readme\n' > "$FIX/commits-dst-hooks/README.md"
	commit "$FIX/commits-dst-hooks" '2026-03-01T00:00:00+08:00' '2026-03-01T00:01:00+08:00' 'dst hooks'
	g "$FIX/commits-dst-hooks" checkout -b qa-replay >/dev/null
	marker="$FIX/hook-marker.txt"
	for hook in pre-commit prepare-commit-msg commit-msg post-commit; do
		cat > "$FIX/commits-dst-hooks/.git/hooks/$hook" << EOF
#!/bin/sh
echo hooked >> '$marker'
exit 1
EOF
		chmod +x "$FIX/commits-dst-hooks/.git/hooks/$hook"
	done
}

# With no selection, retain the complete operator fixture.
shift
if [ "$#" -eq 0 ]; then
	set -- workspace files-src files-dst commits-src commits-dst-overwrite commits-dst-clean commits-dst-present basket-src nonutf8-src nonutf8-dst blocked-src commits-dst-hooks nongit-dst file-dst
fi
for part in "$@"; do
	case "$part" in
		workspace) workspace ;;
		ws-dst/repo04) workspace_repo ws-dst repo04 ;;
		files-src) files_src ;;
		files-dst) files_dst ;;
		commits-src) commits_src ;;
		commits-dst-overwrite) commits_dst_overwrite ;;
		commits-dst-clean) commits_dst_clean ;;
		commits-dst-present) commits_dst_present ;;
		basket-src) basket_src ;;
		nonutf8-src) nonutf8_src ;;
		nonutf8-dst) nonutf8_dst ;;
		blocked-src) blocked_src ;;
		commits-dst-hooks) commits_dst_hooks ;;
		nongit-dst) mkdir -p "$FIX/nongit-dst" ;;
		file-dst) printf 'i am a file\n' > "$FIX/file-dst" ;;
		*) echo "unknown fixture: $part" >&2; exit 2 ;;
	esac
done
marker="$FIX/hook-marker.txt"

cat > "$ROOT/README.txt" << EOF
Gate B fixtures are under fixtures/.
perf15 is separate:
  python3 scripts/workload_generator.py <this-dir>/perf15 --repos 15 --files 1000 --commits 1000 --refs 30 --quiet
Hook marker path: $marker
EOF

echo "fixture ready: $FIX"
if [ -d "$FIX/commits-src" ]; then
	g "$FIX/commits-src" log --oneline --decorate
fi
