#!/bin/bash
# Railway build script to ensure submodules are updated

echo "Updating git submodules..."
git submodule update --init --recursive

echo "Installing dependencies..."
npm install

echo "Build complete!"

