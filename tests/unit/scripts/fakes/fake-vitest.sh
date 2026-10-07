#!/usr/bin/env bash
# Stands in for `vitest run --cache=false --reporter=json --outputFile=F <test files>` in the Pass P tests.
# Per test file: "fails now" in it = one failed assertion, "passes now" = one passed assertion, anything else = a file
# that does not load. Writes a vitest-shaped JSON report to F and exits 1, as vitest does when anything failed.
out=""; files=()
for a in "$@"; do
  case "$a" in
    --outputFile=*) out="${a#--outputFile=}" ;;
    run|--*) ;;
    *) files+=("$a") ;;
  esac
done
[ -n "${FAKE_VITEST_LOG:-}" ] && printf '%s %s\n' "$PWD" "${files[*]}" >>"$FAKE_VITEST_LOG"
rows=""
for f in "${files[@]}"; do
  if grep -q "passes now" "$f" 2>/dev/null; then r='"status":"passed","message":"","assertionResults":[{"status":"passed"}]'
  elif grep -q "fails now" "$f" 2>/dev/null; then r='"status":"failed","message":"","assertionResults":[{"status":"failed"}]'
  else r='"status":"failed","message":"SyntaxError: Unexpected token","assertionResults":[]'
  fi
  rows="${rows:+$rows,}{\"name\":\"$PWD/$f\",$r}"
done
printf '{"testResults":[%s]}' "$rows" >"$out"
exit 1
