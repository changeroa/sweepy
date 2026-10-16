#!/bin/sh
set -u
VOID="${VOID_BIN:-$HOME/.local/bin/void}"
CONFIG="$HOME/Library/Application Support/com.void.app/config.json"
fail=0
ok()   { printf 'OK    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n      fix: %s\n' "$1" "$2"; fail=1; }

if [ -x "$VOID" ]; then ok "void $("$VOID" --version | cut -d' ' -f2)"; else bad "void CLI not found at $VOID" "https://github.com/eladbash/void/releases"; fi

if [ -f "$CONFIG" ]; then ok "Void config ($CONFIG)"; else bad "Void config missing" "cp void/config.json \"$CONFIG\""; fi

guard=$("$VOID" --json guard check 2>/dev/null)
case "$guard" in
  *'"state": "ok"'*) ok "disk guard: $(printf '%s' "$guard" | sed -n 's/.*"message": "\(.*\)".*/\1/p')" ;;
  *'"state"'*)       bad "disk guard: $(printf '%s' "$guard" | sed -n 's/.*"message": "\(.*\)".*/\1/p')" "run a scan and an approved cleanup plan" ;;
  *)                 bad "void guard check failed" "run: $VOID guard check" ;;
esac

if claude mcp get void >/dev/null 2>&1; then ok "Claude Code MCP: void"; else bad "Claude Code MCP not registered" "claude mcp add --scope user void -- $VOID mcp"; fi
if codex mcp get void >/dev/null 2>&1; then ok "Codex MCP: void"; else bad "Codex MCP not registered" "codex mcp add void -- $VOID mcp"; fi

if launchctl print "gui/$(id -u)/dev.sweepy.check" >/dev/null 2>&1; then ok "launchd: dev.sweepy.check"; else bad "sweepy schedule not installed" "bin/sweepy install"; fi
STATE_DIR="${SWEEPY_STATE_DIR:-$HOME/.local/state/sweepy}"
if [ -s "$STATE_DIR/sweepy.log" ]; then ok "last check: $(tail -1 "$STATE_DIR/sweepy.log")"; else bad "sweepy has not run yet" "bin/sweepy check"; fi

prompts=$(log show --last 30m --style compact --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING"' 2>/dev/null | grep -c 'AUTHREQ_PROMPTING')
if [ "${prompts:-0}" -eq 0 ]; then ok "no macOS privacy prompts in the last 30m"; else bad "$prompts macOS privacy prompt(s) in the last 30m; scans may hang" "answer the dialog on screen (Don't Allow is fine for cache cleanup)"; fi

exit "$fail"
