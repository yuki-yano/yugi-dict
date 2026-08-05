#!/usr/bin/env bash
set -euo pipefail

readonly target_directory="${1:?usage: fetch-yaml-yugi.sh TARGET_DIRECTORY}"
readonly source_repository="https://github.com/DawnbrandBots/yaml-yugi.git"

if [[ -e "${target_directory}" ]]; then
  echo "target already exists: ${target_directory}" >&2
  exit 1
fi

git clone \
  --branch master \
  --depth 1 \
  --filter=blob:none \
  --single-branch \
  --sparse \
  "${source_repository}" \
  "${target_directory}"

git -C "${target_directory}" sparse-checkout set --no-cone '/data/cards/*.json'
git -C "${target_directory}" rev-parse HEAD
