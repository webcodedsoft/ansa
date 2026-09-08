#!/usr/bin/env bash
# Bring the carrier's road back to this machine, and prove it before saying so.
#
# A campaign call is placed at the carrier and then has to find its way back to this API for
# the media stream, the status callback and the answering-machine result. All three go to
# PUBLIC_BASE_URL. When that is an ngrok tunnel and the tunnel is not running, ngrok serves
# its own landing page there instead — every route answers 404, the call connects, hears
# nothing, and hangs up billed. TASKS.md records this happening once from a dead tunnel;
# it happened again the next time a session ended. This script exists so it does not
# happen a third time.
#
# It does three things, in order, and stops at the first that fails:
#   1. starts ngrok on the API port, reusing the reserved domain in PUBLIC_BASE_URL
#   2. waits for the tunnel and refuses to continue if ngrok handed back a different URL
#   3. proves the loop: the tunnel must answer the telephony routes the way localhost does
#
# Run it before starting a campaign. It is not started by `pnpm dev` on purpose — a tunnel
# is a hole to the internet, and opening one should be a thing a person did.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HERE/.env"
# The port the API actually listens on, read from the same place the API reads it. This was
# hardcoded to 3010 because that is where the API happened to be running when the script was
# written; `.env` says PORT=3000, so `pnpm tunnel` pointed ngrok at nothing and every call
# reached a 502. `API_PORT` still overrides, and 3000 is the app's own default.
PORT="${API_PORT:-$(grep -oE '^PORT=[0-9]+' "$ENV_FILE" 2>/dev/null | cut -d= -f2)}"
PORT="${PORT:-3000}"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok is not installed (brew install ngrok)" >&2
  exit 1
fi

WANT="$(grep -oE '^PUBLIC_BASE_URL=.*' "$ENV_FILE" | cut -d= -f2- | sed -E 's#/+$##')"
if [[ -z "$WANT" ]]; then
  echo "PUBLIC_BASE_URL is not set in .env" >&2
  exit 1
fi
DOMAIN="${WANT#https://}"

# The URL ngrok is actually serving, or empty if it is not serving one yet. Empty covers every
# not-ready case — agent down, no tunnel registered, malformed body — because the caller's next
# move is the same for all three: wait, then give up.
served() {
  curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
    | python3 -c 'import sys,json
try: t = json.load(sys.stdin).get("tunnels", [])
except Exception: t = []
print(t[0]["public_url"] if t else "")' 2>/dev/null || true
}

if [[ -n "$(served)" ]]; then
  echo "ngrok is already running; using the existing tunnel"
else
  # --domain pins the reserved hostname, so PUBLIC_BASE_URL and Twilio's webhooks stay true.
  # Without it a free tunnel gets a fresh name on every start, and both go stale silently.
  nohup ngrok http "$PORT" --domain="$DOMAIN" --log=stdout --log-format=json \
    > "${TMPDIR:-/tmp}/ansa-ngrok.log" 2>&1 &
  echo $! > "${TMPDIR:-/tmp}/ansa-ngrok.pid"
  # Wait for a tunnel, not for the agent. The agent's API answers 200 with an empty list a
  # second or so before the tunnel registers, so waiting on the endpoint alone returned "no
  # URL" and the script reported a mismatch against a tunnel that was about to come up fine.
  for _ in $(seq 1 40); do
    [[ -n "$(served)" ]] && break
    sleep 0.5
  done
fi

GOT="$(served)"

if [[ "$GOT" != "$WANT" ]]; then
  echo "ngrok is serving $GOT but PUBLIC_BASE_URL is $WANT" >&2
  echo "Twilio's webhooks point at PUBLIC_BASE_URL; a mismatch means calls reach nothing." >&2
  exit 1
fi

# The loop, proved rather than assumed. Both must agree with localhost: 403 is right (the
# route exists and refuses an unsigned request); 404 means the tunnel is not reaching us.
fail=0
for path in /telephony/voice /telephony/status; do
  local_code="$(curl -s --max-time 5 -X POST -o /dev/null -w '%{http_code}' "http://localhost:$PORT$path")"
  tunnel_code="$(curl -s --max-time 10 -X POST -H 'ngrok-skip-browser-warning: 1' -o /dev/null -w '%{http_code}' "$WANT$path")"
  if [[ "$local_code" != "$tunnel_code" ]]; then
    echo "$path: localhost answers $local_code but the tunnel answers $tunnel_code" >&2
    fail=1
  fi
done
if [[ "$fail" -ne 0 ]]; then
  echo "The tunnel is up but is not reaching this API. Is it running on port $PORT?" >&2
  exit 1
fi

echo "tunnel ready: $WANT -> localhost:$PORT (telephony routes verified)"
