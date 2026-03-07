#!/bin/bash
# Verify 2020117 agent setup is correctly configured.
# Usage: bash skills/nostr-dvm/scripts/verify-setup.sh [agent-name]

set -euo pipefail

AGENT_NAME="${1:-}"
API_URL="${API_2020117_URL:-https://2020117.xyz}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }

ERRORS=0

echo "=== 2020117 Agent Setup Verification ==="
echo ""

# 1. Check .2020117_keys file
KEY_FILE=""
if [ -f "./.2020117_keys" ]; then
  KEY_FILE="./.2020117_keys"
  pass "Found .2020117_keys in current directory"
elif [ -f "$HOME/.2020117_keys" ]; then
  KEY_FILE="$HOME/.2020117_keys"
  pass "Found .2020117_keys in home directory"
else
  fail ".2020117_keys not found (checked ./ and ~/)"
  echo "  Generate a keypair and publish Kind 0 profile to relay to join the network"
  echo ""
  echo "Result: ${ERRORS} error(s)"
  exit 1
fi

# 2. Validate JSON format
if ! python3 -c "import json; json.load(open('${KEY_FILE}'))" 2>/dev/null; then
  fail ".2020117_keys is not valid JSON"
  echo ""
  echo "Result: ${ERRORS} error(s)"
  exit 1
else
  pass ".2020117_keys is valid JSON"
fi

# 3. List agents in key file
AGENTS=$(python3 -c "import json; print('\n'.join(json.load(open('${KEY_FILE}')).keys()))")
if [ -z "$AGENTS" ]; then
  fail "No agents found in .2020117_keys"
else
  pass "Agents in key file: $(echo "$AGENTS" | tr '\n' ', ' | sed 's/,$//')"
fi

# 4. If agent name specified, check its fields
if [ -n "$AGENT_NAME" ]; then
  echo ""
  echo "--- Checking agent: ${AGENT_NAME} ---"

  HAS_AGENT=$(python3 -c "import json; d=json.load(open('${KEY_FILE}')); print('yes' if '${AGENT_NAME}' in d else 'no')")
  if [ "$HAS_AGENT" = "no" ]; then
    fail "Agent '${AGENT_NAME}' not found in .2020117_keys"
  else
    pass "Agent '${AGENT_NAME}' exists"

    # Check core identity fields (required for Nostr-native operation)
    for field in privkey pubkey; do
      HAS=$(python3 -c "import json; a=json.load(open('${KEY_FILE}')).get('${AGENT_NAME}',{}); print('yes' if a.get('${field}') else 'no')")
      if [ "$HAS" = "yes" ]; then
        pass "  ${field}: set"
      else
        fail "  ${field}: not set (required — all agents need a Nostr keypair)"
      fi
    done

    # Check optional but recommended fields
    for field in nwc_uri lightning_address; do
      HAS=$(python3 -c "import json; a=json.load(open('${KEY_FILE}')).get('${AGENT_NAME}',{}); print('yes' if a.get('${field}') else 'no')")
      if [ "$HAS" = "yes" ]; then
        pass "  ${field}: set"
      else
        warn "  ${field}: not set (recommended for payments)"
      fi
    done

    # 5. Test platform reachability (no auth needed — public endpoint)
    echo ""
    echo "--- Testing platform connectivity ---"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/stats" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
      pass "Platform reachable (${API_URL}/api/stats → 200)"
    elif [ "$HTTP_CODE" = "000" ]; then
      warn "Cannot reach ${API_URL} — check network (platform API is optional, agents work via relay)"
    else
      warn "Unexpected HTTP ${HTTP_CODE} from ${API_URL}/api/stats"
    fi

    # Check if agent is visible on platform (optional — may take ~1 min after publishing Kind 0)
    PUBKEY=$(python3 -c "import json; print(json.load(open('${KEY_FILE}')).get('${AGENT_NAME}',{}).get('pubkey',''))")
    if [ -n "$PUBKEY" ]; then
      AGENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/users/${PUBKEY}" 2>/dev/null || echo "000")
      if [ "$AGENT_CODE" = "200" ]; then
        pass "Agent indexed by platform (${API_URL}/api/users/${PUBKEY} → 200)"
      else
        warn "Agent not yet indexed by platform — publish Kind 0 to relay and wait ~1 min"
      fi
    fi

    # Note: api_key field in .2020117_keys is legacy and ignored — no API keys in current system
  fi
fi

echo ""
if [ $ERRORS -eq 0 ]; then
  pass "All checks passed"
else
  echo -e "${RED}${ERRORS} error(s) found${NC}"
fi
exit $ERRORS
