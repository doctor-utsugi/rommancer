#!/bin/sh
# Builds the desktop companion for Linux (.deb, AppImage) and Windows (NSIS installer, cross-compiled with
# mingw) and leaves them in release/ with stable names, where the server offers them for download.
set -eu
cd "$(dirname "$0")"
cargo tauri build --bundles appimage,deb
cargo tauri build --target x86_64-pc-windows-gnu
# Only this version's bundles (older ones stay in target/ and would match too)
V="$(sed -n 's/^ *"version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json | head -1)"
mkdir -p release
cp src-tauri/target/release/bundle/deb/Rommancer_${V}_amd64.deb release/rommancer-desktop.deb
cp src-tauri/target/release/bundle/appimage/Rommancer_${V}_amd64.AppImage release/rommancer-desktop.AppImage
cp src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Rommancer_${V}_x64-setup.exe release/rommancer-desktop-setup.exe
echo "$V" > release/version.txt
ls -la release
