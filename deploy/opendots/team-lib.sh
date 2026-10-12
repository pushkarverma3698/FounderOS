# Shared by team-shift and chief-run (sourced, not run). The caller sets the arrays `allowed` and `denied`
# (claude --allowedTools/--disallowedTools rules) before calling agy_settings.

# claude's usage-limit lines (deploy/lib/claude-run.sh); the weekly limit can exit 0.
LIMIT_RE='hit your .*limit|usage limit|limit reached|quota reached|RESOURCE_EXHAUSTED'
AGY_DIR=$HOME/.gemini/antigravity-cli
# Epic branch (README "Epic branch"): the parts of a big task merge into feat/epic-<P> (P = the parent issue), and
# one final PR carries that branch to the repo's base.
EPIC_RE='^feat/epic-[0-9]+$'
part_of() { grep -oiE '(^|[^[:alnum:]])part of:? #[0-9]+' | head -n1 | grep -oE '[0-9]+$' || true; } # body on stdin -> P or nothing
# agy has no --allowedTools: the claude allowlist becomes permissions.allow/deny in its settings.json
# (rule syntax from the agy binary: command(<prefix>), read_file(*), write_file(*)). Other settings are kept.
agy_settings() {
  local t rules=() f=$AGY_DIR/settings.json allow deny
  for t in "${allowed[@]}" -- "${denied[@]}"; do
    case "$t" in
      --) rules+=(--) ;;
      Read | Glob | Grep) rules+=("read_file(*)") ;;
      Edit | Write) rules+=("write_file(*)") ;;
      Bash\(*) t=${t#Bash(}; rules+=("command(${t%:\*)})") ;;
    esac
  done
  allow=$(printf '%s\n' "${rules[@]}" | sed '/^--$/q' | grep -v '^--$' | jq -Rnc '[inputs] | unique')
  deny=$(printf '%s\n' "${rules[@]}" | sed '1,/^--$/d' | jq -Rnc '[inputs] | unique')
  { [[ -s $f ]] && cat "$f" || echo '{}'; } |
    jq --argjson a "$allow" --argjson d "$deny" '.permissions.allow = $a | .permissions.deny = $d' > "$f.tmp"
  mv "$f.tmp" "$f"
}
