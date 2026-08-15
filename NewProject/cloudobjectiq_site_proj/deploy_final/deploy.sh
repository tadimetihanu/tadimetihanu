#!/bin/sh
# Ensure correct permissions for the .next folder
chmod -R 755 .next
# Install production dependencies (if not already installed)
npm ci --only=production
# Start the Next.js app
npm start
