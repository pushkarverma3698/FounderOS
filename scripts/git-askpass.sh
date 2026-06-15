#!/usr/bin/env bash
# Git credential helper: emit the token from env, never the cmdline.
echo "${GITHUB_TOKEN}"
