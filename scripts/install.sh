#!/bin/sh
# Install the EnrichedLab terminal command for this person on macOS or Linux. No sudo; nothing outside the home folder.
#
#   curl -fsSL https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest/download/install.sh | sh
#   sh install.sh --from <folder>       install binaries you built (dist/bin)
#
# The binary goes to ~/.el/bin/el, linked as ~/.local/bin/el. `el update` keeps it current.

set -eu

from="https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest/download"
while [ $# -gt 0 ]; do
	case "$1" in
		--from) from="$2"; shift 2 ;;
		*) echo "el install: unknown option $1" >&2; exit 2 ;;
	esac
done

case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) echo "el install: on Windows, run EnrichedLab-Setup-x64.exe from the release page" >&2; exit 1 ;;
esac
case "$(uname -m)" in
	arm64|aarch64) arch=arm64 ;;
	x86_64|amd64) arch=x64 ;;
	*) echo "el install: no build for $(uname -m)" >&2; exit 1 ;;
esac
name="el-$os-$arch"

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
[ -f "$src/$name" ] || { echo "el install: $name not found in $from" >&2; exit 1; }
[ -f "$src/SHA256SUMS" ] || { echo "el install: no SHA256SUMS in $from" >&2; exit 1; }
want=$(grep " $name\$" "$src/SHA256SUMS" | cut -d' ' -f1)
if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$src/$name" | cut -d' ' -f1); else got=$(sha256sum "$src/$name" | cut -d' ' -f1); fi
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "el install: checksum mismatch for $name" >&2; exit 1; }

home="$HOME/.el"
bin="$home/bin"
mkdir -p "$bin" "$HOME/.local/bin"
chmod 700 "$home"
cp "$src/$name" "$bin/el.new"
chmod 755 "$bin/el.new"
mv "$bin/el.new" "$bin/el"
link="$HOME/.local/bin/el"
if [ -e "$link" ] && [ ! -L "$link" ]; then
	echo "el install: $link exists and isn't a link; leaving it. Run $bin/el directly." >&2
else
	ln -sf "$bin/el" "$link"
fi
# Releases before 0.2 named the command "enriched": move its folder and drop its link.
if [ -d "$HOME/.enriched" ] && [ ! -e "$home/config.json" ]; then
	echo "Your settings in ~/.enriched move to ~/.el the first time el runs."
fi
old="$HOME/.local/bin/enriched"
if [ -L "$old" ] && case "$(readlink "$old")" in */.enriched/bin/*) true ;; *) false ;; esac; then rm -f "$old"; fi
echo "Installed EnrichedLab $("$bin/el" --version 2>/dev/null)."
case ":$PATH:" in
	*":$HOME/.local/bin:"*) echo "Run: el" ;;
	*) echo "Add ~/.local/bin to your PATH (for zsh: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile), then run: el" ;;
esac
