#!/bin/bash
# Railway build script to ensure bruno-doc-gen is available BEFORE npm install

echo "Checking bruno-doc-gen..."

# If bruno-doc-gen doesn't exist or is empty, clone it
if [ ! -d "bruno-doc-gen" ] || [ ! "$(ls -A bruno-doc-gen)" ]; then
  echo "bruno-doc-gen not found or empty, cloning from GitHub..."
  rm -rf bruno-doc-gen
  git clone https://github.com/rreyn-bruno/bruno-doc-gen.git bruno-doc-gen
  echo "bruno-doc-gen cloned successfully!"
else
  echo "bruno-doc-gen already exists, trying to update..."
  cd bruno-doc-gen && git pull origin main && cd ..
  echo "bruno-doc-gen updated successfully!"
fi

echo "bruno-doc-gen is ready!"

