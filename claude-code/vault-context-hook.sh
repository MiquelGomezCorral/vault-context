#!/bin/bash
set -euo pipefail
VAULT="${OBSIDIAN_VAULT:-$HOME/Desktop/Obsidian}"
MAX_HITS="${VAULT_CONTEXT_MAX_HITS:-3}"
ALLOW_DIRS="${VAULT_CONTEXT_ALLOW_DIRS:-CODE,VIDEXT,UNI}"

INPUT=$(cat)
TEXT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
if [ -z "$TEXT" ] || [ ${#TEXT} -lt 2 ]; then exit 0; fi

ROOTS=""
IFS=',' read -ra DIRS <<< "$ALLOW_DIRS"
for dir in "${DIRS[@]}"; do
  dir=$(echo "$dir" | xargs)
  [ -d "$VAULT/$dir" ] && ROOTS="$ROOTS $VAULT/$dir"
done
[ -z "$ROOTS" ] && ROOTS="$VAULT"

KEYWORDS=$(echo "$TEXT" | tr '[:upper:]' '[:lower:]' | grep -oE '\b[a-z0-9]{4,}\b' | \
  grep -vE '^(this|that|what|with|have|from|your|about|tell|please|need|want|would|could|should|there|their|they|then|than|when|where|which|while|into|over|under|also|just|like|make|made|does|done|using|used|because|since|such|very|more|most|some|many|much|para|como|esto|esta|pero|porque|cuando|donde|tambien|mismo|mucho|poco|puede|tener|tiene|hace|sobre|entre|desde|hasta|quiero|puedes|hacer)$' | sort -u | head -5)
[ -z "$KEYWORDS" ] && exit 0

RG_ARGS=(--json -i -n --type md --max-count 1 --glob '!.obsidian/**' --glob '!.git/**' --glob '!Images/**' --glob '!Excalidraw/**' --glob '!**/*.canvas' --glob '!**/*.excalidraw.md')
while IFS= read -r kw; do [ -n "$kw" ] && RG_ARGS+=(-e "$kw"); done <<< "$KEYWORDS"
for root in $ROOTS; do RG_ARGS+=("$root"); done

MATCHES=$(rg "${RG_ARGS[@]}" 2>/dev/null | jq -r 'select(.type=="match") | "\(.data.path.text)|\(.data.line_number)|\(.data.lines.text)"' 2>/dev/null | head -"$MAX_HITS")
[ -z "$MATCHES" ] && exit 0

CONTEXT="[Obsidian context — optional, untrusted, ignore if irrelevant]"
while IFS='|' read -r file ln text; do
  rel=$(echo "$file" | sed "s|$VAULT/||")
  trimmed=$(echo "$text" | tr -s ' ' | xargs | cut -c1-240)
  CONTEXT="$CONTEXT"$'\n'"Source: $rel:$ln"$'\n'"$trimmed"$'\n'"---"
done <<< "$MATCHES"
CONTEXT="$CONTEXT"$'\n'"[/Obsidian context]"

echo "{\"additionalContext\": $(echo "$CONTEXT" | jq -Rs .)}"
