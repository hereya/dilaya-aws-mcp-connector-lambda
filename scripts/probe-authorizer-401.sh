#!/usr/bin/env bash
#
# Does an HTTP API v2 Lambda authorizer have ANY way to answer 401 instead of
# 403 on a token it refuses?
#
# WHY THIS EXISTS. Today `POST /mcp` with an INVALID or EXPIRED token answers
# 403, because API Gateway translates an authorizer's `{isAuthorized:false}`
# that way. The MCP spec says MUST 401 there, and a client only re-runs the
# OAuth flow on a 401 — on a 403 it fails terminally. So a reviewer (or a
# customer) whose session outlives its token gets "Forbidden" and a dead
# connector, with no refresh and no alarm.
#
# The fix hinges on one undocumented detail. AWS says, verbatim: "You can also
# directly return {"errorMessage":"Unauthorized"} from your Lambda function to
# return a 401 error to your clients. If you directly return a 401 error ...
# don't specify any identity sources." What AWS never states is whether that
# holds for a SIMPLE-response authorizer (`enableSimpleResponses: true`), which
# is what we run. Nobody should change the authorizer of every organization on
# a sentence that does not name our configuration.
#
# ⚠️ THE TRAP THIS PROBE ALSO SETTLES. Two plausible recipes contradict each
# other: `throw new Error("Unauthorized")` (the REST v1 recipe) versus
# `return {errorMessage}`. On HTTP API v2 an exception is an INVOCATION
# FAILURE, and AWS is explicit: "If API Gateway can't invoke your Lambda
# authorizer ... clients receive a 500 Internal Server Error." Shipping the
# wrong one means 500 on EVERY refusal, for every organization, plus the
# platform alarm. Variant C exists to see that with our own eyes.
#
# ⚠️ AND THE ONE THAT ISN'T ABOUT REFUSALS AT ALL. Dropping `identitySource`
# routes the "no Authorization header" case THROUGH the Lambda, where today the
# gateway answers 401 without ever invoking it. That 401 is what BOOTSTRAPS
# Claude's discovery. Variant B therefore measures the missing-header case too:
# if it comes back 403, the change would break every NEW connection, not just
# refusals.
#
# SAFE BY CONSTRUCTION: everything is created under one random suffix, nothing
# touches the production stack, and the trap teardown runs on any exit.
#
#   ./scripts/probe-authorizer-401.sh            # run and clean up
#   KEEP=1 ./scripts/probe-authorizer-401.sh     # leave the API up to poke at
#
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
PROFILE_ARG=""
[[ -n "${AWS_PROFILE:-}" ]] && PROFILE_ARG="--profile ${AWS_PROFILE}"
SUFFIX="$(date +%s)-$RANDOM"
NAME="probe401-${SUFFIX}"
TMP="$(mktemp -d)"
CREATED_API=""; CREATED_FNS=(); CREATED_ROLE=""

aws_() { aws $PROFILE_ARG --region "$REGION" "$@"; }

cleanup() {
  local code=$?
  if [[ "${KEEP:-}" == "1" ]]; then
    echo; echo "KEEP=1 — laissé en place : api=${CREATED_API:-none} role=${CREATED_ROLE:-none}"
    echo "Pour supprimer : aws apigatewayv2 delete-api --api-id ${CREATED_API:-}"
    exit $code
  fi
  echo; echo "── Nettoyage ──"
  [[ -n "$CREATED_API" ]] && aws_ apigatewayv2 delete-api --api-id "$CREATED_API" 2>/dev/null && echo "api supprimée"
  for fn in "${CREATED_FNS[@]:-}"; do
    [[ -n "$fn" ]] && aws_ lambda delete-function --function-name "$fn" 2>/dev/null && echo "lambda $fn supprimée"
  done
  if [[ -n "$CREATED_ROLE" ]]; then
    aws_ iam detach-role-policy --role-name "$CREATED_ROLE" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
    aws_ iam delete-role --role-name "$CREATED_ROLE" 2>/dev/null && echo "rôle supprimé"
  fi
  rm -rf "$TMP"
  exit $code
}
trap cleanup EXIT

echo "Région : $REGION — suffixe : $SUFFIX"
ACCOUNT="$(aws_ sts get-caller-identity --query Account --output text)"
echo "Compte : $ACCOUNT"

# --- rôle d'exécution --------------------------------------------------------
CREATED_ROLE="${NAME}-role"
aws_ iam create-role --role-name "$CREATED_ROLE" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query Role.Arn --output text > "$TMP/role_arn"
ROLE_ARN="$(cat "$TMP/role_arn")"
aws_ iam attach-role-policy --role-name "$CREATED_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
echo "Rôle prêt, on laisse IAM se propager (10 s)…"
sleep 10

mkfn() { # mkfn <nom> <corps du handler>
  local fn="$1" body="$2"
  printf 'exports.handler = async function (event) {\n%s\n};\n' "$body" > "$TMP/index.js"
  (cd "$TMP" && zip -q -FS fn.zip index.js)
  aws_ lambda create-function --function-name "$fn" --runtime nodejs22.x \
    --role "$ROLE_ARN" --handler index.handler --zip-file "fileb://$TMP/fn.zip" \
    --query FunctionArn --output text
  CREATED_FNS+=("$fn")
}

# A — ce que nous faisons AUJOURD'HUI : réponse SIMPLE, refus.
FN_A="$(mkfn "${NAME}-a" '  return { isAuthorized: false };')"
# B — la recette AWS : errorMessage renvoyé, SANS identity source.
FN_B="$(mkfn "${NAME}-b" '  return { errorMessage: "Unauthorized" };')"
# C — la recette REST v1, celle qui pourrait faire 500 partout.
FN_C="$(mkfn "${NAME}-c" '  throw new Error("Unauthorized");')"

# --- API + intégration -------------------------------------------------------
CREATED_API="$(aws_ apigatewayv2 create-api --name "$NAME" --protocol-type HTTP \
  --target "$FN_A" --query ApiId --output text)"
aws_ lambda add-permission --function-name "$FN_A" --statement-id apigw \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${CREATED_API}/*" >/dev/null
for fn in "$FN_B" "$FN_C" "$FN_A"; do
  aws_ lambda add-permission --function-name "$fn" --statement-id "apigw-auth-$(basename "$fn")" \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${CREATED_API}/authorizers/*" >/dev/null 2>&1 || true
done

ENDPOINT="$(aws_ apigatewayv2 get-api --api-id "$CREATED_API" --query ApiEndpoint --output text)"
ROUTE_ID="$(aws_ apigatewayv2 get-routes --api-id "$CREATED_API" --query 'Items[0].RouteId' --output text)"

mkauth() { # mkauth <nom> <arn> <avec-identity-source: yes|no>
  local n="$1" arn="$2" src="$3" idargs=()
  if [[ "$src" == "yes" ]]; then idargs=(--identity-source '$request.header.Authorization'); else idargs=(--identity-source); fi
  aws_ apigatewayv2 create-authorizer --api-id "$CREATED_API" --name "$n" \
    --authorizer-type REQUEST --authorizer-payload-format-version 2.0 \
    --enable-simple-responses \
    --authorizer-uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${arn}/invocations" \
    --authorizer-result-ttl-in-seconds 0 "${idargs[@]}" \
    --query AuthorizerId --output text
}

probe() { # probe <étiquette> <authorizerId> 
  aws_ apigatewayv2 update-route --api-id "$CREATED_API" --route-id "$ROUTE_ID" \
    --authorization-type CUSTOM --authorizer-id "$2" >/dev/null
  sleep 3
  local with without
  with="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer pourri' "$ENDPOINT/")"
  without="$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/")"
  printf '%-58s jeton invalide → %s   |   AUCUN en-tête → %s\n' "$1" "$with" "$without"
  curl -s -D- -o /dev/null -H 'Authorization: Bearer pourri' "$ENDPOINT/" \
    | grep -i 'www-authenticate' || true
}

echo
echo "── Résultats ──"
echo "(ce qui compte : 401 sur « jeton invalide », ET 401 conservé sur « aucun en-tête »)"
echo
probe "A · aujourd'hui : {isAuthorized:false}, identity source"          "$(mkauth "${NAME}-a" "$FN_A" yes)"
probe "B · recette AWS : {errorMessage}, SANS identity source"           "$(mkauth "${NAME}-b" "$FN_B" no)"
probe "C · recette REST v1 : throw (attendu : 500, à NE PAS livrer)"     "$(mkauth "${NAME}-c" "$FN_C" no)"
echo
echo "Lecture :"
echo "  • B en 401/401  → le correctif est possible, on le fait."
echo "  • B en 403 sur « aucun en-tête » → INTERDIT : ça casserait toute nouvelle connexion."
echo "  • C en 500      → confirme que 'throw' est le piège, et qu'on ne l'écrit jamais."
