# Shared by team-shift and chief-run (sourced, not run). The caller sets the arrays `allowed` and `denied`
# (claude --allowedTools/--disallowedTools rules) before calling agy_settings.

# claude's usage-limit lines (deploy/lib/claude-run.sh); the weekly limit can exit 0.
LIMIT_RE='hit your .*limit|usage limit|limit reached|quota reached|RESOURCE_EXHAUSTED'
AGY_DIR=$HOME/.gemini/antigravity-cli
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
