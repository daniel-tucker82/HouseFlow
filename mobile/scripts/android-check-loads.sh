#!/usr/bin/env bash
# Check every PT_LOAD segment using the SDK or GNU readelf.
set -euo pipefail
export LC_ALL=C
directory=$1
abi=$2
report=$3
work=$4
reader=${READELF:-readelf}
case "$abi" in
  arm64-v8a) machine=AArch64 ;;
  x86_64) machine='Advanced Micro Devices X86-64' ;;
  *) echo "Unsupported 64-bit Android ABI" >&2; exit 1 ;;
esac
shopt -s nullglob
libs=("$directory/"*.so)
test "${#libs[@]}" -gt 0
printf 'library\tLOAD segment alignment\n' > "$report"
for lib in "${libs[@]}"; do
  "$reader" -hW "$lib" > "$work/header.txt"
  grep -Eq "Machine:[[:space:]]+$machine" "$work/header.txt"
  "$reader" -lW "$lib" > "$work/segments.txt"
  mapfile -t alignments < <(awk '$1=="LOAD" {print $NF}' "$work/segments.txt")
  test "${#alignments[@]}" -gt 0
  for alignment in "${alignments[@]}"; do
    [[ "$alignment" =~ ^0x[0-9a-fA-F]+$ ]]
    printf '%s\t%s\n' "$(basename "$lib")" "$alignment" >> "$report"
    if (( alignment < 16384 )); then echo "Insufficient ELF load alignment: $(basename "$lib") $alignment" >&2; exit 1; fi
  done
done
