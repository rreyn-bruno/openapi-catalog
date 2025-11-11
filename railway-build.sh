#!/bin/bash
# Railway build script to ensure submodules are updated BEFORE npm install

echo "Updating git submodules..."
git submodule update --init --recursive

echo "Submodules updated successfully!"
echo "npm install will now run via Railway's default build process"

