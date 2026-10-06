#!/bin/sh
# Install or update the monday.com My Work desklet for the current user.
#   curl -fsSL https://raw.githubusercontent.com/mitchsowa/monday-mywork-desklet/main/install.sh | sh
set -e
UUID="monday-mywork@mitch"
REPO="mitchsowa/monday-mywork-desklet"
DEST="$HOME/.local/share/cinnamon/desklets/$UUID"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $REPO..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o "$TMP/src.tar.gz"
else
    wget -qO "$TMP/src.tar.gz" "https://github.com/$REPO/archive/refs/heads/main.tar.gz"
fi
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)"

mkdir -p "$(dirname "$DEST")"
if [ -L "$DEST" ]; then
    echo "$DEST is a symlink (development install); leaving it alone. Run git pull in your clone instead."
    exit 0
fi
rm -rf "$DEST"
mkdir -p "$DEST"
for f in desklet.js metadata.json settings-schema.json stylesheet.css README.md LICENSE; do
    cp "$SRC/$f" "$DEST/"
done
echo "Installed to $DEST"

# Ask Cinnamon to reload the desklet if it's already on the desktop.
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
        /org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
        string:"$UUID" string:'DESKLET' 2>/dev/null || true
fi
echo "Add it from: right-click desktop > Add Desklets > monday.com My Work. Then right-click it > Configure to enter your API token."
