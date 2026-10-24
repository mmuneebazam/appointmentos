#!/usr/bin/env bash
# End-to-end smoke test against a running instance.
#
#   npm run dev            # terminal 1
#   ./scripts/smoke.sh     # terminal 2
#
# Exercises: availability → hold → booking → signed webhook → duplicate replay
# → unsigned rejection → queue drain, and asserts on the outcomes.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
ORG="${ORG:-northside}"
PASS=0
FAIL=0

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — expected $3, got $2"; fi; }

json() { python3 -c "import sys,json;d=json.load(sys.stdin);
import functools
for k in '$1'.split('.'):
    d = d[int(k)] if k.isdigit() else d[k]
print(d if not isinstance(d,(dict,list)) else json.dumps(d))"; }

step "Health"
HEALTH=$(curl -s "$BASE/api/health")
check "database reachable" "$(echo "$HEALTH" | json status)" "ok"

step "Catalogue"
CATALOGUE=$(curl -s "$BASE/api/public/org/$ORG")
SERVICE=$(echo "$CATALOGUE" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([s for s in d["services"] if s["name"]=="Initial Consultation"][0]["id"])')
STAFF=$(echo "$CATALOGUE" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([s for s in d["services"] if s["name"]=="Initial Consultation"][0]["staff"][0]["id"])')
DATE=$(python3 -c 'import datetime;print((datetime.date.today()+datetime.timedelta(days=4)).isoformat())')
ok "service + staff resolved"

step "Availability"
AVAIL=$(curl -s "$BASE/api/public/availability?org=$ORG&serviceId=$SERVICE&date=$DATE")
SLOT=$(echo "$AVAIL" | python3 -c 'import sys,json;d=json.load(sys.stdin);s=[x for g in d["staff"] for x in g["slots"]];print(s[0]["startsAt"] if s else "")')
if [ -z "$SLOT" ]; then echo "  no slots on $DATE — try another day"; exit 1; fi
ok "first slot $SLOT"

step "Hold"
HOLD=$(curl -s -X POST "$BASE/api/public/holds" -H 'content-type: application/json' \
  -d "{\"orgSlug\":\"$ORG\",\"serviceId\":\"$SERVICE\",\"staffId\":\"$STAFF\",\"startsAt\":\"$SLOT\"}")
TOKEN=$(echo "$HOLD" | json token)
ok "hold token ${TOKEN:0:8}…"

step "Competing hold is rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/public/holds" -H 'content-type: application/json' \
  -d "{\"orgSlug\":\"$ORG\",\"serviceId\":\"$SERVICE\",\"staffId\":\"$STAFF\",\"startsAt\":\"$SLOT\"}")
check "second holder gets 409" "$CODE" "409"

step "Booking"
KEY="smoke-$(date +%s)"
BOOK=$(curl -s -X POST "$BASE/api/public/bookings" -H 'content-type: application/json' \
  -d "{\"orgSlug\":\"$ORG\",\"serviceId\":\"$SERVICE\",\"staffId\":\"$STAFF\",\"startsAt\":\"$SLOT\",\"holdToken\":\"$TOKEN\",\"idempotencyKey\":\"$KEY\",\"customer\":{\"name\":\"Smoke Test\",\"email\":\"smoke@example.com\"}}")
APPT=$(echo "$BOOK" | json appointment.id)
REF=$(echo "$BOOK" | json payment.providerRef)
ok "booking $APPT created"
check "starts pending payment" "$(echo "$BOOK" | json appointment.status)" "PENDING_PAYMENT"

step "Idempotent replay"
REPLAY=$(curl -s -X POST "$BASE/api/public/bookings" -H 'content-type: application/json' \
  -d "{\"orgSlug\":\"$ORG\",\"serviceId\":\"$SERVICE\",\"staffId\":\"$STAFF\",\"startsAt\":\"$SLOT\",\"idempotencyKey\":\"$KEY\",\"customer\":{\"name\":\"Smoke Test\",\"email\":\"smoke@example.com\"}}")
check "same appointment returned" "$(echo "$REPLAY" | json appointment.id)" "$APPT"
check "flagged as replayed" "$(echo "$REPLAY" | json replayed)" "True"

step "Signed webhook confirms the booking"
PAY=$(curl -s -X POST "$BASE/api/public/payments/confirm" -H 'content-type: application/json' \
  -d "{\"providerRef\":\"$REF\",\"outcome\":\"succeed\"}")
EVENT=$(echo "$PAY" | json eventId)
check "outcome processed" "$(echo "$PAY" | json outcome.status)" "processed"

step "Duplicate delivery is a no-op"
DUP=$(curl -s -X POST "$BASE/api/public/payments/confirm" -H 'content-type: application/json' \
  -d "{\"providerRef\":\"$REF\",\"outcome\":\"succeed\",\"eventId\":\"$EVENT\"}")
check "outcome duplicate" "$(echo "$DUP" | json outcome.status)" "duplicate"

step "Unsigned webhook is rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/payments" \
  -H 'content-type: application/json' -d '{"id":"evt_forged","type":"payment_intent.succeeded"}')
check "401 without signature" "$CODE" "401"

step "Dashboard requires a session"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard/summary")
check "401 unauthenticated" "$CODE" "401"

step "Worker drains the queue"
DRAINED=$(npm run --silent worker:once | tail -1)
ok "$DRAINED"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
