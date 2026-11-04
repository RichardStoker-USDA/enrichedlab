#!/bin/sh
# Install the EnrichedLab terminal command for this person on macOS or Linux. No sudo; nothing outside the home folder.
#
#   curl -fsSL https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest/download/install.sh | sh
#   sh install.sh --from <folder>       install binaries you built (dist/bin)
#
# The binary goes to ~/.enriched/bin/enriched, linked as ~/.local/bin/enriched. `enriched update` keeps it current.

set -eu

from="https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest/download"
while [ $# -gt 0 ]; do
	case "$1" in
		--from) from="$2"; shift 2 ;;
		*) echo "enriched install: unknown option $1" >&2; exit 2 ;;
	esac
done

case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) echo "enriched install: on Windows, run EnrichedLab-Setup-x64.exe from the release page" >&2; exit 1 ;;
esac
case "$(uname -m)" in
	arm64|aarch64) arch=arm64 ;;
	x86_64|amd64) arch=x64 ;;
	*) echo "enriched install: no build for $(uname -m)" >&2; exit 1 ;;
esac
name="enriched-$os-$arch"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
case "$from" in
	https://*)
		# HTTPS for the first request and every redirect.
		curl -fsSL --proto '=https' --proto-redir '=https' "$from/$name" -o "$tmp/$name"
		curl -fsSL --proto '=https' --proto-redir '=https' "$from/SHA256SUMS" -o "$tmp/SHA256SUMS"
		src="$tmp" ;;
	*) src="$from" ;;
esac
[ -f "$src/$name" ] || { echo "enriched install: $name not found in $from" >&2; exit 1; }
[ -f "$src/SHA256SUMS" ] || { echo "enriched install: no SHA256SUMS in $from" >&2; exit 1; }
want=$(grep " $name\$" "$src/SHA256SUMS" | cut -d' ' -f1)
if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$src/$name" | cut -d' ' -f1); else got=$(sha256sum "$src/$name" | cut -d' ' -f1); fi
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "enriched install: checksum mismatch for $name" >&2; exit 1; }

home="$HOME/.enriched"
bin="$home/bin"
mkdir -p "$bin" "$HOME/.local/bin"
chmod 700 "$home"
cp "$src/$name" "$bin/enriched.new"
chmod 755 "$bin/enriched.new"
mv "$bin/enriched.new" "$bin/enriched"
link="$HOME/.local/bin/enriched"
if [ -e "$link" ] && [ ! -L "$link" ]; then
	echo "enriched install: $link exists and isn't a link; leaving it. Run $bin/enriched directly." >&2
else
	ln -sf "$bin/enriched" "$link"
fi
echo "Installed EnrichedLab $("$bin/enriched" --version 2>/dev/null)."
case ":$PATH:" in
	*":$HOME/.local/bin:"*) echo "Run: enriched" ;;
	*) echo "Add ~/.local/bin to your PATH (for zsh: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile), then run: enriched" ;;
esac
