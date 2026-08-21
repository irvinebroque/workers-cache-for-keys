#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
	echo "Usage: WORKER_URL=https://worker.example.com pnpm run update-and-refresh -- <r2-key> <file>" >&2
	exit 1
fi

: "${WORKER_URL:?Set WORKER_URL to the deployed Worker's origin}"

key=$1
file=$2
encoded_key=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$key")

pnpm exec wrangler r2 object put "workers-cache-for-keys/$key" \
	--remote \
	--file "$file"

curl --fail --silent --show-error \
	--request POST \
	"${WORKER_URL%/}/refresh/$encoded_key"

printf '\n'
