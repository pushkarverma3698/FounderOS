#!/bin/bash
set -e

# Setup directories
mkdir -p /work/inputs /work/outputs
cd /work

# 1. Pull inputs from S3
if [ -n "$S3_INPUT_PREFIX" ]; then
    echo "Downloading inputs from s3://$STORAGE_BUCKET/$S3_INPUT_PREFIX..."
    aws s3 cp "s3://$STORAGE_BUCKET/$S3_INPUT_PREFIX" /work/inputs --recursive
fi

# Move files into root execution folder if they are scripts
cp -r /work/inputs/* /work/ 2>/dev/null || true

# 2. Run the command
echo "Executing: $@"
eval "$@"
EXEC_CODE=$?

# 3. Push outputs back to S3
if [ -n "$S3_OUTPUT_PREFIX" ]; then
    echo "Uploading outputs to s3://$STORAGE_BUCKET/$S3_OUTPUT_PREFIX..."
    # Copy any generated files to outputs folder, excluding inputs
    find . -maxdepth 1 -type f ! -name "bootstrap.sh" -exec cp {} /work/outputs/ \;
    aws s3 cp /work/outputs/ "s3://$STORAGE_BUCKET/$S3_OUTPUT_PREFIX" --recursive
fi

exit $EXEC_CODE
